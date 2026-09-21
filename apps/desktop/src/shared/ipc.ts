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
  TeardownOutcome,
  TitleSource,
} from "@grove/core/pure";

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
  /** the part of the conversation that matched */
  snippet: string;
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
  | "mark-seen";

export interface SessionAction {
  id: SessionActionId;
  label: string;
  hint?: string;
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
  /** takes sessions out of "needs you" until their next event */
  markSeen(keys: SessionKey[]): Promise<void>;
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
  "markSeen",
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
}

export const PUSH_CHANNELS = [
  "sessions:patch",
  "sessions:index",
  "combos:changed",
  "combos:folders",
  "editor:status",
  "menu:command",
  "toast",
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
