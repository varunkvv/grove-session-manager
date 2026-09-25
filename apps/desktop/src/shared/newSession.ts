// what a new session can be started with. the lists are the only values main passes to claude as
// flags, so they live where both sides read the same ones. nothing here may import node or electron.
import type { LongWorkMode } from "@grove/core/pure";

/** the editor (VS Code or Cursor), a Terminal window, or Claude Code's own supervisor */
export type NewSessionWhere = "editor" | "terminal" | "background";

/** `claude --model` aliases, as the CLI lists them. Default passes nothing. */
export const MODELS = [
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
] as const;

/**
 * `claude --permission-mode`. manual and dontAsk are left out: rare, and confusing next to these.
 * Default passes nothing, so the combo's own settings decide.
 */
export const PERMISSION_MODES = [
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
  { value: "bypassPermissions", label: "Bypass permissions" },
] as const;

/** `claude --effort` */
export const EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
] as const;

export type ModelChoice = (typeof MODELS)[number]["value"];
export type PermissionModeChoice = (typeof PERMISSION_MODES)[number]["value"];
export type EffortChoice = (typeof EFFORTS)[number]["value"];

export interface NewSessionRequest {
  combo: string;
  where: NewSessionWhere;
  /** background: required, sent. terminal: optional, sent. editor: optional, never sent. */
  prompt: string;
  /** where long work goes for this session only. absent: whatever the combo says. */
  longWork?: LongWorkMode;
  /** the CLI targets only. the Claude panel picks its own model and mode. */
  model?: ModelChoice;
  mode?: PermissionModeChoice;
  effort?: EffortChoice;
  name?: string;
  /** background only: the same command in Terminal, where the CLI's one-time trust prompt is answered */
  throughTerminal?: boolean;
}

export interface NewSessionResult {
  /** the short id `claude attach` takes, when it went to the background */
  id?: string;
  message: string;
  body?: string;
}
