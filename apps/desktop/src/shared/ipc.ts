// the contract between the main process and the renderer. types only, plus the channel lists
// the preload uses as its allowlist. nothing here may import node or electron.
import type {
  BranchSpec,
  ComboRelation,
  ConversationView,
  FolderMode,
  FolderOutcome,
  FolderState,
  InboxKind,
  LiveState,
  LiveStatus,
  LongWorkMode,
  ModelUsage,
  ProjectId,
  Recap,
  Runtime,
  SessionAgent,
  SessionTasks,
  TeardownOutcome,
  TitleSource,
  TurnView,
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
  /** grove's title for it, unless the person named it themselves. else Claude Code's */
  title?: string;
  /** where Claude Code's own title came from. a custom one grove never gave it is the person's */
  titleSource?: TitleSource;
  /** one line on what it is for and how far it reaches, written by grove */
  description?: string;
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
  /** what its last Stop said it left running: background commands, Monitors, wake-ups */
  tasks?: SessionTasks;
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
  id: "vscode" | "cursor" | "zed";
  label: string;
  bin: string;
  binFound: boolean;
  companionVersion: string | null;
  bundledCompanionVersion: string | null;
  companionState: "ok" | "missing" | "outdated" | "unavailable";
  claudeExtensionInstalled: boolean;
}

export interface AppSettings {
  editor: "vscode" | "cursor" | "zed";
  appearance: "system" | "light" | "dark";
  /** the colours. absent is grove */
  palette?: "grove" | "rose-pine" | "solarized";
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
  /** recaps, titles and descriptions, written by haiku through the person's own claude. on unless switched off. */
  recaps?: boolean;
  /** grove's titles go to Claude Code too, through a hook. on unless switched off. */
  renameSessions?: boolean;
  /** the mac and its display do not idle-sleep while an agent is mid-turn. on unless switched off. */
  keepAwake?: boolean;
  /** grove chat (beta): a session opens in its own window, talked to from grove. off unless switched on. */
  chat?: boolean;
  /** with grove chat on, the key that brings grove forward from anywhere. "none", or absent for the default */
  summonKey?: string;
  /** decisioning (beta): a local model judges your own prompts, on this mac. off unless switched on. */
  decisioning?: boolean;
}

/**
 * the summon key when the person has not picked one: ctrl-opt-cmd-G. none of macOS's own, nor
 * Spotlight's, Raycast's or Alfred's defaults, and G for grove
 */
export const DEFAULT_SUMMON_KEY = "Control+Alt+Command+G";

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
  /** put away: under Archived in the sidebar, and its quiet sessions are off the home screen */
  archived?: boolean;
}

/**
 * a session's recap, as a row and the panel draw it. a model wrote the lines from the session's
 * own words: they are plain text, never markdown and never a link
 */
export interface RecapView {
  /** absent until one is written */
  lines?: Recap;
  /** when they were written */
  at?: number;
  /** the conversation has moved on since */
  old?: boolean;
  /** one is being written now */
  writing?: boolean;
}

/** a session as every list names it, and what opening it takes */
export interface SessionRef {
  key: SessionKey;
  /** what names it in a list, the panel and a landing. one row per id, the newest transcript's */
  sessionId: string;
  /** row.title ?? the first prompt squashed ?? "Untitled session" */
  title: string;
  /** what it is for, one line. absent until grove has written one, and while that is switched off */
  description?: string;
  /** the project name, else row.projectLabel */
  where: string;
  runtime: Runtime;
  branch?: string;
  open: OpenPlan;
  /** absent while recaps are off, and until one was asked for */
  recap?: RecapView;
}

/**
 * something a session left running, as a row and the panel draw it: a background command or a
 * Monitor, or a wake-up it scheduled (a cron, a /loop). what it says is untrusted plain text
 */
export interface TaskView {
  id: string;
  kind: "command" | "schedule";
  /** what its tool call named it, or for a wake-up the start of what it will ask */
  description: string;
  /** when grove first saw it. a /loop keeps the time of its first wake-up */
  since: number;
  /** command: the last line it wrote. schedule: `wakes at 14:07`, or `repeats · ` and its cron */
  status?: string;
}

