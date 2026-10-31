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
  id: "vscode" | "cursor" | "zed";
  label: string;
  /** absolute path. a GUI app launched from Finder does not inherit the shell PATH. */
  bin: string;
  uriScheme: string;
  /** vs code and cursor: where extensions.json lives. zed: where its settings.json lives. */
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
  zed: {
    id: "zed",
    label: "Zed",
    bin: "/Applications/Zed.app/Contents/MacOS/cli",
    uriScheme: "zed",
    extensionsDir: path.join(HOME, ".config", "zed"),
  },
};

/**
 * grove's entry under `agent_servers` in zed's settings.json: the acp proxy that lands a thread.
 * zed has no name field for a custom agent, so this key is also what its agent menu says
 */
export const ZED_AGENT_ID = "Claude (with Grove)";

/**
 * focuses zed's agent panel in its active window and starts a new thread there with the agent
 * zed last used. with grove's, that thread is the one the proxy lands on the session
 */
export const ZED_AGENT_LINK = "zed://agent";
/**
 * how long after `cli -n` the link waits, so that the new window is the active one. the cli was
 * back in about a second on 2026-10-15. sent with the folders in one call, zed drops the folders
 */
export const ZED_AGENT_LINK_DELAY_MS = 3000;

/** where zed installs claude code's acp adapter from its agent registry */
export function zedAdapterPath(home: string = HOME): string {
  return path.join(
    home,
    "Library/Application Support/Zed/external_agents/registry/npx/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
  );
}

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

/**
 * fire and forget, but a missing binary comes back as a value instead of an unhandled error. the
 * app's own environment unless given another, and never what electron leaves in either
 */
export function runDetached(
  bin: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<Result<{ bin: string; args: string[] }>> {
  return new Promise((resolve) => {
    if (!path.isAbsolute(bin))
      return resolve(err("not-absolute", `${bin} is not an absolute path`));
    if (!existsSync(bin)) return resolve(err("editor-missing", `${bin} does not exist`));
    try {
      const child = spawn(bin, args, {
        detached: true,
        stdio: "ignore",
        env: env ? stripLaunchEnv(env) : launchEnv(),
      });
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

export interface LaunchTarget {
  workspaceFile?: string;
  /** the window's roots, the cwd first */
  folders: string[];
}

/**
 * vs code and cursor open the .code-workspace file, or the folder. zed has no workspace file:
 * `-n` opens one new window with every root, and its agent takes the first as its cwd.
 */
export function editorLaunchArgs(editor: EditorTarget, target: LaunchTarget): string[] {
  if (editor.id === "zed") return ["-n", ...target.folders];
  return [target.workspaceFile ?? target.folders[0]!];
}

/**
 * `code <path>` returns straight away: there is no "opened" signal. `env` is what the editor
 * starts with, when it is not the app's own
 */
export function openInEditor(
  editor: EditorTarget,
  target: LaunchTarget,
  env?: NodeJS.ProcessEnv,
): Promise<Result<{ bin: string; args: string[] }>> {
  return runDetached(editor.bin, editorLaunchArgs(editor, target), env);
}

/**
 * a file in its project's window. vs code and cursor: the folder, then `--goto` the file, so it
 * lands in the window that has the folder (or opens one). zed: the folder and the file, no `-n`
 */
export function editorFileArgs(editor: EditorTarget, folder: string, file: string): string[] {
  return editor.id === "zed" ? [folder, file] : [folder, "--goto", file];
}

export function openFileInEditor(
  editor: EditorTarget,
  folder: string,
  file: string,
  env?: NodeJS.ProcessEnv,
): Promise<Result<{ bin: string; args: string[] }>> {
  return runDetached(editor.bin, editorFileArgs(editor, folder, file), env);
}

export function buildSessionUri(uriScheme: string, sessionId: string, prompt?: string): string {
  if (!isValidSessionId(sessionId)) throw new Error("not a session id");
  const params = new URLSearchParams({ session: sessionId });
  if (prompt) params.set("prompt", prompt);
  return `${uriScheme}://${CLAUDE_EXTENSION_ID}/open?${params.toString()}`;
}

/**
 * the same deep link without a session: the Claude extension hands `primaryEditor.open` an
 * undefined id, which is a new conversation with the prompt waiting in its input box
 */
export function buildNewConversationUri(uriScheme: string, prompt?: string): string {
  const query = prompt ? `?${new URLSearchParams({ prompt }).toString()}` : "";
  return `${uriScheme}://${CLAUDE_EXTENSION_ID}/open${query}`;
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
