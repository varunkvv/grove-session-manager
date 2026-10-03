// the contract between the main process and the renderer. types only, plus the channel lists
// the preload uses as its allowlist. nothing here may import node or electron.
import type {
  AgentRef,
  AgentState,
  BranchSpec,
  CardDisplayStatus,
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
import type { CardStatus, ConclusionKind } from "@grove/record/types";

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

/** the start-up self-check of a project's record server, run through the real launcher */
export type ServerCheck =
  | { state: "unknown" }
  | { state: "ok"; checkedAt: number; ms: number; tools: number }
  | {
      state: "failed";
      checkedAt: number;
      stage: "config" | "spawn" | "initialize" | "tools/list" | "record_state";
      message: string;
      detail?: string;
    };

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

// what the page gets: the project manager's views, built in main.

export interface ProjectView {
  /** basename(root). a rename never changes it */
  id: ProjectId;
  name: string;
  root: string;
  /** combo.note */
  goal?: string;
  prefix: string;
  workspaceFile: string;
  longWork: LongWorkMode;
  folders: FolderView[];
  /** the folder reconcile, as ComboView's */
  status: "unknown" | "checking" | "known";
  checkedAt?: number;
  /** the root folder is there. no start buttons when it is not */
  rootExists: boolean;
  server: ServerCheck;
  /** working copies whose own .mcp.json declares a server called grove */
  shadowed: string[];
  /** a file grove could not write, from the sync's warnings */
  syncProblem?: string;
  /** agents started from grove that have not claimed a card yet */
  starting: PendingStart[];
}

export interface PendingStart {
  id: string;
  where: "editor" | "background";
  cardId?: string;
  at: number;
}

export interface CardHead {
  id: string;
  title: string;
  status: CardDisplayStatus;
  at: number;
  lastActivity: number;
  /** the holder only */
  agent?: { ref: AgentRef; runtime: Runtime; state: AgentState; stateAt?: number };
  /** changes whenever anything on the card does. the card page re-fetches on a change */
  version: string;
  problems: number;
}

export interface ConclusionView {
  id: string;
  kind: ConclusionKind;
  what: string;
  why: string;
  by: "agent" | "person";
  /** the session that recorded it. for by: person, the agent whose chat it was said in */
  who?: AgentRef;
  card?: { id: string; title?: string };
  replaces?: string;
  replacedBy: string[];
  superseded: boolean;
  related: string[];
  changesPlan: boolean;
  area?: string;
  at: number;
  /** it would enter the inbox: by an agent, a decision or verdict, or a finding that changes the plan */
  needsReview: boolean;
  reviewed: boolean;
  sessionKey?: SessionKey;
  open?: OpenPlan;
  problems: number;
}

/** a record file that did not parse whole, relative to the project root */
export interface RecordProblem {
  file: string;
  problems: string[];
}

export interface ProjectRecordView {
  cards: CardHead[];
  conclusions: ConclusionView[];
  problems: RecordProblem[];
  /** absent until the first read finished */
  readAt?: number;
}

export interface InboxRowView {
  /** InboxRow.id */
  id: string;
  project: ProjectId;
  projectName: string;
  kind: InboxKind;
  at: number;
  card?: { id: string; title: string };
  conclusionId?: string;
  title: string;
  who?: AgentRef;
  /** where `who` runs now */
  runtime?: Runtime;
  summary: string;
  reviewKeys: string[];
  sessionKey?: SessionKey;
  open?: OpenPlan;
}

export interface InboxView {
  /** every project, Asked and Stopped first, then newest first. the page filters by project */
  rows: InboxRowView[];
  /** trayCount over all rows */
  tray: number;
}

export interface CardView {
  project: ProjectId;
  id: string;
  title: string;
  /** markdown, untrusted */
  body: string;
  status: CardDisplayStatus;
  /** the record's own status. the card page's role keys on it with agent.holding */
  recordStatus: CardStatus;
  /** the holder, else the last agent that wrote a claim event */
  agent?: AgentPanel;
  /** oldest first */
  thread: ThreadItem[];
  artifacts: ArtifactView[];
  /** the card's own links. no reverse links */
  from?: string;
  needs: string[];
  /** the ones naming this card, newest first */
  conclusions: ConclusionView[];
  problems: RecordProblem[];
  version: string;
}

export interface AgentPanel {
  ref: AgentRef;
  /** absent until grove indexes the transcript */
  sessionKey?: SessionKey;
  runtime: Runtime;
  /** modelLabel of the session's own model: "opus 5.5" */
  model?: string;
  state: AgentState;
  stateAt?: number;
  subagents: SubagentView[];
  open: OpenPlan;
  /** false when this is the last agent of a card nobody holds (done, canceled, released) */
  holding: boolean;
}

export interface SubagentView {
  id: string;
  /** SessionAgent.agentType */
  type: string;
  /** description ?? asked ?? type */
  label: string;
  state: "running" | "done";
  lastActivityAt: number;
  lastTool?: string;
}

export type ThreadItem =
  | {
      kind: "comment" | "question" | "answer";
      seq: number;
      at: number;
      who: AgentRef | "person";
      /** markdown, untrusted */
      text: string;
      /** a question's: "person" or a card id */
      to?: string;
      /** a question's */
      open?: boolean;
      /** a question's */
      answeredBy?: number[];
      /** an answer's */
      answers?: number;
      artifacts: ArtifactView[];
    }
  | {
      kind: "event";
      seq: number;
      at: number;
      who: AgentRef | "person";
      event: "claim" | "release" | "takeover" | "done" | "cancel" | string;
      /** the done summary, the cancel reason, the release note. may be empty */
      text: string;
    };

export interface ArtifactView {
  type: "file" | "branch" | "pr" | "link";
  ref: string;
  at: number;
  who?: AgentRef | "person";
}

/** one session found from the palette */
export interface SessionHit {
  key: SessionKey;
  sessionId: string;
  /** row.title ?? the first prompt squashed ?? "Untitled session" */
  title: string;
  project?: ProjectId;
  /** the project name, else row.projectLabel */
  where: string;
  activityMs: number;
  runtime: Runtime;
  live?: LiveState;
  /** only for a full-text match */
  snippet?: string;
  open: OpenPlan;
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
  cardId?: string;
  /** background only: run it in Terminal, where the CLI's trust prompt is answered once */
  throughTerminal?: boolean;
}

/** where a notification click, a tray row or a palette row takes the page */
export type LandingTarget =
  | { view: "inbox"; project?: ProjectId; rowId?: string }
  | { view: "card"; project: ProjectId; cardId: string; back: "inbox" | "cards" }
  | { view: "conclusions"; project: ProjectId; conclusionId?: string };

/** was ComboDraft */
export interface ProjectDraft {
  name: string;
  /** the goal */
  note?: string;
  /** create only. ignored on update */
  prefix?: string;
  folders: FolderDraft[];
}

/** where the page goes when a notification, a tray row or a palette row asked for it */
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
  | "go-cards"
  | "go-conclusions"
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
  revs: { projects: number; record: number; inbox: number };
  env: EnvInfo;
  settings: AppSettings;
  editor: EditorStatus;
  projects: ProjectView[];
  projectsProblem?: string;
  record: Record<ProjectId, ProjectRecordView>;
  inbox: InboxView;
}

