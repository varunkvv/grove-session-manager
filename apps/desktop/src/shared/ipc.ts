// the contract between the main process and the renderer. types only, plus the channel lists
// the preload uses as its allowlist. nothing here may import node or electron.
import type {
  BranchSpec,
  ComboRelation,
  FolderMode,
  FolderOutcome,
  FolderState,
  LiveStatus,
  LongWorkMode,
  ModelUsage,
  SessionAgent,
  TeardownOutcome,
  TitleSource,
} from "@grove/core/pure";

export type { SessionAgent };

export type Outcome<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; detail?: string } };

/** the transcript path. unique by construction - titles and even session ids are not. */
export type SessionKey = string;

export interface SessionRow {
  key: SessionKey;
  sessionId: string;
  title?: string;
  titleSource?: TitleSource;
  firstPrompt?: string;
  lastPrompt?: string;
  /** full path. tooltips only, never shown on a row. */
  cwd?: string;
  cwdBase?: string;
  projectLabel: string;
  gitBranch?: string;
  comboName?: string;
  comboRelation?: ComboRelation;
  tag?: string;
  prNumber?: number;
  prRepo?: string;
  entrypoint?: string;
  activityMs: number;
  parsed: boolean;
  /** tokens per model, subagents included, biggest first. absent until the whole file is counted. */
  usage?: ModelUsage[];
  /** what the session is doing right now, when its hooks report to us */
  live?: LiveStatus;
  /** its subagents, running ones first. every session, live or long finished. */
  agents?: SessionAgent[];
  /** put away on purpose: out of the list and out of search unless it is asking for someone */
  archived?: boolean;
}

/**
 * what an agent's own transcript says about it, beyond what the scan of every session knows. read
 * when someone looks, not for every row: it means folding the whole transcript.
 */
export interface AgentStats {
  id: string;
  toolCount: number;
  /** the context its last response ran with - how Claude Code itself counts an agent's tokens */
  tokens: number;
  model?: string;
  /** its first and last timestamps. file times lie once a file is copied. */
  startedAt?: number;
  lastAt?: number;
  /** the first sentence of what it came back with */
  outcome?: string;
  /** the start of what it was asked, for an agent nobody gave a label (a workflow's) */
  asked?: string;
  /** the last tool it called: what it is doing, when there is no summary line */
  lastStep?: string;
  /** the api error it died on */
  error?: string;
  interrupted?: boolean;
  /** the agent that started it, when another agent did */
  parentId?: string;
  /** Claude Code has deleted its transcript */
  gone?: boolean;
}

export interface SessionInspection {
  key: SessionKey;
  agents: Record<string, AgentStats>;
  /** by run: the directory name under subagents/workflows/ */
  workflows: Record<string, { name?: string; summary?: string }>;
}

/**
 * one step of an agent's timeline, as the inspector draws it: what a line needs and nothing more.
 * a tool's full input and result stay on disk until someone opens the step.
 */
export type DetailStep =
  | {
      kind: "tool";
      /** where it sits in the fold. stable while the agent keeps writing: steps are only added. */
      n: number;
      /** the tool_use id: what opening the step asks for */
      id: string;
      name: string;
      target: string;
      at: number;
      /** absent while the tool is still running */
      durationMs?: number;
      /** "exit 1", "rejected", "error" - only on a failed step */
      failure?: string;
      /** the advisor: it runs on the api side and has nothing to open */
      server?: boolean;
      /** the agent an Agent call started, when its transcript is here */
      agentId?: string;
    }
  | { kind: "text" | "thinking"; n: number; text: string; at: number }
  | { kind: "message"; n: number; text: string; at: number; interrupted?: boolean };

/** everything the detail view shows of one agent, built in main from its folded transcript */
export interface AgentDetail {
  key: SessionKey;
  id: string;
  prompt?: string;
  /** every text block of its final message, or a workflow journal's result. markdown, untrusted. */
  result?: string;
  model?: string;
  tokens: number;
  toolCount: number;
  startedAt?: number;
  lastAt?: number;
  error?: string;
  interrupted?: boolean;
  steps: DetailStep[];
}

/**
 * what changed in the agent on screen since the last push. every step at or past fold index `from`
 * is replaced by `steps`; the rest of the detail comes whole, less the prompt, which never moves.
 */
export interface AgentSteps {
  key: SessionKey;
  id: string;
  /** which follow this belongs to. a push from an earlier one is dropped. */
  gen: number;
  from: number;
  steps: DetailStep[];
  head: Omit<AgentDetail, "key" | "id" | "steps" | "prompt">;
}

/** one tool call opened: the whole input, and the whole result up to a cap */
export interface StepDetail {
  input: string;
  result?: string;
  isError?: boolean;
  /** cut at the cap */
  truncated: boolean;
}

/** a folder people keep coming back to: repos their sessions ran in, and folders already in combos */
export interface FrequentFolder {
  path: string;
  name: string;
  lastUsedMs: number;
}

