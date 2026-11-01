import path from "node:path";
import { isObject, readJsonGuarded, stringifyLike, writeFileAtomic } from "./fsx.ts";
import { isTextScale, type TextScale } from "./textScale.ts";
import type { UsageMode } from "./usageLimits.ts";

/** shared by the app and the extension. a GUI app launched from Finder sees no shell env, so this is a file. */
export type Appearance = "system" | "light" | "dark";
/** the colours: grove's own, or one of two built-in palettes. each has a light and a dark half */
export type Palette = "grove" | "rose-pine" | "solarized";

export interface Settings {
  editor: "vscode" | "cursor" | "zed";
  /** follows macOS unless it is pinned. "system" is the default. */
  appearance: Appearance;
  /** absent is grove */
  palette?: Palette;
  /** Text size: the conversation's text, in percent. one of TEXT_SCALES, absent is 100 */
  textScale?: TextScale;
  /** absolute path to the editor's CLI. overrides the preset. */
  editorBin?: string;
  extensionsDir?: string;
  gitPath?: string;
  claudePath?: string;
  claudeConfigDir?: string;
  maxParsedSessions?: number;
  /** status hooks in Claude Code's user settings, so sessions outside combos report too. off by default. */
  trackAllSessions?: boolean;
  /** a notification when a session starts needing you. on unless false. */
  notifications?: boolean;
  /** recaps, titles and descriptions of sessions, written by haiku through the person's own `claude -p`. on unless false. */
  recaps?: boolean;
  /** grove's titles go to Claude Code through a hook, as `/rename` would. on unless false. */
  renameSessions?: boolean;
  /** no idle sleep, of the mac or its display, while an agent is mid-turn. on unless false. */
  keepAwake?: boolean;
  /** grove chat (beta): a session opens in its own grove window, run through the agent sdk. off unless true. */
  chat?: boolean;
  /** with grove chat on, the key that brings grove forward from anywhere. "none" is none */
  summonKey?: string;
  /** grove chat keeps a session's prompt cache warm for this many hours after its last turn. absent is 3, 0 is off */
  keepWarmHours?: number;
  /** what the Usage screen shows, as last picked there. absent: the account's own numbers when it is billed by use */
  usageMode?: UsageMode;
}

export const DEFAULT_SETTINGS: Settings = { editor: "vscode", appearance: "system" };

export function settingsFilePath(appRoot: string): string {
  return path.join(appRoot, "settings.json");
}

function clean(raw: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (!isObject(raw)) return s;
  if (raw.editor === "cursor" || raw.editor === "vscode" || raw.editor === "zed") {
    s.editor = raw.editor;
  }
  if (raw.appearance === "light" || raw.appearance === "dark" || raw.appearance === "system") {
    s.appearance = raw.appearance;
  }
  if (raw.palette === "grove" || raw.palette === "rose-pine" || raw.palette === "solarized") {
    s.palette = raw.palette;
  }
  // 100 is the default: as absent, so a file that says it reads the same as one that does not
  if (isTextScale(raw.textScale) && raw.textScale !== 100) s.textScale = raw.textScale;
  for (const key of [
    "editorBin",
    "extensionsDir",
    "gitPath",
    "claudePath",
    "claudeConfigDir",
  ] as const) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) s[key] = v.trim();
  }
  for (const key of [
    "trackAllSessions",
    "notifications",
    "recaps",
    "renameSessions",
    "keepAwake",
    "chat",
  ] as const) {
    if (typeof raw[key] === "boolean") s[key] = raw[key];
  }
  if (typeof raw.summonKey === "string" && raw.summonKey.trim() && raw.summonKey.length <= 64) {
    s.summonKey = raw.summonKey.trim();
  }
  if (
    typeof raw.keepWarmHours === "number" &&
    Number.isFinite(raw.keepWarmHours) &&
    raw.keepWarmHours >= 0 &&
    raw.keepWarmHours <= 24
  ) {
    s.keepWarmHours = raw.keepWarmHours;
  }
  if (raw.usageMode === "api-equivalent" || raw.usageMode === "actual") {
    s.usageMode = raw.usageMode;
  }
  if (typeof raw.maxParsedSessions === "number" && raw.maxParsedSessions > 0) {
    s.maxParsedSessions = Math.floor(raw.maxParsedSessions);
  }
  return s;
}

export async function loadSettings(appRoot: string): Promise<Settings> {
  const read = await readJsonGuarded(settingsFilePath(appRoot));
  return clean(read.status === "ok" ? read.value : undefined);
}

export async function saveSettings(appRoot: string, patch: Partial<Settings>): Promise<Settings> {
  const file = settingsFilePath(appRoot);
  const read = await readJsonGuarded(file);
  if (read.status === "invalid")
    throw new Error(`settings.json is not valid JSON: ${read.message}`);
  const raw = read.status === "ok" && isObject(read.value) ? read.value : {};
  const merged: Record<string, unknown> = { ...raw, ...patch };
  for (const [k, v] of Object.entries(merged)) if (v === undefined || v === "") delete merged[k];
  await writeFileAtomic(file, stringifyLike(merged, read.status === "ok" ? read.text : undefined));
  return clean(merged);
}
