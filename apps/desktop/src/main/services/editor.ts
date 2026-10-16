import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  CLAUDE_EXTENSION_ID,
  COMPANION_EXTENSION_ID,
  type EditorTarget,
  installExtensionArgs,
  installedExtensionVersion,
  isObject,
  resolveEditor,
  type Settings,
  samePath,
  zedAdapterPath,
} from "@grove/core";
import type { EditorStatus } from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";
import { registeredZedAgent, writeZedAgentServer, zedSettingsFile } from "./zed.ts";

const INSTALL_TIMEOUT_MS = 60_000;

export interface BundledCompanion {
  vsix: string;
  version: string;
}

/** compares 1.2.10 against 1.2.9 by number, not by string */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** packaged: next to the app's resources. in a checkout: whatever `pnpm ext:package` last built. */
export async function findBundledCompanion(
  dirs: readonly string[],
): Promise<BundledCompanion | null> {
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const vsix = names.find((n) => n.endsWith(".vsix"));
    if (!vsix) continue;
    let version = "0.0.0";
    try {
      const manifest: unknown = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
      if (isObject(manifest) && typeof manifest.version === "string") version = manifest.version;
    } catch {
      // no manifest: still installable, just never reported as outdated
    }
    return { vsix: path.join(dir, vsix), version };
  }
  return null;
}

export class EditorService {
  private target: EditorTarget;
  private bundled: BundledCompanion | null = null;
  private readonly bundleDirs: readonly string[];
  /** zed's agent: the built acp proxy, and the app root it lands sessions from */
  private readonly proxyFile: string | null;
  private readonly appRoot: string;
  /** what runs the proxy in zed: this app's own binary, as node. zed's PATH may have no node */
  private readonly executable: string;
  private cached: EditorStatus | null = null;

  constructor(
    settings: Settings,
    bundleDirs: readonly string[],
    proxyFile: string | null,
    appRoot: string,
    executable: string,
  ) {
    this.target = resolveEditor(settings);
    this.bundleDirs = bundleDirs;
    this.proxyFile = proxyFile;
    this.appRoot = appRoot;
    this.executable = executable;
  }

  current(): EditorTarget {
    return this.target;
  }

  applySettings(settings: Settings): void {
    this.target = resolveEditor(settings);
    this.cached = null;
  }

  async status(refresh = false): Promise<EditorStatus> {
    if (this.cached && !refresh) return this.cached;
    if (this.target.id === "zed") {
      this.cached = await this.zedStatus();
      return this.cached;
    }
    if (!this.bundled || refresh) this.bundled = await findBundledCompanion(this.bundleDirs);
    const companionVersion = await installedExtensionVersion(this.target, COMPANION_EXTENSION_ID);
    const claude = await installedExtensionVersion(this.target, CLAUDE_EXTENSION_ID);
    const bundledVersion = this.bundled?.version ?? null;
    this.cached = {
      id: this.target.id,
      label: this.target.label,
      bin: this.target.bin,
      binFound: existsSync(this.target.bin),
      companionVersion,
      bundledCompanionVersion: bundledVersion,
      companionState: !this.bundled
        ? companionVersion
          ? "ok"
          : "unavailable"
        : !companionVersion
          ? "missing"
          : compareVersions(companionVersion, this.bundled.version) < 0
            ? "outdated"
            : "ok",
      claudeExtensionInstalled: claude !== null,
    };
    return this.cached;
  }

  /**
   * zed's "companion" is grove's entry in its settings.json, and its version is the proxy that
   * entry runs. ok is the proxy next to this app, run by this app's binary. anything else (a moved
   * checkout, an older app, 0.18.30's bare `node`) is out of date
   */
  private async zedStatus(): Promise<EditorStatus> {
    const registered = await registeredZedAgent(zedSettingsFile(this.target));
    return {
      id: this.target.id,
      label: this.target.label,
      bin: this.target.bin,
      binFound: existsSync(this.target.bin),
      companionVersion: registered?.proxy ?? null,
      bundledCompanionVersion: this.proxyFile,
      companionState: !this.proxyFile
        ? "unavailable"
        : !registered
          ? "missing"
          : samePath(registered.proxy, this.proxyFile) &&
              samePath(registered.command, this.executable)
            ? "ok"
            : "outdated",
      claudeExtensionInstalled: existsSync(zedAdapterPath()),
    };
  }

  /** landing on a session needs the companion. without it the editor still opens, just not on the session. */
  async companionInstalled(): Promise<boolean> {
    return (await this.status()).companionVersion !== null;
  }

  async installCompanion(): Promise<void> {
    if (!existsSync(this.target.bin)) {
      throw new AppError(
        "editor-missing",
        `${this.target.label} was not found at ${this.target.bin}.`,
      );
    }
    if (this.target.id === "zed") {
      if (!this.proxyFile) {
        throw new AppError(
          "no-proxy",
          "The Grove agent was not found next to the app. Run `pnpm app:build`.",
        );
      }
      await writeZedAgentServer(zedSettingsFile(this.target), {
        // the person's node may not be on zed's PATH, or may be broken. electron runs as node
        // with ELECTRON_RUN_AS_NODE, and the proxy keeps that from reaching claude's tools
        command: this.executable,
        args: [this.proxyFile],
        // zed's environment does not carry the app's
        env: { ELECTRON_RUN_AS_NODE: "1", GROVE_ROOT: this.appRoot },
      });
      this.cached = null;
      return;
    }
    if (!this.bundled) this.bundled = await findBundledCompanion(this.bundleDirs);
    if (!this.bundled) {
      throw new AppError(
        "no-vsix",
        "The extension was not found next to the app. Run `pnpm ext:package`.",
      );
    }
    const args = installExtensionArgs(this.bundled.vsix);
    await new Promise<void>((resolve, reject) => {
      execFile(this.target.bin, args, { timeout: INSTALL_TIMEOUT_MS }, (error, stdout, stderr) => {
        if (!error) return resolve();
        log.error("install extension:", stderr || stdout || error.message);
        reject(
          new AppError(
            "install-failed",
            "The editor could not install the extension.",
            stderr || error.message,
          ),
        );
      });
    });
    this.cached = null;
  }
}