/** one session in a list, or found from the palette */
export interface SessionHit extends SessionRef {
  /** absent for a session in no project */
  project?: ProjectId;
  activityMs: number;
  live?: LiveState;
  /** its first and last prompts, cut: what a sessions list's filter also looks in */
  prompt?: string;
  /** only while it runs: what it was last asked, cut. its hooks name no tool */
  doing?: string;
  /** only while it runs: when this turn started */
  since?: number;
  /** what it left running, when anything: a command counts once it is a minute old */
  tasks?: TaskView[];
  /** only for a full-text match */
  snippet?: string;
}

/** an open chat window, as ⌘K lists it: its session, and what it asks when it needs the person */
export interface ChatWindowView {
  hit: SessionHit;
  row?: InboxRowView;
  /** what grove's own claude for it says, as the window's header does: it waits on the person */
  asking?: true;
  /** and a turn is under way */
  running?: true;
}

/** a session that needs the person: InboxRow joined with the session it is about */
export interface InboxRowView extends SessionRef {
  project: ProjectId;
  kind: InboxKind;
  at: number;
  /** what the recap says the person has to do, once there is one. a permission row keeps its tool */
  summary: string;
  /** what Dismiss sends to `review` */
  reviewKeys: string[];
}

export interface InboxView {
  /** every project's rows, newest first. the tray counts them all */
  rows: InboxRowView[];
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
  /**
   * the background only: what the session should do, as typed. it is its first message, so there
   * has to be one. the editor gets a plain new conversation, and the ask is typed there
   */
  prompt: string;
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

/** tokens by kind: input, output, cache read, cache write kept 5 minutes, cache write kept an hour */
export type UsageTokens = [number, number, number, number, number];

export interface UsageCell {
  tokens: UsageTokens;
  /** USD at API list prices. tokens on a model with no known price add nothing to it */
  cost: number;
  /** agent working time, every agent's added up. not wall clock */
  ms: number;
}

/** one local day that has any usage */
export interface UsageDay {
  /** `YYYY-MM-DD`, by the machine's calendar */
  day: string;
  /** null is every session in no project */
  projects: Array<UsageCell & { project: ProjectId | null }>;
  models: Array<UsageCell & { model: string }>;
  /**
   * the sessions with usage that day, as numbers that name them only within one answer: a range
   * counts a session once however many of its days it worked
   */
  sessions: number[];
  /** the subagents that started that day */
  subagents: number;
  /** the most agents working within the same 5 minutes, subagents counted */
  peak: number;
  /** the longest single turn that reached this day, as working time */
  longest: number;
  /** tokens on models with no known price: counted, and left out of the cost */
  unpriced: number;
}

/**
 * everything the Usage screen draws, for the last 730 days: the oldest day first, and no day that
 * has nothing. sessions whose transcript Claude Code has deleted are still in it
 */
export interface UsageView {
  days: UsageDay[];
  /** how many of the sessions on disk are counted. fewer than `total` only during the first count */
  counted: number;
  total: number;
  /** judgment day odds: only while decisioning is on and its model is ready */
  odds?: OddsView;
}

/** a local day's odds: the ledger from 50 over the day's judged prompts, in time order */
export interface OddsDay {
  day: string;
  odds: number;
  prompts: number;
}

/** a session's ledger: its odds after each judged prompt, from 50. never what was said */
export interface OddsSession {
  key: SessionKey;
  title: string;
  /** null is in no project */
  project: ProjectId | null;
  /** the local day and time of its last judged prompt */
  day: string;
  at: number;
  series: number[];
}

/** what judgment day odds draws from, built in main from the scores grove keeps */
export interface OddsView {
  /** the oldest first, only days with a judged prompt */
  days: OddsDay[];
  sessions: OddsSession[];
  /** the session judged last, and its odds after its latest prompt: what the robot shows */
  current?: { key: SessionKey; odds: number; at: number };
  /** prompts long enough to judge, and how many of them have been */
  prompts: number;
  scored: number;
}

/** decisioning's model and its work, for the Settings row and the Usage screen */
export interface DecisioningStatus {
  /** the setting */
  on: boolean;
  /** macOS 14 or later, and the memory the model asks for */
  supported: boolean;
  /** why not, when it is not: what Settings says in place of the model */
  unsupported?: string;
  model: {
    label: string;
    /** bytes */
    size: number;
    state: "missing" | "downloading" | "ready" | "failed";
    /** bytes on disk so far, while it downloads */
    got?: number;
    /** why the last download or load failed */
    error?: string;
  };
  /** prompts long enough to judge, and how many of them have been */
  prompts: number;
  scored: number;
  /** what holds the backfill back: the mac is on battery */
  waiting?: "battery";
  /** the scorer's last failure (the model would not load, its process died). tried again in a minute */
  stalled?: string;
}

export type MenuCommandId =
  | "new-project"
  /** grove chat on: a new session in the project on screen, in its own window */
  | "new-chat"
  | "open-project"
  | "edit-project"
  | "archive-project"
  | "go-inbox"
  | "go-sessions"
  | "go-usage"
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
  /**
   * grove chat: the session in its own window. one there already comes to the front. `show`: what
   * it opens beside the conversation, a file of the session's or its agents
   */
  openChat(key: SessionKey, show?: ChatShow): Promise<Outcome>;
  /** grove chat: what grove's own claude for this session is doing and waiting on. idle when none */
  sessionHost(key: SessionKey): Promise<ChatStatus | null>;
  /** grove chat: answer what it waits on from the main window's session card */
  sessionAnswer(key: SessionKey, askId: string, answer: ChatAnswer): Promise<Outcome>;
  /** grove chat: a reply from the session card, through the same claude the chat window talks to */
  sessionReply(key: SessionKey, text: string): Promise<Outcome>;
  /** grove chat: a new session in the project, in a window of its own. claude starts on the first key */
  newChat(project: ProjectId): Promise<Outcome>;
  /**
   * grove chat: the open chat windows, the one looked at last first, each with its inbox row when it
   * needs the person. what ⌘K's Windows section lists, in a chat window and in the main one
   */
  chatWindows(): Promise<ChatWindowView[]>;
  /** grove chat: an open chat window to the front. null: the main window, on All sessions */
  showWindow(sessionId: string | null): Promise<void>;
  startAgent(req: StartAgentRequest): Promise<Outcome<{ message: string; body?: string }>>;
  /**
   * sessions found by their own fields, then by what was said in them. the palette asks with no
   * scope: every session, 50. a screen asks with its own, a project's id or null: only rows it
   * lists, up to 200
   */
  findSessions(query: string, scope?: ProjectId | null): Promise<SessionHit[]>;
  /**
   * every session a screen lists, newest first: a project's, or with null every project's and the
   * ones in none. asked again on `sessions:changed`
   */
  // ponytail: the whole list in one answer, and Older is paged in the page. 326 sessions on the
  // machine it was built on. page from here the day one has thousands
  listSessions(scope: ProjectId | null): Promise<SessionHit[]>;
  /**
   * a session's turns, read from its transcript now: the last 100, each text cut. everything in
   * it is untrusted. null when Claude Code has deleted the transcript, or grove does not list it
   */
  sessionConversation(key: SessionKey): Promise<ConversationView | null>;
  /** Write again: a new recap whatever is kept. it arrives with the session's row */
  writeRecap(key: SessionKey): Promise<void>;
  /** rows that came into sight with no description: an older session is named now */
  nameSessions(keys: SessionKey[]): Promise<void>;
  /**
   * the Usage screen's numbers, folded from what the session scan keeps. nothing is read from
   * disk for it. asked when the screen opens and while it is open, never otherwise
   */
  usage(): Promise<UsageView>;
  /** decisioning: the model's state and how far the judging has got */
  decisioningStatus(): Promise<DecisioningStatus>;
  /** fetch the model, or carry on where a download stopped. progress comes as `decisioning:status` */
  downloadModel(): Promise<Outcome>;
  /** the weights off the disk, now. the switch stays as it is */
  deleteModel(): Promise<Outcome>;

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
  /**
   * for getting disk space back: a non-force teardown first, refused while worktrees remain. then
   * the project leaves combos.json and its folder goes to the Trash
   */
  deleteProject(id: ProjectId): Promise<Outcome<{ remaining: TeardownOutcome[] }>>;
  /** `"archived": true` on the project in combos.json, or the key gone. nothing on disk moves */
  setArchived(id: ProjectId, archived: boolean): Promise<Outcome>;
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
  "openChat",
  "sessionHost",
  "sessionAnswer",
  "sessionReply",
  "newChat",
  "chatWindows",
  "showWindow",
  "startAgent",
  "findSessions",
  "listSessions",
  "sessionConversation",
  "writeRecap",
  "nameSessions",
  "usage",
  "decisioningStatus",
  "downloadModel",
  "deleteModel",
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
  "setArchived",
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
  /** what a sessions list shows moved: `listSessions` has the new list */
  "sessions:changed": Record<string, never>;
  "editor:status": EditorStatus;
  /** decisioning's model or its judging moved: a download's progress, a score */
  "decisioning:status": DecisioningStatus;
  "menu:command": { id: MenuCommandId };
  toast: ToastMessage;
  /** somewhere to land: `takeLanding` says where */
  "app:land": Record<string, never>;
  /** a chat window only: it was given a session, or its session moved. `chatTarget` says which */
  "chat:open": Record<string, never>;
  /** a chat window only: its session's host side, whole */
  "chat:status": ChatStatus;
  /** a chat window only: the answer being streamed, from `at` on */
  "chat:text": { at: number; text: string };
  /** a chat window only: the file its viewer shows changed on disk */
  "chat:file": { path: string };
  /** a chat window only: the Appearance or Theme setting moved */
  "chat:appearance": { appearance: AppSettings["appearance"]; palette: AppSettings["palette"] };
  /** a chat window only: open this beside the conversation, as the session card asked */
  "chat:show": ChatShow;
  /** a chat window only: ⌘F was pressed in it. it finds in its own conversation */
  "chat:find": Record<string, never>;
  /** a chat window only: its session as the list has it now (grove named it, it was renamed) */
  "chat:session": SessionHit;
  /** the main window: a session grove runs moved (a state, an ask, a tool). never its tokens */
  "chat:host": { sessionId: string; status: ChatStatus };
}