/** a row the instant filter could not find, found in its conversation instead */
export interface SearchHit {
  key: SessionKey;
  /** the part of the conversation that matched. `in Explore: …` when an agent's words did. */
  snippet: string;
  /** the match is in this agent's transcript, not in the session's own */
  agent?: string;
  /** every agent of the session whose own words hold the whole query, with the part that did */
  agents?: Array<{ id: string; snippet: string }>;
}

export type FolderViewState = FolderState | "unknown";

export interface FolderView {
  path: string;
  mode: FolderMode;
  dirName: string;
  branchSpec?: BranchSpec;
  state: FolderViewState;
  /** short branch name, or "detached @abc1234" */
  branchLabel?: string;
  locked?: boolean;
  dirty?: boolean;
  message?: string;
  busy?: "creating" | "removing" | "checking";
}

export interface ComboView {
  name: string;
  root: string;
  note?: string;
  workspaceFile: string;
  /** whether long autonomous work is handed to a background agent. can be flipped mid-session. */
  longWork: LongWorkMode;
  folders: FolderView[];
  /** 'unknown' until the first reconcile lands, so the rail never flashes drift it has not checked */
  status: "unknown" | "checking" | "known";
  checkedAt?: number;
}

export interface FolderDraft {
  path: string;
  mode: FolderMode;
  branch?: BranchSpec;
  as?: string;
}

export interface ComboDraft {
  name: string;
  note?: string;
  folders: FolderDraft[];
}

export interface PathInfoView {
  path: string;
  exists: boolean;
  isGitRepo: boolean;
  canBeWorktree: boolean;
  currentBranch?: string;
  head?: string;
  branches: Array<{ name: string; checkedOutAt?: string }>;
  suggestedDirName: string;
}

export interface EditorStatus {
  id: "vscode" | "cursor";
  label: string;
  bin: string;
  binFound: boolean;
  companionVersion: string | null;
  bundledCompanionVersion: string | null;
  companionState: "ok" | "missing" | "outdated" | "unavailable";
  claudeExtensionInstalled: boolean;
}

export interface AppSettings {
  editor: "vscode" | "cursor";
  appearance: "system" | "light" | "dark";
  editorBin?: string;
  extensionsDir?: string;
  gitPath?: string;
  claudePath?: string;
  claudeConfigDir?: string;
  maxParsedSessions?: number;
  /** status hooks in Claude Code's user settings, so sessions outside combos report too */
  trackAllSessions?: boolean;
  /** a macOS notification when a session starts needing you. on unless switched off. */
  notifications?: boolean;
  /** one line per running subagent, written by a cheap model. on unless switched off. */
  agentSummaries?: boolean;
}

export interface IndexStatus {
  phase: "cache" | "scanning" | "idle" | "degraded" | "error";
  done: number;
  total: number;
  message?: string;
}

export interface EnvInfo {
  appRoot: string;
  projectsDir: string;
  home: string;
  platform: string;
  isDev: boolean;
}

export interface Bootstrap {
  revs: { sessions: number; combos: number };
  env: EnvInfo;
  settings: AppSettings;
  editor: EditorStatus;
  combos: ComboView[];
  combosProblem?: string;
  sessions: SessionRow[];
  index: IndexStatus;
}

export type SessionActionId =
  | "combo-land"
  | "folder-land"
  | "terminal"
  | "copy-command"
  | "copy-id"
  | "reveal"
  | "mark-seen"
  | "archive"
  | "unarchive"
  | "inspect";

export interface SessionAction {
  id: SessionActionId;
  label: string;
  hint?: string;
  /** the shortcut that does the same thing, shown right-aligned. only where one exists. */
  keys?: string;
  enabled: boolean;
  /** drawn after a separator */
  secondary?: boolean;
}

export interface OpenReport {
  launched: boolean;
  landing: boolean;
  outcomes: FolderOutcome[];
  warnings: string[];
}

/** request/response. every call resolves quickly or reports progress through the push events below. */
export interface Api {
  bootstrap(): Promise<Bootstrap>;
  rescan(): Promise<Outcome>;

  sessionActions(key: SessionKey): Promise<SessionAction[]>;
  /** the whole conversation, for rows the instant filter over titles and prompts missed */
  searchSessions(query: string): Promise<{ query: string; hits: SearchHit[] }>;
  /** what each of a session's agents did, from their own transcripts. null for an unknown row. */
  inspectSession(key: SessionKey): Promise<SessionInspection | null>;
  /**
   * the agent on screen, and everything it did so far. from here until the next call, what it
   * writes arrives as `agent:steps`. null stops that.
   */
  followAgent(
    key: SessionKey,
    agentId: string | null,
    /** a search that led here: `found` is the fold index of the step that matched it best */
    find?: string,
  ): Promise<{ gen: number; detail: AgentDetail; found?: number } | null>;
  /** one step opened: read back from the two transcript lines it points at */
  agentStep(key: SessionKey, agentId: string, stepId: string): Promise<StepDetail | null>;
  /** a link in an agent's output. only http(s), and only ever in the browser. */
  openExternal(url: string): Promise<Outcome>;
  /** takes sessions out of "needs you" until their next event */
  markSeen(keys: SessionKey[]): Promise<void>;
  /** puts sessions away, or brings them back. writes the decision to ~/claude-ws/archived.json. */
  archiveSessions(keys: SessionKey[], archived: boolean): Promise<Outcome>;
  runSessionAction(
    key: SessionKey,
    action: SessionActionId,
  ): Promise<Outcome<{ message?: string }>>;

