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
  Mark,
  ModelUsage,
  Prompt,
  Question,
  SessionAgent,
  TeardownOutcome,
  TitleSource,
} from "@grove/core/pure";

export type { Mark, Prompt, Question, SessionAgent };

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
  /** what the session is doing right now, when its hooks report to us */
  live?: LiveStatus;
  /** its subagents, running ones first. every session, live or long finished. */
  agents?: SessionAgent[];
  /** put away on purpose: out of the list and out of search unless it is asking for someone */
  archived?: boolean;
  /** Claude Code's supervisor knows it: running in the background now, or once and not removed */
  background?: BackgroundView;
  /**
   * it stopped mid-turn without finishing: its process went away while it was running (a window
   * closed on it, a crash, a reboot), or the supervisor says its background run failed
   */
  interrupted?: { why: "gone" | "failed"; at?: number };
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

/** one hunk of a unified diff: lines start with " ", "+" or "-" */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** one tool call opened: the whole input, and the whole result up to a cap */
export interface StepDetail {
  input: string;
  result?: string;
  isError?: boolean;
  /** cut at the cap */
  truncated: boolean;
  /** what it did to files: an Edit's or a Write's patch, the files a Bash command changed */
  diffs?: Array<{ path: string; hunks: DiffHunk[]; created?: boolean }>;
  /** a Bash call's streams, apart */
  bash?: {
    stdout: string;
    stderr: string;
    interrupted: boolean;
    /** where a big output went. said, never read. */
    persisted?: string;
    exit?: string;
    background?: string;
  };
  /** an AskUserQuestion's every question and option, with what was picked */
  questions?: Question[];
  /** an ExitPlanMode's plan, whole. markdown, untrusted. */
  plan?: string;
}

/**
 * one turn of a session's conversation as the pane draws it before its work is opened: the
 * prompt, what is always in sight, the work line's numbers and the answer. no steps.
 */
export interface ConversationTurn {
  kind: "turn";
  /** where it sits in the conversation. stable while the session writes: turns are only added. */
  n: number;
  /** absent for work that went on after a compaction with nobody asking */
  prompt?: Prompt;
  /** a plan, a question, what the person said while it worked. `step` is where each goes in the work. */
  marks: Mark[];
  /** every text block of its final message. markdown, untrusted. */
  answer?: string;
  /** a slash command's output */
  output?: string;
  /** the api call failed for good, in Claude Code's words */
  error?: string;
  /** the last api error of a run of retries nothing came after */
  apiError?: string;
  interrupted?: boolean;
  /** tool calls */
  tools: number;
  filesEdited: number;
  agents: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

export interface ConversationDivider {
  kind: "compact";
  n: number;
  at: number;
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  /** what Claude Code carried on with. markdown, untrusted. */
  summary?: string;
}

export type ConversationEntry = ConversationTurn | ConversationDivider;

/** a whole session's conversation, turn by turn, and what the header says about it */
export interface ConversationView {
  key: SessionKey;
  items: ConversationEntry[];
  /** the model of its last response */
  model?: string;
  tools: number;
  turns: number;
  startedAt?: number;
  lastAt?: number;
  /** the newest turn's work, while the session is running: it is open from the start */
  live?: { n: number; steps: DetailStep[] };
}

/**
 * what changed in the conversation on screen since the last push. every entry at or past `from` is
 * replaced by `items`. `live` is the newest turn's work from step `from` on, when it moved.
 */
export interface ConversationTurns {
  key: SessionKey;
  /** which follow this belongs to. a push from an earlier one is dropped. */
  gen: number;
  from: number;
  items: ConversationEntry[];
  head: Omit<ConversationView, "key" | "items" | "live">;
  live?: { n: number; from: number; steps: DetailStep[] };
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
  | "inspect"
  /** a session Claude Code's supervisor holds: `claude attach <id>` in Terminal */
  | "attach"
  /** `claude stop <id>`, then land on it like any other session */
  | "stop-land"
  | "stop"
  /** hand a session nothing is running to Claude Code's supervisor. asks for the prompt first. */
  | "continue-bg";

export interface SessionAction {
  id: SessionActionId;
  label: string;
  hint?: string;
  /** the shortcut that does the same thing, shown right-aligned. only where one exists. */
  keys?: string;
  enabled: boolean;
  /** drawn after a separator */
  secondary?: boolean;
  /** asked before it runs: it interrupts something */
  confirm?: { title: string; body: string; label: string };
}

/** what to hand Claude Code's supervisor: a session to continue, or a new one in a combo */
export type BackgroundRequest = (
  | { kind: "continue"; key: SessionKey }
  | { kind: "new"; combo: string; name?: string }
) & {
  /** typed by the person, never sent without them pressing the button. never empty. */
  prompt: string;
  /** run it in Terminal instead, where the CLI's one-time trust prompt can be answered */
  terminal?: boolean;
};

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
  /** these agents are on screen. a finished one without a line gets one, asked once, ever. */
  agentsSeen(key: SessionKey, agentIds: string[]): Promise<void>;
  /** one step opened: read back from the two transcript lines it points at */
  agentStep(key: SessionKey, agentId: string, stepId: string): Promise<StepDetail | null>;
  /**
   * the session's own conversation on screen: every turn, without the work. from here until the
   * next call, what it writes arrives as `conversation:turns`. a null key stops that.
   */
  followConversation(
    key: SessionKey | null,
    /** a search that led here: `found` is the turn that matched it best, and the step inside it */
    find?: string,
  ): Promise<{
    gen: number;
    conversation: ConversationView;
    found?: { n: number; step?: number };
  } | null>;
  /** one turn's work, opened */
  conversationSteps(key: SessionKey, n: number): Promise<DetailStep[] | null>;
  /** one step of the conversation opened, by its tool_use id */
  conversationStep(key: SessionKey, stepId: string): Promise<StepDetail | null>;
  /**
   * the last paragraph of the message a session stopped on, read from the end of its transcript:
   * for an inbox row whose hook's copy was cut short
   */
  lastWords(key: SessionKey): Promise<string | null>;
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
  /**
   * `claude --resume <id> --bg` or `claude --bg`, with the login shell's environment. fails with
   * code `not-trusted` in a folder that never passed the CLI's trust prompt: `terminal: true` is
   * the way through.
   */
  dispatchBackground(req: BackgroundRequest): Promise<Outcome<{ id?: string; message: string }>>;

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
  "followConversation",
  "conversationSteps",
  "conversationStep",
  "lastWords",
  "agentsSeen",
  "openExternal",
  "markSeen",
  "archiveSessions",
  "runSessionAction",
  "dispatchBackground",
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
  | "scope-inbox"
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
  "conversation:turns": ConversationTurns;
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
  "conversation:turns",
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
