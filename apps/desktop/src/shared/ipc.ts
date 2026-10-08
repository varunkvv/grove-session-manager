// the contract between the main process and the renderer. types only, plus the channel lists
// the preload uses as its allowlist. nothing here may import node or electron.
import type {
  BranchSpec,
  ComboRelation,
  FolderMode,
  FolderOutcome,
  FolderState,
  InboxKind,
  LiveState,
  LiveStatus,
  LongWorkMode,
  ModelUsage,
  ProjectId,
  Runtime,
  SessionAgent,
  TeardownOutcome,
  TitleSource,
} from "@grove/core/pure";

export type { ProjectId };

export type Outcome<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; detail?: string } };

/** the transcript path. unique by construction - titles and even session ids are not. */
export type SessionKey = string;

/** what Claude Code's supervisor says about a session it runs in the background (`claude --bg`) */
export interface BackgroundView {
  /** the short id `claude attach` and `claude stop` take */
  id?: string;
  /** `working` | `blocked` | `done` | `failed` | `stopped` */
  state?: string;
  /** the supervisor holds a live worker for it, so a resume anywhere else is refused */
  held: boolean;
  /** what a blocked one waits on: `permission prompt`, `input needed`, ... */
  waitingFor?: string;
}

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
  /** the model the session itself ran on most, its subagents left out */
  model?: string;
  /** what the session is doing right now, when its hooks report to us */
  live?: LiveStatus;
  /** its subagents, running ones first. every session, live or long finished. */
  agents?: SessionAgent[];
  /** Claude Code's supervisor knows it: running in the background now, or once and not removed */
  background?: BackgroundView;
  /**
   * it stopped mid-turn without finishing: its process went away while it was running (a window
   * closed on it, a crash, a reboot), or the supervisor says its background run failed
   */
  interrupted?: { why: "gone" | "failed"; at?: number };
}

/** a folder people keep coming back to: repos their sessions ran in, and folders already in combos */
export interface FrequentFolder {
  path: string;
  name: string;
  lastUsedMs: number;
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

export interface FolderDraft {
  path: string;
  mode: FolderMode;
  branch?: BranchSpec;
  as?: string;
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

export interface EnvInfo {
  appRoot: string;
  projectsDir: string;
  home: string;
  platform: string;
  isDev: boolean;
}

export interface OpenReport {
  launched: boolean;
  landing: boolean;
  outcomes: FolderOutcome[];
  warnings: string[];
}

// what the page gets: views built in main.

export interface ProjectView {
  /** basename(root). a rename never changes it */
  id: ProjectId;
  name: string;
  root: string;
  /** combo.note */
  goal?: string;
  workspaceFile: string;
  longWork: LongWorkMode;
  folders: FolderView[];
  /** the folder reconcile, as ComboView's */
  status: "unknown" | "checking" | "known";
  checkedAt?: number;
  /** the root folder is there. no start buttons when it is not */
  rootExists: boolean;
  /** a file grove could not write, from the sync's warnings */
  syncProblem?: string;
}

/** a session as every list names it, and what opening it takes */
export interface SessionRef {
  key: SessionKey;
  /** what names it in a list, the panel and a landing. one row per id, the newest transcript's */
  sessionId: string;
  /** row.title ?? the first prompt squashed ?? "Untitled session" */
  title: string;
  /** the project name, else row.projectLabel */
  where: string;
  runtime: Runtime;
  branch?: string;
  open: OpenPlan;
}

/** one session in a project's list, or found from the palette */
export interface SessionHit extends SessionRef {
  project?: ProjectId;
  activityMs: number;
  live?: LiveState;
  /** its first and last prompts, cut: what a sessions list's filter also looks in */
  prompt?: string;
  /** only for a full-text match */
  snippet?: string;
}

/** a session that needs the person: InboxRow joined with the session it is about */
export interface InboxRowView extends SessionRef {
  project: ProjectId;
  kind: InboxKind;
  at: number;
  summary: string;
  /** what Dismiss sends to `review` */
  reviewKeys: string[];
}

export interface InboxView {
  /** every project's rows, newest first. the tray counts them all */
  rows: InboxRowView[];
}

/** the end of a session's transcript, read when its panel opens. both are untrusted text */
export interface SessionTail {
  /** the newest thing the person typed, cut at 4,000 characters */
  prompt?: string;
  /** what the agent said last, after that. markdown, the last 20,000 characters */
  text?: string;
}

/** what Open in {editor} needs to know before it is pressed. one label for every case */
export interface OpenPlan {
  /** asked first: stopping a background agent that is working */
  confirm?: { title: string; body: string; label: string };
  /** the button is disabled, with this as its hint */
  disabled?: string;
}

export interface StartAgentRequest {
  project: ProjectId;
  where: "editor" | "background";
  /** background only: run it in Terminal, where the CLI's trust prompt is answered once */
  throughTerminal?: boolean;
}

/**
 * where a notification click or a tray row takes the page: a session, with its panel open. main
 * says which list it is in
 */
export type LandingTarget =
  | { view: "inbox"; session?: string }
  | { view: "sessions"; project: ProjectId; session: string };

/** was ComboDraft */
export interface ProjectDraft {
  name: string;
  /** the goal */
  note?: string;
  folders: FolderDraft[];
}

/** where the page goes when a notification or a tray row asked for it */
export interface Landing {
  target: LandingTarget;
  /** when it was asked for: a second click on the same thing lands again */
  at: number;
}

export type MenuCommandId =
  | "new-project"
  | "open-project"
  | "edit-project"
  | "go-inbox"
  | "go-sessions"
  | "palette"
  | "focus-search"
  | "refresh"
  | "settings";

export interface ToastMessage {
  level: "info" | "error";
  title: string;
  body?: string;
  detail?: string;
}

export interface Bootstrap {
  revs: { projects: number; inbox: number };
  env: EnvInfo;
  settings: AppSettings;
  editor: EditorStatus;
  projects: ProjectView[];
  projectsProblem?: string;
  inbox: InboxView;
}

/** request/response. every call resolves quickly or reports progress through the push events below. */
export interface Api {
  bootstrap(): Promise<Bootstrap>;
  /** Cmd-R: rescan sessions, reload combos.json, sync every project and look at its working copies again */
  refresh(): Promise<Outcome>;