  validateComboName(
    name: string,
    self?: string,
  ): Promise<{ slug: string; root: string; problem?: string }>;
  validateDraft(draft: ComboDraft, self?: string): Promise<{ problems: string[] }>;
  pickDirectories(): Promise<string[]>;
  /** most used first. one click adds one to a combo, no file picker. */
  frequentFolders(): Promise<FrequentFolder[]>;
  inspectPath(path: string): Promise<PathInfoView>;
  createCombo(draft: ComboDraft): Promise<Outcome<{ name: string }>>;
  updateCombo(name: string, draft: ComboDraft): Promise<Outcome<{ name: string }>>;
  /** runs a non-force teardown first and refuses while worktrees remain. trashing the root is opt-in. */
  deleteCombo(name: string, trashRoot: boolean): Promise<Outcome<{ remaining: TeardownOutcome[] }>>;

  reconcile(name?: string, withDirty?: boolean): Promise<Outcome>;
  ensureCombo(name: string): Promise<Outcome<FolderOutcome[]>>;
  repairFolder(name: string, folderPath: string): Promise<Outcome<FolderOutcome[]>>;
  repairCombo(name: string): Promise<Outcome<FolderOutcome[]>>;
  /** never forces. dirty worktrees come back as skipped. */
  teardownCombo(name: string): Promise<Outcome<TeardownOutcome[]>>;
  /** force exists only here: one folder, one explicit call */
  forceRemoveFolder(name: string, folderPath: string): Promise<Outcome<TeardownOutcome>>;
  openCombo(name: string, sessionKey?: SessionKey): Promise<Outcome<OpenReport>>;
  /** rewrites the combo's long-work policy file, which a running session reads before long work */
  setLongWork(name: string, mode: LongWorkMode): Promise<Outcome>;

  editorStatus(refresh?: boolean): Promise<EditorStatus>;
  installCompanion(): Promise<Outcome>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<Outcome<AppSettings>>;

  reveal(
    target:
      | { kind: "session"; key: SessionKey }
      | { kind: "agent"; key: SessionKey; agentId: string }
      | { kind: "combo"; name: string }
      | { kind: "folder"; name: string; folderPath: string },
  ): Promise<Outcome>;
  copyText(text: string): Promise<Outcome>;
  reportCspViolation(detail: string): Promise<void>;
}

export const INVOKE_CHANNELS = [
  "bootstrap",
  "rescan",
  "sessionActions",
  "searchSessions",
  "inspectSession",
  "agentStep",
  "followAgent",
  "openExternal",
  "markSeen",
  "archiveSessions",
  "runSessionAction",
  "validateComboName",
  "validateDraft",
  "pickDirectories",
  "frequentFolders",
  "inspectPath",
  "createCombo",
  "updateCombo",
  "deleteCombo",
  "reconcile",
  "ensureCombo",
  "repairFolder",
  "repairCombo",
  "teardownCombo",
  "forceRemoveFolder",
  "openCombo",
  "setLongWork",
  "editorStatus",
  "installCompanion",
  "getSettings",
  "updateSettings",
  "reveal",
  "copyText",
  "reportCspViolation",
] as const satisfies ReadonlyArray<keyof Api>;

export type MenuCommandId =
  | "new-combo"
  | "open-combo"
  | "edit-combo"
  | "repair-combo"
  | "refresh"
  | "focus-search"
  | "scope-combo"
  | "scope-all"
  | "scope-agents"
  | "inspect"
  | "settings";

export interface ToastMessage {
  level: "info" | "error";
  title: string;
  body?: string;
  detail?: string;
}

/** main -> renderer. `rev` is monotonic per domain, so an event older than the bootstrap snapshot is dropped. */
export interface PushEvents {
  "sessions:patch": {
    rev: number;
    upserts: SessionRow[];
    removes: SessionKey[];
    replace?: boolean;
  };
  "sessions:index": IndexStatus;
  "combos:changed": { rev: number; combos: ComboView[]; problem?: string };
  "combos:folders": {
    rev: number;
    name: string;
    status: ComboView["status"];
    checkedAt?: number;
    folders: FolderView[];
  };
  "editor:status": EditorStatus;
  "menu:command": { id: MenuCommandId };
  toast: ToastMessage;
  "agent:steps": AgentSteps;
}

export const PUSH_CHANNELS = [
  "sessions:patch",
  "sessions:index",
  "combos:changed",
  "combos:folders",
  "editor:status",
  "menu:command",
  "toast",
  "agent:steps",
] as const satisfies ReadonlyArray<keyof PushEvents>;

export interface Bridge extends Api {
  on<K extends keyof PushEvents>(
    channel: K,
    listener: (payload: PushEvents[K]) => void,
  ): () => void;
}

declare global {
  interface Window {
    grove: Bridge;
  }
}
