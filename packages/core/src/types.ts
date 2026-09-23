import type { ModelUsage } from "./transcript/usage.ts";

export interface Warning {
  code: string;
  message: string;
}

export type Result<T> =
  | { ok: true; value: T; warnings: Warning[] }
  | { ok: false; error: { code: string; message: string; detail?: unknown } };

export function ok<T>(value: T, warnings: Warning[] = []): Result<T> {
  return { ok: true, value, warnings };
}

export function err<T = never>(code: string, message: string, detail?: unknown): Result<T> {
  return { ok: false, error: { code, message, detail } };
}

export type TitleSource =
  | "customTitle"
  | "agentName"
  | "aiTitle"
  | "summary"
  | "firstPrompt"
  | "lastPrompt"
  | "firstCommand";

export interface PrLink {
  number: number;
  url?: string;
  repo?: string;
}

/** everything lifted out of a transcript. every field is optional on purpose - the format is internal. */
export interface ParsedMeta {
  sessionId?: string;
  cwd?: string;
  relocatedCwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  createdAt?: number;
  lastActivityMs?: number;
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  summary?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  firstCommand?: string;
  tag?: string;
  pr?: PrLink;
  /** a teleported-from marker with no conversation. listed by the index, hidden by default in UIs. */
  stub?: boolean;
  /** complete lines that parsed as JSON objects. 0 means the shape moved or the file is junk. */
  recognized: number;
}

export interface SessionRecord extends ParsedMeta {
  /** transcript path. this is the row identity - titles and even session ids are not unique enough. */
  path: string;
  projectDirName: string;
  /** falls back to the filename stem, which always equals the session id in practice */
  sessionId: string;
  mtimeMs: number;
  size: number;
  /** false when the file was listed but not parsed (over the cap, or the read failed) */
  parsed: boolean;
  title?: string;
  titleSource?: TitleSource;
  /** last user/assistant timestamp, else mtime. sort and "2d ago" use this. */
  activityMs: number;
  /** tokens per model, subagents included, biggest first. absent until the usage pass reaches it. */
  usage?: ModelUsage[];
}

export type ComboRelation = "root" | "inside";

export interface SessionView extends SessionRecord {
  comboName?: string;
  comboRelation?: ComboRelation;
}

export type BranchSpec =
  | { kind: "detach" }
  | { kind: "new"; name: string; base?: string }
  | { kind: "existing"; name: string };

export type FolderMode = "worktree" | "reference";

export interface ComboFolder {
  path: string;
  mode: FolderMode;
  branch?: BranchSpec;
  as?: string;
  [extra: string]: unknown;
}

/** where long autonomous work runs: handed to a background agent, or done in the conversation */
export type LongWorkMode = "background" | "foreground";

export interface Combo {
  name: string;
  root: string;
  note?: string;
  /** absent means background */
  longWork?: LongWorkMode;
  folders: ComboFolder[];
  [extra: string]: unknown;
}

export type FolderState = "ok" | "reference" | "absent" | "stale" | "foreign" | "missing-origin";

export interface FolderStatus {
  folder: ComboFolder;
  /** where the folder lives: the worktree dir under the root, or the reference path itself */
  target: string;
  state: FolderState;
  branch?: string;
  detached?: boolean;
  head?: string;
  locked?: boolean;
  dirty?: boolean;
  message?: string;
}

export type CreateAction =
  | "created"
  | "attached"
  | "exists"
  | "recreated"
  | "collision"
  | "refused-foreign"
  | "missing-origin"
  | "invalid-branch"
  | "stale"
  | "failed"
  | "not-applicable";

export interface GitTrace {
  args: string[];
  exitCode: number | null;
  stderr: string;
}

export interface FolderOutcome {
  folder: ComboFolder;
  target: string;
  action: CreateAction;
  state: FolderState;
  message?: string;
  /** worktree path that holds the branch we wanted */
  heldBy?: string;
  git?: GitTrace;
}

export type TeardownAction =
  | "removed"
  | "skipped-dirty"
  | "skipped-locked"
  | "untouched"
  | "failed";

export interface TeardownOutcome {
  folder: ComboFolder;
  target: string;
  action: TeardownAction;
  message?: string;
  dirtyPaths?: string[];
  git?: GitTrace;
}

export interface Disposable {
  dispose(): void;
}

/** what a live session is doing, from its hooks. "waiting" means its turn ended and it is your move. */
export type LiveState = "running" | "permission" | "waiting" | "failed";

/** exact times for one subagent, from the SubagentStart / SubagentStop hooks */
export interface AgentRun {
  agentType?: string;
  startedAt?: number;
  stoppedAt?: number;
}

/**
 * one subagent of a session, as far as anything on disk can say. there is no progress signal in
 * Claude Code - no percentage, no step count - so this is what it did last and when.
 */
export interface SessionAgent {
  /** the `<id>` of `subagents/agent-<id>.jsonl` */
  id: string;
  agentType: string;
  /** the label the parent gave it when it spawned it. the best single thing to show. */
  description?: string;
  /** the start of what it was asked, for an agent nobody labelled - a workflow's are not */
  asked?: string;
  /** "foreground" | "background". a background agent outlives the turn that started it. */
  requestShape?: string;
  spawnDepth?: number;
  /** the Agent call that started it, in the session's transcript or in another agent's */
  toolUseId?: string;
  /** the workflow run it ran in: its directory under `subagents/workflows/` */
  workflow?: string;
  startedAt: number;
  /** the agent transcript's mtime */
  lastActivityAt: number;
  lastTool?: string;
  lastToolAt?: number;
  state: "running" | "done";
  /** one line from a cheap model reading the agent's own transcript: what it is doing right now */
  summary?: string;
  summaryAt?: number;
  /** once it has finished and someone looked: what it found or did, in one line. asked once. */
  found?: string;
}

export interface LiveStatus {
  state: LiveState;
  /** when it entered this state */
  at: number;
  /** the last event of any kind, subagents included. a running session with none for long is stale. */
  lastEventAt: number;
  /** when the current turn started, for "finished after 12m" */
  turnStart?: number;
  turnMs?: number;
  /** the tool asking for permission, or the notification's text */
  detail?: string;
  /** someone already looked. a new event clears it. */
  seen?: boolean;
  /** the live session registry guessed this, no hook did. re-derived on every pass, never stored. */
  source?: "registry";
}