/**
 * what a chat window opens with when sent there: a file of the session's or its agents beside the
 * conversation (the session card), or words in the composer (a fork's "edit and resend")
 */
export type ChatShow = { file: string } | { agents: true } | { draft: string };

/** a file changed and not committed, in one of the session's repos */
export interface ChatChange {
  path: string;
  /** lines in and out, against the last commit. absent for a binary file */
  added?: number;
  removed?: number;
  /** a file git has never seen */
  fresh?: boolean;
}

/** what a rewind would do, or did: the files it puts back and by how much */
export interface ChatRewind {
  canRewind: boolean;
  error?: string;
  files?: string[];
  insertions?: number;
  deletions?: number;
}

export const PUSH_CHANNELS = [
  "projects:changed",
  "projects:folders",
  "inbox:changed",
  "sessions:changed",
  "editor:status",
  "decisioning:status",
  "menu:command",
  "toast",
  "app:land",
  "chat:open",
  "chat:status",
  "chat:text",
  "chat:file",
  "chat:appearance",
  "chat:show",
  "chat:find",
  "chat:session",
  "chat:host",
] as const satisfies ReadonlyArray<keyof PushEvents>;

// ---------- grove chat: a session grove runs itself, through the agent sdk, in a window of its own

/** Claude Code's permission modes, as the sdk names them */
export type ChatMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk"
  | "auto";

