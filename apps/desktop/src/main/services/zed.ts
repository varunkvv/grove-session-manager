// zed has no extension api, so grove's part in zed is one entry in its settings.json: the acp
// proxy, registered as a custom agent server. the file is the person's own, comments and all.
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type EditorTarget,
  isObject,
  readJsoncTolerant,
  realpathLoose,
  writeFileAtomic,
  ZED_AGENT_ID,
} from "@grove/core";
import { applyEdits, modify } from "jsonc-parser";
import { AppError } from "../errors.ts";

export interface ZedAgentEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** the editor's extensionsDir is, for zed, the folder its settings.json lives in */
export function zedSettingsFile(editor: Pick<EditorTarget, "extensionsDir">): string {
  return path.join(editor.extensionsDir, "settings.json");
}

/** the proxy zed runs as grove's agent, or null when there is no such entry */
export async function registeredZedProxy(file: string): Promise<string | null> {
  const read = await readJsoncTolerant(file);
  if (read.status !== "ok" || !isObject(read.value)) return null;
  const servers = read.value.agent_servers;
  const entry = isObject(servers) ? servers[ZED_AGENT_ID] : undefined;
  if (!isObject(entry) || !Array.isArray(entry.args)) return null;
  return typeof entry.args[0] === "string" ? entry.args[0] : null;
}

/** grove's entry, set. every other byte of the text stays as it was */
export function upsertZedAgentServer(text: string, entry: ZedAgentEntry): string {
  const base = text.trim() ? text : "{}\n";
  const edits = modify(
    base,
    ["agent_servers", ZED_AGENT_ID],
    { type: "custom", ...entry },
    { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } },
  );
  return applyEdits(base, edits);
}

export async function writeZedAgentServer(file: string, entry: ZedAgentEntry): Promise<void> {
  const read = await readJsoncTolerant(file);
  if (read.status === "invalid") {
    throw new AppError(
      "zed-settings-invalid",
      "Zed's settings.json is not valid JSON, so Grove did not touch it.",
    );
  }
  // a settings.json linked in from a dotfiles repo stays a link
  const target = realpathLoose(file);
  // zed keeps it private (0600) and it can hold api keys, so it stays as private as it was
  const mode = await stat(target).then(
    (s) => s.mode & 0o777,
    () => 0o600,
  );
  await writeFileAtomic(
    target,
    upsertZedAgentServer(read.status === "ok" ? read.text : "", entry),
    mode,
  );
}
