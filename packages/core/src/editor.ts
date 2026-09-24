import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isObject } from "./fsx.ts";
import { isValidSessionId } from "./sessions/resume.ts";
import type { Settings } from "./settings.ts";
import { err, ok, type Result } from "./types.ts";

export const COMPANION_EXTENSION_ID = "varunkvv.grove-companion";
export const CLAUDE_EXTENSION_ID = "anthropic.claude-code";

export interface EditorTarget {
  id: "vscode" | "cursor";
  label: string;
  /** absolute path. a GUI app launched from Finder does not inherit the shell PATH. */
  bin: string;
  uriScheme: string;
  extensionsDir: string;
}

const HOME = os.homedir();

export const EDITOR_PRESETS: Record<EditorTarget["id"], EditorTarget> = {
  vscode: {
    id: "vscode",
    label: "VS Code",
    bin: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    uriScheme: "vscode",
    extensionsDir: path.join(HOME, ".vscode", "extensions"),
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    bin: "/Applications/Cursor.app/Contents/Resources/app/bin/code",
    uriScheme: "cursor",
    extensionsDir: path.join(HOME, ".cursor", "extensions"),
  },
};

export function resolveEditor(
  settings: Pick<Settings, "editor" | "editorBin" | "extensionsDir">,
  env: NodeJS.ProcessEnv = process.env,
): EditorTarget {
  const preset = EDITOR_PRESETS[settings.editor] ?? EDITOR_PRESETS.vscode;
  return {
    ...preset,
    // env overrides exist for tests: they record the launch instead of opening a window
    bin: env.GROVE_EDITOR_BIN || settings.editorBin || preset.bin,
    extensionsDir: env.GROVE_EXTENSIONS_DIR || settings.extensionsDir || preset.extensionsDir,
  };
}

/**
 * an environment fit to hand to another program. the editor's launcher script branches on these,
 * and inherited from Electron they break it. a claude started from the app must not boot as node
 * either.
 */
export function stripLaunchEnv(from: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...from };
  for (const key of Object.keys(env)) {
    if (key === "ELECTRON_RUN_AS_NODE" || key === "NODE_OPTIONS" || key.startsWith("VSCODE_"))
      delete env[key];
  }
  return env;
}

function launchEnv(): NodeJS.ProcessEnv {
  return stripLaunchEnv(process.env);
}

/** fire and forget, but a missing binary comes back as a value instead of an unhandled error */
export function runDetached(
  bin: string,
  args: string[],
): Promise<Result<{ bin: string; args: string[] }>> {
  return new Promise((resolve) => {
    if (!path.isAbsolute(bin))
      return resolve(err("not-absolute", `${bin} is not an absolute path`));
    if (!existsSync(bin)) return resolve(err("editor-missing", `${bin} does not exist`));
    try {
      const child = spawn(bin, args, { detached: true, stdio: "ignore", env: launchEnv() });
      child.once("error", (e) => resolve(err("spawn-failed", String(e))));
      child.once("spawn", () => {
        child.unref();
        resolve(ok({ bin, args }));
      });
    } catch (e) {
      resolve(err("spawn-failed", String(e)));
    }
  });
}

/** opens a folder or a .code-workspace file. `code <path>` returns straight away: there is no "opened" signal. */
export function openInEditor(
  target: string,
  editor: EditorTarget,
): Promise<Result<{ bin: string; args: string[] }>> {
  return runDetached(editor.bin, [target]);
}

export function buildSessionUri(uriScheme: string, sessionId: string, prompt?: string): string {
  if (!isValidSessionId(sessionId)) throw new Error("not a session id");
  const params = new URLSearchParams({ session: sessionId });
  if (prompt) params.set("prompt", prompt);
  return `${uriScheme}://${CLAUDE_EXTENSION_ID}/open?${params.toString()}`;
}

/** reads the editor's own registry. `--list-extensions` would start an Electron process for this. */
export async function installedExtensionVersion(
  editor: EditorTarget,
  extensionId: string,
): Promise<string | null> {
  const id = extensionId.toLowerCase();
  try {
    const raw: unknown = JSON.parse(
      await readFile(path.join(editor.extensionsDir, "extensions.json"), "utf8"),
    );
    let obsolete: Record<string, unknown> = {};
    try {
      const o: unknown = JSON.parse(
        await readFile(path.join(editor.extensionsDir, ".obsolete"), "utf8"),
      );
      if (isObject(o)) obsolete = o;
    } catch {
      // usually absent
    }
    if (!Array.isArray(raw)) return null;
    const versions: string[] = [];
    for (const e of raw) {
      if (!isObject(e) || !isObject(e.identifier)) continue;
      if (String(e.identifier.id).toLowerCase() !== id) continue;
      if (typeof e.relativeLocation === "string" && obsolete[e.relativeLocation]) continue;
      versions.push(typeof e.version === "string" ? e.version : "0.0.0");
    }
    return versions.sort().pop() ?? null;
  } catch {
    return null;
  }
}

export function installExtensionArgs(vsixPath: string): string[] {
  return ["--install-extension", vsixPath, "--force"];
}