export interface ChatQuestion {
  question: string;
  /** a chip's word for it, 12 characters at most: the tab it sits on */
  header: string;
  /** `preview`: markdown or ascii for a monospace box, shown beside the list when it is focused */
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect: boolean;
}

/** what a session grove runs waits on the person for. all of it is the agent's words: untrusted */
export type ChatAsk =
  | { id: string; kind: "question"; questions: ChatQuestion[] }
  /** ExitPlanMode. the plan is markdown */
  | { id: string; kind: "plan"; plan: string }
  | {
      id: string;
      kind: "permission";
      tool: string;
      /** Claude Code's own sentence for it, when it gave one */
      title?: string;
      /** the input, cut */
      detail: string;
      /** Claude Code suggested a rule, so "always" means something */
      canAlways: boolean;
      /** a subagent asks, not the session itself: its label */
      agent?: string;
      /** an edit: what it would change, as `editDiff` lines ("+", "-", " ", "@", "…" first) */
      diff?: string[];
    }
  /** the model turned the request down: try it on the fallback, or change what was asked */
  | { id: string; kind: "refusal"; model: string; fallback: string; category?: string }
  /** auto mode fell back to claude code's own classifier, which is billed: go on, or stop */
  | { id: string; kind: "auto-fallback"; title?: string; paragraphs: string[] }
  /** an MCP server asks the person for something: a small form, or a page to open (sign-in) */
  | {
      id: string;
      kind: "elicit";
      server: string;
      message: string;
      title?: string;
      /** a page to open, for "url" mode: nothing to fill in */
      url?: string;
      fields: ElicitField[];
    };