  /** Dismiss: a row's keys. a stop is marked, a status that needs the person is seen. at most 2,000 keys */
  review(project: ProjectId, keys: string[], reviewed: boolean): Promise<Outcome>;

  openSession(key: SessionKey): Promise<Outcome<{ message?: string }>>;
  startAgent(req: StartAgentRequest): Promise<Outcome<{ message: string; body?: string }>>;
  findSessions(query: string): Promise<SessionHit[]>;
  /** every session a project lists, newest first. asked again on `sessions:changed` */
  projectSessions(project: ProjectId): Promise<SessionHit[]>;
  /** a bounded read of the transcript's end, now. null for a session grove does not list */
  sessionTail(key: SessionKey): Promise<SessionTail | null>;

  /** a landing the page has not taken yet. taken once. */
  takeLanding(): Promise<Landing | null>;
  /**
   * what the main window shows: a project, or with `all` the inbox, which is every project's.
   * notifications for what is on screen wait while the window is focused
   */
  setVisibleProject(id: ProjectId | null, all?: boolean): Promise<void>;

  validateProjectName(
    name: string,
    self?: ProjectId,
  ): Promise<{ slug: string; root: string; problem?: string }>;
  validateProjectDraft(draft: ProjectDraft, self?: ProjectId): Promise<{ problems: string[] }>;
  pickDirectories(): Promise<string[]>;
  /** most used first. one click adds one to a project, no file picker. */
  frequentFolders(): Promise<FrequentFolder[]>;
  inspectPath(path: string): Promise<PathInfoView>;
  createProject(draft: ProjectDraft): Promise<Outcome<{ id: ProjectId }>>;
  updateProject(id: ProjectId, draft: ProjectDraft): Promise<Outcome<{ id: ProjectId }>>;
  /** runs a non-force teardown first and refuses while worktrees remain. trashing the root is opt-in */
  deleteProject(
    id: ProjectId,
    trashRoot: boolean,
  ): Promise<Outcome<{ remaining: TeardownOutcome[] }>>;
  /** every working copy of the project */
  repairProject(id: ProjectId): Promise<Outcome<FolderOutcome[]>>;
  /** the project's window in the editor, without landing on a session */
  openProject(id: ProjectId): Promise<Outcome<OpenReport>>;
  /** rewrites the project's long-work policy file, which a running session reads before long work */
  setLongWork(id: ProjectId, mode: LongWorkMode): Promise<Outcome>;

  editorStatus(refresh?: boolean): Promise<EditorStatus>;
  installCompanion(): Promise<Outcome>;
  updateSettings(patch: Partial<AppSettings>): Promise<Outcome<AppSettings>>;
  /** a link in an agent's output. only http(s), and only ever in the browser. */
  openExternal(url: string): Promise<Outcome>;
  reportCspViolation(detail: string): Promise<void>;
}

export const INVOKE_CHANNELS = [
  "bootstrap",
  "refresh",
  "review",
  "openSession",
  "startAgent",
  "findSessions",
  "projectSessions",
  "sessionTail",
  "takeLanding",
  "setVisibleProject",
  "validateProjectName",
  "validateProjectDraft",
  "pickDirectories",
  "frequentFolders",
  "inspectPath",
  "createProject",
  "updateProject",
  "deleteProject",
  "repairProject",
  "openProject",
  "setLongWork",
  "editorStatus",
  "installCompanion",
  "updateSettings",
  "openExternal",
  "reportCspViolation",
] as const satisfies ReadonlyArray<keyof Api>;

/** main -> renderer. `rev` is monotonic per domain, so an event older than the bootstrap snapshot is dropped. */
export interface PushEvents {
  "projects:changed": { rev: number; projects: ProjectView[]; problem?: string };
  "projects:folders": {
    rev: number;
    id: ProjectId;
    status: ProjectView["status"];
    checkedAt?: number;
    folders: FolderView[];
  };
  "inbox:changed": InboxView & { rev: number };
  /** what a project's sessions list shows moved: `projectSessions` has the new list */
  "sessions:changed": Record<string, never>;
  "editor:status": EditorStatus;
  "menu:command": { id: MenuCommandId };
  toast: ToastMessage;
  /** somewhere to land: `takeLanding` says where */
  "app:land": Record<string, never>;
}

export const PUSH_CHANNELS = [
  "projects:changed",
  "projects:folders",
  "inbox:changed",
  "sessions:changed",
  "editor:status",
  "menu:command",
  "toast",
  "app:land",
] as const satisfies ReadonlyArray<keyof PushEvents>;

// a method or an event left out of its list typechecks on both sides and is undefined in the page
type MissingInvoke = Exclude<keyof Api, (typeof INVOKE_CHANNELS)[number]>;
type MissingPush = Exclude<keyof PushEvents, (typeof PUSH_CHANNELS)[number]>;
export const CHANNELS_COMPLETE: [MissingInvoke, MissingPush] extends [never, never] ? true : never =
  true;

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