/** request/response. every call resolves quickly or reports progress through the push events below. */
export interface Api {
  bootstrap(): Promise<Bootstrap>;
  /** Cmd-R: rescan sessions, reload combos.json, run the record backstop, sync every project, rerun its self-check */
  refresh(): Promise<Outcome>;

  /** a card with its thread. null for an unknown project or card */
  card(project: ProjectId, cardId: string): Promise<CardView | null>;
  /** marks, a seen session, or an open question answered as the person. at most 2,000 keys */
  review(project: ProjectId, keys: string[], reviewed: boolean): Promise<Outcome>;

  openSession(key: SessionKey): Promise<Outcome<{ message?: string }>>;
  startAgent(req: StartAgentRequest): Promise<Outcome<{ message: string; body?: string }>>;
  findSessions(query: string): Promise<SessionHit[]>;

  /** a landing the page has not taken yet. taken once. */
  takeLanding(): Promise<Landing | null>;
  /** the project on screen in the main window, or null. notifications for it wait while the window is focused */
  setVisibleProject(id: ProjectId | null): Promise<void>;

  validateProjectName(
    name: string,
    self?: ProjectId,
    prefix?: string,
  ): Promise<{
    slug: string;
    root: string;
    prefix: string;
    problem?: string;
    prefixProblem?: string;
  }>;
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
  /** a file artifact, in Finder. the path is relative to the project root */
  reveal(project: ProjectId, path: string): Promise<Outcome>;
  copyText(text: string): Promise<Outcome>;
  /** a link in an agent's output. only http(s), and only ever in the browser. */
  openExternal(url: string): Promise<Outcome>;
  reportCspViolation(detail: string): Promise<void>;
}

export const INVOKE_CHANNELS = [
  "bootstrap",
  "refresh",
  "card",
  "review",
  "openSession",
  "startAgent",
  "findSessions",
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
  "reveal",
  "copyText",
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
  /** `cards` holds only the heads that changed, or every one with `replace`. `conclusions` is whole */
  "record:changed": {
    rev: number;
    project: ProjectId;
    cards?: CardHead[];
    removedCards?: string[];
    replace?: boolean;
    conclusions?: ConclusionView[];
    problems?: RecordProblem[];
    readAt?: number;
  };
  "inbox:changed": InboxView & { rev: number };
  "editor:status": EditorStatus;
  "menu:command": { id: MenuCommandId };
  toast: ToastMessage;
  /** somewhere to land: `takeLanding` says where */
  "app:land": Record<string, never>;
}

export const PUSH_CHANNELS = [
  "projects:changed",
  "projects:folders",
  "record:changed",
  "inbox:changed",
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