/** one field of an MCP server's form, from its JSON schema's flat properties */
export interface ElicitField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  description?: string;
  /** an enum's choices */
  options?: string[];
}

export type ChatAnswer =
  /** question text -> the label picked, or what was typed. several picks are comma-separated */
  | { kind: "question"; answers: Record<string, string> }
  /** `mode`: what claude goes on in once approved. absent: the mode it was in before planning */
  | { kind: "plan"; approve: boolean; message?: string; mode?: ChatMode }
  | { kind: "permission"; allow: "once" | "always" | "no"; message?: string }
  /** a dialog's button, as claude code names it. null: dismissed, claude does what it would */
  | { kind: "dialog"; choice: DialogChoice | null }
  /** an MCP server's form: sent, turned down, or left */
  | {
      kind: "elicit";
      action: "accept" | "decline" | "cancel";
      content?: Record<string, string | number | boolean>;
    };

export type DialogChoice = "retry_fallback" | "edit_prompt" | "continue" | "interrupt";

/** the host's side of a session, sent whole every time it moves. the streamed answer goes apart */
export interface ChatStatus {
  /** a claude process is up for it */
  live: boolean;
  /** one is being started */
  starting: boolean;
  /** a turn is under way */
  running: boolean;
  mode?: ChatMode;
  /** what the mode pill steps through. bypass only when the session started in it */
  modes: ChatMode[];
  model?: string;
  /**
   * `id`: the model a value like "opus" stands for, which is what claude reports it is on.
   * `efforts`: the effort levels it takes, none for a model with no effort setting
   */
  models: Array<{
    value: string;
    label: string;
    id?: string;
    description?: string;
    efforts?: string[];
    /** it has a fast mode */
    fast?: boolean;
  }>;
  /** the effort the next turn runs at, as claude applies it: "low" ... "max" */
  effort?: string;
  /** fast mode is on, as claude applies it (this session only) */
  fast?: boolean;
  /** thinking was turned off (a 4.x model: 5.x models always think) */
  thinkingOff?: boolean;
  /** the output style it answers in, and the ones there are */
  style?: string;
  styles?: string[];
  /** ultracode is on: a workflow of agents on every task, this session only */
  ultracode?: boolean;
  /** the model takes ultracode */
  ultracodeAvailable?: boolean;
  asks: ChatAsk[];
  /** when the turn under way started: the header's clock */
  since?: number;
  /** the tool the turn is in, while it is in one: what it acts on, and since when */
  /**
   * `id`: its call. `bg`: claude has it as a foreground task (a Bash, an agent) that can be sent
   * to the background, ⌃B
   */
  tool?: { name: string; target?: string; since: number; id?: string; bg?: boolean };
  /** what the turn is doing that is no tool and no words: compacting, waiting to retry */
  activity?: string;
  /**
   * what claude said along the way that is in no transcript: a tool it turned down by itself
   * (don't ask, auto), a command's output, a hook's reason. until the next send
   */
  notes?: ChatNote[];
  /** the subagents this claude started or heard of, as its task frames say: live state */
  agents?: ChatAgent[];
  /**
   * it is thinking now, since when. no token count: with the summary on, claude's estimate frames
   * come in one burst as the block ends (probe), so a count would read nothing until it is over
   */
  thinking?: { since: number };
  /**
   * how full the conversation is, as claude counts it after each turn: tokens in it, and where it
   * compacts itself (auto-compact's threshold, else the window)
   */
  context?: { used: number; limit: number };
  /**
   * a usage limit getting close (`warning`) or hit (`rejected`), as claude's rate_limit_event says:
   * how much of which window is used, and when it resets (ms). absent while all is well
   */
  limit?: { state: "warning" | "rejected"; window: string; used?: number; resets?: number };
  /**
   * sent while a turn ran, and not taken yet: its uuid (what takes it back), what the row shows,
   * and the words alone, which go back in the composer when it is taken back
   */
  queued: Array<{ id: string; text: string; said: string }>;
  /** what went wrong last: claude did not start, a control was refused */
  error?: string;
  /** bumped whenever the transcript moved: the window reads it again */
  rev: number;
}

/** one of `ChatStatus.notes` */
export interface ChatNote {
  kind: "denied" | "output" | "info";
  text: string;
}

