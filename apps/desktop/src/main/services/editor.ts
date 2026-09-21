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
} from "@grove/core";
import type { EditorStatus } from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";

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
  private cached: EditorStatus | null = null;

  constructor(settings: Settings, bundleDirs: readonly string[]) {
    this.target = resolveEditor(settings);
    this.bundleDirs = bundleDirs;
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

  /** landing on a session needs the companion. without it the editor still opens, just not on the session. */
  async companionInstalled(): Promise<boolean> {
    return (await this.status()).companionVersion !== null;
  }

  async installCompanion(): Promise<void> {
    if (!this.bundled) this.bundled = await findBundledCompanion(this.bundleDirs);
    if (!this.bundled) {
      throw new AppError(
        "no-vsix",
        "The extension was not found next to the app. Run `pnpm ext:package`.",
      );
    }
    if (!existsSync(this.target.bin)) {
      throw new AppError(
        "editor-missing",
        `${this.target.label} was not found at ${this.target.bin}.`,
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