/** a subagent of the session, as the agents list shows it */
export interface ChatAgent {
  /** the task id, which is the agent id: `subagents/agent-<id>.jsonl` */
  id: string;
  /** the label its parent gave it, else the start of what it was asked */
  description: string;
  agentType?: string;
  /** the Agent call that started it */
  toolUseId?: string;
  state: "running" | "done" | "failed" | "stopped";
  /** it was started in the background, so it outlives the turn */
  background?: boolean;
  since: number;
  ended?: number;
  /** what it is doing or last did: its own progress line, or its last tool */
  step?: string;
  /** a Workflow run, not an agent: its agents are the rows whose `workflow` is its id */
  kind?: "workflow";
  /** one of a workflow's agents: that run's row id */
  workflow?: string;
}

/** the session a chat window is for */
export interface ChatTarget {
  session: SessionRef;
  project?: ProjectId;
  /** the folder it runs in: where a relative path in what it says is from */
  cwd: string;
  /** when it last moved */
  at: number;
  appearance: AppSettings["appearance"];
  palette: AppSettings["palette"];
  /** the editor's name, for Open in */
  editor: string;
  status: ChatStatus;
  /** the answer streamed so far */
  text: string;
  /** why it cannot be talked to from here: it is live in another app */
  readOnly?: string;
  /** made here a moment ago (cmd-N): no transcript yet */
  fresh?: boolean;
  /** opened from the session card for a file or the agents, before the page was up */
  show?: ChatShow;
}

/** what `/` offers: one of Claude Code's commands, or a skill */
export interface ChatCommand {
  name: string;
  description: string;
  /** what it takes after its name, `<file>` */
  hint: string;
}

/**
 * a file attached in the composer, in the shapes the vs code extension sends: an image or a pdf as
 * base64, a text or code file as its text. `name` is what claude sees as the document's title
 */
export type ChatAttachment =
  | {
      kind: "image";
      mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      data: string;
    }
  | { kind: "pdf"; name: string; data: string }
  | { kind: "text"; name: string; text: string };

/** a file `@` offers: what goes in the message, and how the menu shows it */
export interface ChatPath {
  insert: string;
  shown: string;
}

/** a chat window's conversation: the turns, and every file the session wrote, the latest first */
export interface ChatConversation extends ConversationView {
  written: string[];
}

/** what the viewer reads of a file */
export type ChatFileText = { text: string } | { binary: true; size: number } | { tooBig: number };

/**
 * a chat window's calls. each acts on the window's own session, which main knows by the window:
 * no call names one, so no page can reach a session it was not opened on
 */
export interface ChatApi {
  /** null for a window that has no session yet: the spare */
  chatTarget(): Promise<ChatTarget | null>;
  /** its transcript's turns, as the panel gets them. `turns`: how many of the last, past 100 */
  chatConversation(turns?: number): Promise<ChatConversation | null>;
  /** the whole conversation as markdown: onto the clipboard, or into a file the person picks */
  chatExport(to: "clipboard" | "file"): Promise<Outcome<{ path?: string }>>;
  /** the project's plans/ and artifacts/, newest first. empty for a session in no project */
  chatFiles(): Promise<{ plans: string[]; artifacts: string[] }>;
  /** what is changed and not committed in the session's folders that are git repos */
  chatChanges(): Promise<ChatChange[]>;
  /** one changed file's diff against the last commit, as `editDiff` lines. a new file is all "+" */
  chatChangeDiff(path: string): Promise<Outcome<string[]>>;
  /** a file of the session's, for the viewer. refused outside its folders */
  chatReadFile(path: string): Promise<Outcome<ChatFileText>>;
  /** the file the viewer shows, so a change to it is pushed (`chat:file`). null: none */
  chatWatch(path: string | null): Promise<Outcome>;
  /** the first keystroke: claude starts now, so the first send does not wait for it */
  chatWarm(): Promise<Outcome>;
  chatSend(text: string, files?: ChatAttachment[]): Promise<Outcome>;
  /** what `/` offers. empty until claude is up */
  chatCommands(): Promise<ChatCommand[]>;
  /** what `@` offers: the files of the session's folders. `fresh`: list them again first */
  chatPaths(fresh: boolean): Promise<ChatPath[]>;
  chatInterrupt(): Promise<Outcome>;
  chatSetMode(mode: ChatMode): Promise<Outcome>;
  chatSetModel(model: string): Promise<Outcome>;
  /** one of the current model's effort levels, from the next turn on */
  chatSetEffort(level: string): Promise<Outcome>;
  chatSetUltracode(on: boolean): Promise<Outcome>;
  /** every subagent of the session: what claude says now, over what its transcripts say */
  chatAgents(): Promise<ChatAgent[]>;
  /** one subagent's own transcript, as a turn. null when it is not there */
  chatAgent(id: string): Promise<TurnView | null>;
  /** a running subagent stops, the rest of the session goes on */
  chatStopAgent(id: string): Promise<Outcome>;
  /** what one of the session's edits changed, by its call's id. null: not an edit of its */
  chatStepDiff(toolUseId: string): Promise<string[] | null>;
  /** words onto the clipboard: an answer, a code block, the conversation */
  chatCopy(text: string): Promise<Outcome>;
  /** its claude's MCP servers and how each is: connected, pending, failed, needs-auth, disabled */
  chatMcp(): Promise<Outcome<Array<{ name: string; status: string; error?: string }>>>;
  /** try a failed MCP server again */
  chatMcpReconnect(name: string): Promise<Outcome>;
  /**
   * the files claude changed since this message, put back as they were. `dry`: only say what would
   * change. only turns grove ran (with checkpoints) can be rewound
   */
  chatRewind(uuid: string, dry: boolean): Promise<Outcome<ChatRewind>>;
  /**
   * a new session that is this one up to `upTo` (a line's uuid; null: from nothing), in a window of
   * its own, with `draft` in its composer
   */
  chatFork(upTo: string | null, draft: string): Promise<Outcome>;
  /**
   * /btw: a quick question on the side, answered from the conversation without joining it (no
   * tools, nothing in the transcript). null: no answer
   */
  chatSide(question: string): Promise<Outcome<string | null>>;
  /** fast mode on or off, this session only */
  chatSetFast(on: boolean): Promise<Outcome>;
  /** thinking on or off: only a model that can answer without it */
  chatSetThinking(on: boolean): Promise<Outcome>;
  /** one of the output styles there are, this session only */
  chatSetStyle(style: string): Promise<Outcome>;
  /** the session's name, as /rename gives one: claude code keeps it, and grove's list follows */
  chatRename(title: string): Promise<Outcome>;
  /** the tool under way goes on in the background, and the turn goes on without it (⌃B) */
  chatBackground(): Promise<Outcome<boolean>>;
  /** a queued message, taken back before claude got to it. false: it already had */
  chatUnqueue(id: string): Promise<Outcome<boolean>>;
  chatAnswer(askId: string, answer: ChatAnswer): Promise<Outcome>;
  /** Open in the editor. `after`: once the turn under way has finished */
  chatOpenInEditor(when: "now" | "after"): Promise<Outcome<{ message?: string }>>;
}

export const CHAT_CHANNELS = [
  "chatTarget",
  "chatConversation",
  "chatExport",
  "chatFiles",
  "chatChanges",
  "chatChangeDiff",
  "chatReadFile",
  "chatWatch",
  "chatWarm",
  "chatSend",
  "chatCommands",
  "chatPaths",
  "chatInterrupt",
  "chatSetMode",
  "chatSetModel",
  "chatSetEffort",
  "chatSetUltracode",
  "chatAgents",
  "chatAgent",
  "chatStopAgent",
  "chatStepDiff",
  "chatCopy",
  "chatUnqueue",
  "chatBackground",
  "chatRename",
  "chatMcp",
  "chatMcpReconnect",
  "chatSetFast",
  "chatSetThinking",
  "chatSetStyle",
  "chatRewind",
  "chatFork",
  "chatSide",
  "chatAnswer",
  "chatOpenInEditor",
] as const satisfies ReadonlyArray<keyof ChatApi>;

// a method or an event left out of its list typechecks on both sides and is undefined in the page
type MissingInvoke = Exclude<keyof Api, (typeof INVOKE_CHANNELS)[number]>;
type MissingPush = Exclude<keyof PushEvents, (typeof PUSH_CHANNELS)[number]>;
type MissingChat = Exclude<keyof ChatApi, (typeof CHAT_CHANNELS)[number]>;
export const CHANNELS_COMPLETE: [MissingInvoke, MissingPush, MissingChat] extends [
  never,
  never,
  never,
]
  ? true
  : never = true;

export interface Bridge extends Api, ChatApi {
  /** where a dropped or picked file is on disk: "" for one that is not a file there (a paste) */
  pathOf(file: File): string;
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
