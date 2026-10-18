// grove chat's host: one claude per session grove runs itself, through the agent sdk, kept in main
// so it outlives the window it was opened from. no electron import: a window is a PushTarget.
import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CanUseTool,
  EffortLevel,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { firstSentence, toolLabel, toolTarget } from "@grove/core";
import type {
  ChatAgent,
  ChatAnswer,
  ChatAsk,
  ChatAttachment,
  ChatCommand,
  ChatMode,
  ChatNote,
  ChatQuestion,
  ChatStatus,
} from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";
import type { PushTarget } from "../push.ts";

/** an idle session with no window open is let go after this. the next send resumes it */
export const REAP_MS = 10 * 60_000;
/** how long a turn being let go of gets to end on its interrupt */
const RELEASE_WAIT_MS = 3000;
/** the streamed answer goes to the window at most this often */
const FLUSH_MS = 50;
/** a permission's input, as the card shows it */
const DETAIL_MAX = 2000;
/** a question option's preview: a mockup or a snippet */
const PREVIEW_MAX = 8000;

/** a prompt, a typed answer: generous, and still a bound on what a page can hand claude */
const TEXT_MAX = 200_000;

export const isText = (v: unknown, max = TEXT_MAX): v is string =>
  typeof v === "string" && v.length <= max;

/** what the page sent as an answer, held to the shapes the host knows. anything else is refused */
export function parseAnswer(raw: unknown): ChatAnswer {
  const a = raw as Record<string, unknown> | null;
  const bad = () => new AppError("invalid", "That is not an answer.");
  if (!a || typeof a !== "object") throw bad();
  const message = a.message === undefined ? undefined : isText(a.message) ? a.message : null;
  if (message === null) throw bad();
  if (a.kind === "question") {
    const answers = a.answers as Record<string, unknown> | null;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw bad();
    const clean: Record<string, string> = {};
    for (const [q, v] of Object.entries(answers)) {
      if (!isText(q, 4000) || !isText(v)) throw bad();
      clean[q] = v;
    }
    return { kind: "question", answers: clean };
  }
  if (a.kind === "plan" && typeof a.approve === "boolean") {
    return { kind: "plan", approve: a.approve, ...(message ? { message } : {}) };
  }
  if (a.kind === "permission" && (a.allow === "once" || a.allow === "always" || a.allow === "no")) {
    return { kind: "permission", allow: a.allow, ...(message ? { message } : {}) };
  }
  throw bad();
}

/** where a session runs: its folder, and the project's other folders */
export interface ChatWhere {
  cwd: string;
  dirs: string[];
  /** a session grove made (cmd-N) that has no transcript yet: claude starts it under this id */
  fresh?: boolean;
}

/** what the api takes, as Claude Code's own image paste sends it */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MB = 1024 * 1024;
/** base64 of n bytes */
const encoded = (n: number) => Math.ceil(n / 3) * 4;
/**
 * grove's caps, on what goes over the wire. claude code shrinks an image before the api sees it
 * (probe: an 18.7MB png went as a 455KB jpeg), so an image's cap only bounds what crosses ipc. a
 * pdf and a text file go as they are, and again with every later turn: together they stay under
 * half the api's 32MB request, so the conversation around them still fits
 */
export const ATTACH = {
  files: 10,
  image: encoded(20 * MB),
  pdf: encoded(10 * MB),
  text: 512 * 1024,
  documents: 16 * MB,
} as const;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** files attached in the composer, as the page sent them, held to what grove sends. else refused */
export function parseAttachments(raw: unknown): ChatAttachment[] {
  if (raw === undefined) return [];
  const bad = (why = "That is not a file Claude can take.") => new AppError("invalid", why);
  if (!Array.isArray(raw) || raw.length > ATTACH.files) throw bad();
  let documents = 0;
  const out = raw.map((f): ChatAttachment => {
    const o = f as Record<string, unknown> | null;
    if (o?.kind === "image") {
      if (typeof o.mediaType !== "string" || !IMAGE_TYPES.has(o.mediaType)) throw bad();
      if (!isText(o.data, ATTACH.image) || !BASE64.test(o.data)) throw bad();
      return { kind: "image", mediaType: o.mediaType as "image/png", data: o.data };
    }
    if (!isText(o?.name, 255) || !o.name.trim()) throw bad();
    if (o.kind === "pdf") {
      if (!isText(o.data, ATTACH.pdf) || !BASE64.test(o.data)) throw bad();
      documents += o.data.length;
      return { kind: "pdf", name: o.name, data: o.data };
    }
    if (o.kind === "text") {
      if (!isText(o.text, ATTACH.text)) throw bad();
      documents += o.text.length;
      return { kind: "text", name: o.name, text: o.text };
    }
    throw bad();
  });
  if (documents > ATTACH.documents) throw bad("Those files are too big to send together.");
  return out;
}

/** a message's content blocks: what is attached first, in the shapes vs code sends, then the words */
function blocksFor(text: string, files: ChatAttachment[]): SDKUserMessage["message"]["content"] {
  return [
    ...files.map((f) =>
      f.kind === "image"
        ? {
            type: "image" as const,
            source: { type: "base64" as const, media_type: f.mediaType, data: f.data },
          }
        : f.kind === "pdf"
          ? {
              type: "document" as const,
              source: {
                type: "base64" as const,
                media_type: "application/pdf" as const,
                data: f.data,
              },
              title: f.name,
            }
          : {
              // always text/plain: a csv sent as text/csv makes the api drop the document
              type: "document" as const,
              source: { type: "text" as const, media_type: "text/plain" as const, data: f.text },
              title: f.name,
            },
    ),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
}

export interface ChatHostOptions {
  claudeBin: () => Promise<string>;
  env: () => Promise<NodeJS.ProcessEnv>;
  /** a process came or went, or a turn started or ended: rows say where a session runs */
  onChange?: () => void;
  now?: () => number;
  /** claude code's own settings.json: whether the person asked to see thinking summaries */
  claudeSettings?: string;
  /**
   * /clear: the same claude goes on as a new session under a new id. the host has moved it there,
   * and its windows go with it
   */
  onReset?: (from: string, to: string, where: ChatWhere) => void;
  /** its status moved: the main window's session card follows it. never the streamed text */
  onStatus?: (id: string, status: ChatStatus) => void;
}

/** vs code's thinking budget (extension.js `M61`), sent for every model as it sends it */
const THINKING_BUDGET = 31_999;

/** the person's `showThinkingSummaries`, as vs code reads it: off unless it says true */
async function showsThinking(file: string | undefined): Promise<boolean> {
  if (!file) return false;
  try {
    return JSON.parse(await readFile(file, "utf8"))?.showThinkingSummaries === true;
  } catch {
    return false;
  }
}

/**
 * what the claude code that started grove put in its environment, when one did (`pnpm app:dev`
 * from an agent's shell): with it the child registers as that session's editor. a grove opened
 * from Finder has none of these
 */
const PARENT_SESSION = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
]);

export function hostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !PARENT_SESSION.has(k)));
}

/** the pill's modes. bypass and the classifier modes only when the session started in one */
export function modesFor(start: ChatMode | undefined): ChatMode[] {
  const modes: ChatMode[] = ["default", "acceptEdits", "plan"];
  return start && !modes.includes(start) ? [...modes, start] : modes;
}

/** an api error's kind, as the live line says it */
const RETRY_WORD: Record<string, string> = {
  rate_limit: "rate limited",
  overloaded: "overloaded",
  server_error: "server error",
  unknown: "an error",
};

/** an api_retry frame, as the live line says it: "Retrying in 8s · overloaded (2 of 10)" */
export function retryLine(m: {
  retry_delay_ms: number;
  attempt: number;
  max_retries: number;
  error_status: number | null;
  error: string;
}): string {
  // no status: the api sent nothing back in time
  const why =
    m.error_status === null ? "no answer" : (RETRY_WORD[m.error] ?? m.error.replace(/_/g, " "));
  const wait = Math.max(1, Math.round(m.retry_delay_ms / 1000));
  return `Retrying in ${wait}s · ${why} (${m.attempt} of ${m.max_retries})`;
}

/**
 * the model as the window names it. claude reports the id it runs ("claude-opus-5-5"), and more
 * than one row can stand for that id (Default and Opus both do): the row picked stays picked
 */
export function modelFor(status: Pick<ChatStatus, "model" | "models">, reported: string): string {
  const named = status.models.find((m) => m.value === status.model || m.id === status.model);
  return named && (named.id === reported || named.value === reported) ? named.value : reported;
}

/** notes kept under a turn: past this the oldest go */
const NOTES_MAX = 20;

/** a task's end, as the agents list says it */
const TASK_STATE: Record<string, ChatAgent["state"] | undefined> = {
  completed: "done",
  failed: "failed",
  killed: "stopped",
  stopped: "stopped",
};

/** a workflow agent's state in `workflow_progress`: start and done seen on the wire, the rest guessed */
const WORKFLOW_AGENT_STATE: Record<string, ChatAgent["state"] | undefined> = {
  start: "running",
  done: "done",
  failed: "failed",
  error: "failed",
  skipped: "stopped",
  cancelled: "stopped",
  killed: "stopped",
};

/**
 * one entry of a workflow's `task_progress.workflow_progress` (recordings/d-workflow): its agents
 * have no task frames of their own, this is all the stream says of them. not in the sdk's types
 */
interface WorkflowAgentProgress {
  type: "workflow_agent";
  agentId?: string;
  label?: string;
  agentType?: string;
  state?: string;
  durationMs?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  resultPreview?: string;
}

/** a workflow's agents as the agents list shows them, from the latest progress snapshot */
export function workflowAgents(
  workflow: string,
  progress: unknown,
  had: ReadonlyMap<string, ChatAgent>,
  now: number,
): ChatAgent[] {
  if (!Array.isArray(progress)) return [];
  return progress.flatMap((p: WorkflowAgentProgress): ChatAgent[] => {
    // a queued one has no id, and no transcript yet
    if (p?.type !== "workflow_agent" || typeof p.agentId !== "string") return [];
    const state = WORKFLOW_AGENT_STATE[p.state ?? ""] ?? "running";
    const was = had.get(p.agentId);
    // grove's clock, as for every agent: from when it was first heard of, back by what it took
    const took = typeof p.durationMs === "number" ? p.durationMs : 0;
    const since = was?.since ?? (state === "running" ? now : now - took);
    const tool =
      p.lastToolName && `${p.lastToolName}${p.lastToolSummary ? ` ${p.lastToolSummary}` : ""}`;
    const step = tool || (state === "done" && p.resultPreview ? cut(p.resultPreview, 200) : "");
    return [
      {
        id: p.agentId,
        description: p.label || "agent",
        ...(p.agentType ? { agentType: p.agentType } : {}),
        workflow,
        state,
        since,
        ...(state !== "running" ? { ended: was?.ended ?? now } : {}),
        ...(step ? { step } : {}),
      },
    ];
  });
}

const MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
]);
const asMode = (v: unknown): ChatMode | undefined =>
  typeof v === "string" && MODES.has(v) ? (v as ChatMode) : undefined;

/** what the person sends, as the sdk reads it: one at a time, as they come */
class Prompts implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;

  push(text: string, files: ChatAttachment[] = []): void {
    this.queue.push({
      type: "user",
      message: { role: "user", content: blocksFor(text, files) },
      parent_tool_use_id: null,
      // typed by a person: the sdk treats a message with no origin as nobody's
      origin: { kind: "human" },
    });
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => {
        this.wake = r;
      });
      this.wake = null;
    }
  }
}

/** what `getSettings().applied` says, as claude 2.1.296 answers it (recordings/c-start.jsonl) */
interface Applied {
  model?: string;
  effort?: string | null;
  ultracode?: boolean;
  ultracodeRequested?: boolean;
  ultracodeAvailable?: boolean;
}

interface Waiting {
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

interface Hosted {
  id: string;
  where: ChatWhere;
  q?: Query;
  prompts: Prompts;
  status: ChatStatus;
  /** the answer being streamed: the text block the turn is writing now */
  text: string;
  /** where the text changed since the window last got it. null: nothing to send */
  dirty: number | null;
  flush?: NodeJS.Timeout;
  waiting: Map<string, Waiting>;
  windows: Set<PushTarget>;
  lastActive: number;
  starting?: Promise<void>;
  /** the message loop. it ends when the process does */
  ended?: Promise<void>;
  /** what waits for the turn under way to end: a move to the editor */
  afterTurn: Array<() => void>;
  /** a model picked before claude was up */
  model?: string;
  /** what `/` offers: Claude Code's commands and the skills it found */
  commands: ChatCommand[];
  /** the file its window's viewer shows: a change to it is pushed there */
  watching?: FSWatcher;
  /** its subagents, by task id, as the task frames say */
  agents: Map<string, ChatAgent>;
}

const emptyStatus = (): ChatStatus => ({
  live: false,
  starting: false,
  running: false,
  modes: modesFor(undefined),
  models: [],
  asks: [],
  queued: [],
  rev: 0,
});

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const commandsOf = (raw: unknown): ChatCommand[] =>
  (Array.isArray(raw) ? raw : []).flatMap((c) =>
    c && typeof c.name === "string"
      ? [
          {
            name: c.name,
            description: typeof c.description === "string" ? c.description : "",
            hint: typeof c.argumentHint === "string" ? c.argumentHint : "",
          },
        ]
      : [],
  );

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function questionsOf(input: Record<string, unknown>): ChatQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.flatMap((q): ChatQuestion[] => {
    if (!q || typeof q !== "object") return [];
    const o = q as Record<string, unknown>;
    if (typeof o.question !== "string") return [];
    const options = Array.isArray(o.options) ? o.options : [];
    return [
      {
        question: o.question,
        header: typeof o.header === "string" ? o.header : "",
        multiSelect: o.multiSelect === true,
        options: options.flatMap((x) => {
          const o = x as { label?: unknown; description?: unknown; preview?: unknown } | null;
          if (!o || typeof o !== "object" || typeof o.label !== "string") return [];
          return [
            {
              label: o.label,
              description: String(o.description ?? ""),
              ...(typeof o.preview === "string" && o.preview
                ? { preview: cut(o.preview, PREVIEW_MAX) }
                : {}),
            },
          ];
        }),
      },
    ];
  });
}

/** a tool's input as a card shows it: the command or the file first, when it has one */
function detailOf(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "url", "pattern"]) {
    if (typeof input[key] === "string") return cut(input[key] as string, DETAIL_MAX);
  }
  return cut(JSON.stringify(input, null, 2), DETAIL_MAX);
}

export class ChatHost {
  private readonly o: ChatHostOptions;
  private readonly hosted = new Map<string, Hosted>();
  private reaper: NodeJS.Timeout;

  constructor(o: ChatHostOptions) {
    this.o = o;
    this.reaper = setInterval(() => this.reap(), 60_000);
    this.reaper.unref?.();
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private entry(id: string, where?: ChatWhere): Hosted {
    let h = this.hosted.get(id);
    if (!h) {
      h = {
        id,
        where: where ?? { cwd: "", dirs: [] },
        prompts: new Prompts(),
        status: emptyStatus(),
        text: "",
        dirty: null,
        waiting: new Map(),
        windows: new Set(),
        lastActive: this.now(),
        afterTurn: [],
        commands: [],
        agents: new Map(),
      };
      this.hosted.set(id, h);
    } else if (where && !h.q) {
      h.where = where;
    }
    return h;
  }

  /** a claude process is up for it, or starting: grove runs it, not the editor */
  hosts(id: string): boolean {
    return !!this.hosted.get(id)?.q;
  }

  running(id: string): boolean {
    return !!this.hosted.get(id)?.status.running;
  }

  /** the sessions mid-turn: what quitting would cut short */
  busy(): string[] {
    return [...this.hosted.values()].filter((h) => h.status.running).map((h) => h.id);
  }

  status(id: string): ChatStatus {
    return this.hosted.get(id)?.status ?? emptyStatus();
  }

  text(id: string): string {
    return this.hosted.get(id)?.text ?? "";
  }

  /** what `/` offers in this session: empty until claude is up */
  commands(id: string): ChatCommand[] {
    return this.hosted.get(id)?.commands ?? [];
  }

  /** a window shows this session from now on. what it needs to catch up is `status` and `text` */
  attach(id: string, target: PushTarget): void {
    this.entry(id).windows.add(target);
  }

  detach(id: string, target: PushTarget): void {
    const h = this.hosted.get(id);
    if (!h) return;
    h.windows.delete(target);
    h.lastActive = this.now();
    if (h.windows.size === 0) this.watch(id, null);
  }

  /**
   * `file` changed on disk: its window hears of it, and its viewer reads it again. the folder is
   * watched, not the file, so a file written as a new one and renamed over it still counts. null
   * stops. the path was checked against the session's folders by the caller
   */
  watch(id: string, file: string | null): void {
    const h = this.entry(id);
    h.watching?.close();
    h.watching = undefined;
    if (!file) return;
    const name = path.basename(file);
    let soon: NodeJS.Timeout | undefined;
    try {
      h.watching = watch(path.dirname(file), (_event, changed) => {
        if (changed !== null && changed !== name) return;
        // an editor's save is several events
        clearTimeout(soon);
        soon = setTimeout(() => {
          for (const w of h.windows) this.deliver(h, w, "grove:chat:file", { path: file });
        }, 80);
      });
      h.watching.on("error", () => this.watch(id, null));
    } catch {
      // the folder went away: there is nothing to watch
    }
  }

  /** claude for this session, started now if it is not up. resolves once it is ready */
  warm(id: string, where: ChatWhere): Promise<void> {
    const h = this.entry(id, where);
    h.lastActive = this.now();
    if (h.q && h.status.live) return Promise.resolve();
    h.starting ??= this.start(h).finally(() => {
      h.starting = undefined;
    });
    return h.starting;
  }

  /** while a turn runs, Claude Code queues it */
  async send(
    id: string,
    where: ChatWhere,
    text: string,
    files: ChatAttachment[] = [],
  ): Promise<void> {
    const h = this.entry(id, where);
    const queued = h.status.running;
    h.prompts.push(text, files);
    // what was said along the way belongs to the turn before
    if (!queued && h.status.notes?.length) this.set(h, { notes: [] });
    if (queued) {
      const images = files.filter((f) => f.kind === "image").length;
      const named = [
        ...(images ? [`${images} image${images === 1 ? "" : "s"}`] : []),
        ...files.flatMap((f) => (f.kind === "image" ? [] : [f.name])),
      ];
      const shown = named.length ? `${text}${text ? " " : ""}[${named.join(" · ")}]` : text;
      this.set(h, { queued: [...h.status.queued, shown] });
    } else this.turnStarted(h);
    await this.warm(id, where);
    if (!h.status.live) throw new Error(h.status.error ?? "Claude did not start.");
  }

  /** one running subagent stops. the turn and the other agents go on */
  async stopAgent(id: string, agentId: string): Promise<void> {
    const h = this.hosted.get(id);
    const a = h?.agents.get(agentId);
    if (a?.state !== "running") throw new Error("That agent is not running.");
    // a workflow's agent has no task of its own: the workflow is what stops
    if (a.workflow) throw new Error("Stop the workflow it is part of.");
    await h?.q?.stopTask(agentId);
  }

  async interrupt(id: string): Promise<void> {
    await this.hosted.get(id)?.q?.interrupt();
  }

  async setMode(id: string, where: ChatWhere, mode: ChatMode): Promise<void> {
    await this.warm(id, where);
    const h = this.entry(id);
    if (!h.status.modes.includes(mode)) throw new Error(`${mode} is not on offer in this session.`);
    await h.q?.setPermissionMode(mode);
    this.set(h, { mode });
  }

  async setModel(id: string, model: string): Promise<void> {
    const h = this.entry(id);
    if (!h.q) {
      // picked before claude is up: it starts on it
      h.model = model;
      this.set(h, { model });
      return;
    }
    await h.q.setModel(model);
    this.set(h, { model });
    // the model moves effort to its own default, and ultracode off where it has none
    await this.settings(h);
  }

  /** from the next turn. ultracode stays on: an effort sent alone would turn it off */
  async setEffort(id: string, where: ChatWhere, level: string): Promise<void> {
    await this.warm(id, where);
    const h = this.entry(id);
    const model = h.status.models.find(
      (m) => m.value === h.status.model || m.id === h.status.model,
    );
    // a level the model does not list is answered ok and changes nothing: refused here instead
    if (!model?.efforts?.includes(level))
      throw new Error(`${level} is not an effort this model takes.`);
    await h.q?.applyFlagSettings({
      effortLevel: level as EffortLevel,
      ...(h.status.ultracode ? { ultracode: true } : {}),
    });
    await this.settings(h);
  }

  async setUltracode(id: string, where: ChatWhere, on: boolean): Promise<void> {
    await this.warm(id, where);
    const h = this.entry(id);
    await h.q?.applyFlagSettings({ ultracode: on ? true : null });
    await this.settings(h);
    // the ack says ok on a model without it, and leaves it off: say so
    if (on && !h.status.ultracode) throw new Error("This model does not take ultracode.");
  }

  answer(id: string, askId: string, a: ChatAnswer): void {
    const h = this.hosted.get(id);
    const w = h?.waiting.get(askId);
    if (!h || !w) throw new Error("That question has already been answered.");
    const ask = h.status.asks.find((x) => x.id === askId);
    if (ask?.kind !== a.kind) throw new Error("That answer is for another kind of question.");
    let result: PermissionResult;
    if (a.kind === "question") {
      // the preview of a picked option goes with it, as Claude Code sends it: claude reads which
      // mockup was chosen, not only its label
      const annotations: Record<string, { preview: string }> = {};
      for (const q of questionsOf(w.input)) {
        const preview = q.options.find((o) => o.label === a.answers[q.question])?.preview;
        if (preview) annotations[q.question] = { preview };
      }
      result = {
        behavior: "allow",
        updatedInput: {
          ...w.input,
          answers: a.answers,
          ...(Object.keys(annotations).length ? { annotations } : {}),
        },
      };
    } else if (a.kind === "plan") {
      result = a.approve
        ? { behavior: "allow", updatedInput: w.input }
        : { behavior: "deny", message: a.message?.trim() || "Keep planning." };
    } else if (a.allow === "no") {
      result = { behavior: "deny", message: a.message?.trim() || "The user declined this." };
    } else {
      result = {
        behavior: "allow",
        updatedInput: w.input,
        ...(a.allow === "always" && w.suggestions ? { updatedPermissions: w.suggestions } : {}),
      };
    }
    this.settle(h, askId, result);
  }

  /** runs once the turn under way has ended, or now when none is */
  afterTurn(id: string, run: () => void): void {
    const h = this.hosted.get(id);
    if (h?.status.running) h.afterTurn.push(run);
    else run();
  }

  /**
   * lets the session go: claude is stopped, mid-turn or not, and nothing of it is left here but
   * the windows still looking at it. resolves once the process has gone
   */
  async release(id: string): Promise<void> {
    const h = this.hosted.get(id);
    if (!h?.q) return;
    if (h.status.running) {
      // stopped as Esc stops it, so the transcript ends the turn on an interrupt and not on a
      // process that vanished. a claude that does not answer is let go anyway
      const ended = new Promise<void>((r) => h.afterTurn.push(r));
      await h.q.interrupt().catch(() => {});
      await Promise.race([ended, new Promise((r) => setTimeout(r, RELEASE_WAIT_MS))]);
    }
    h.q?.close();
    await h.ended;
  }

  dispose(): void {
    clearInterval(this.reaper);
    for (const h of this.hosted.values()) {
      h.q?.close();
      h.watching?.close();
    }
  }

  // ---------- inside

  /** called every minute. a test calls it itself */
  reap(): void {
    const now = this.now();
    for (const h of this.hosted.values()) {
      if (h.q && !h.status.running && h.windows.size === 0 && now - h.lastActive > REAP_MS) {
        h.q.close();
      }
    }
  }

  private async start(h: Hosted): Promise<void> {
    this.set(h, { starting: true, error: undefined });
    let q: Query | undefined;
    try {
      // only here: with grove chat off the sdk is never even loaded
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const [bin, env, summaries] = await Promise.all([
        this.o.claudeBin(),
        this.o.env(),
        showsThinking(this.o.claudeSettings),
      ]);
      q = query({
        prompt: h.prompts,
        options: {
          pathToClaudeCodeExecutable: bin,
          cwd: h.where.cwd,
          additionalDirectories: h.where.dirs,
          // a session grove made has no transcript to resume yet: claude starts one under its id
          ...(h.where.fresh ? { sessionId: h.id } : { resume: h.id }),
          // CLAUDE.md, skills, hooks and the project's settings, as everywhere else. no mode: the
          // settings' defaultMode decides, as it does in the terminal
          settingSources: ["user", "project", "local"],
          // claude code's own prompt, as the vs code extension passes it. left out, the sdk sends an
          // empty one and the session runs without claude code's instructions
          systemPrompt: { type: "preset", preset: "claude_code" },
          // what the vs code extension starts every session with. checkpoints make grove's turns
          // rewindable later. the stop affordance keeps a stop from killing background agents:
          // each one is stopped from its own row
          enableFileCheckpointing: true,
          perTaskStopAffordance: true,
          // an option's preview in markdown, as the terminal shows it: the card draws it beside the
          // list, never as html
          toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
          thinking: {
            type: "enabled",
            budgetTokens: THINKING_BUDGET,
            ...(summaries ? { display: "summarized" as const } : {}),
          },
          includePartialMessages: true,
          env: hostEnv(env),
          ...(h.model ? { model: h.model } : {}),
          canUseTool: (tool, input, opts) => this.ask(h, tool, input, opts),
          stderr: (data) => log.warn(`chat ${h.id.slice(0, 8)}:`, data.trimEnd()),
        },
      });
      h.q = q;
      h.ended = this.pump(h, q);
      const init = await q.initializationResult();
      const mode = asMode((init as { current_permission_mode?: unknown }).current_permission_mode);
      h.commands = commandsOf(init.commands);
      this.set(h, {
        live: true,
        starting: false,
        mode,
        modes: modesFor(mode),
        models: (init.models ?? []).map((m) => ({
          value: m.value,
          label: m.displayName,
          ...(m.resolvedModel ? { id: m.resolvedModel } : {}),
          ...(m.description ? { description: m.description } : {}),
          ...(m.supportedEffortLevels?.length ? { efforts: [...m.supportedEffortLevels] } : {}),
        })),
      });
      await this.settings(h);
      // a resumed session is as full as it was: the ring knows before the first turn
      await this.contextUsage(h);
    } catch (e) {
      log.warn(`chat ${h.id.slice(0, 8)} did not start:`, e);
      // what was sent goes back to the window, which puts it in the composer again. kept here too
      // it would go out twice with the next start. a query that did start lets go of it as it ends
      if (!q) h.prompts = new Prompts();
      q?.close();
      this.set(h, { starting: false, live: false, running: false, error: messageOf(e) });
    }
    this.o.onChange?.();
  }

  /** one loop for the whole life of the query. leaving a for-await would close it */
  private async pump(h: Hosted, q: Query): Promise<void> {
    try {
      for await (const m of q) this.take(h, m);
    } catch (e) {
      if (h.q === q) this.set(h, { error: messageOf(e) });
    }
    if (h.q !== q) return;
    // the process is gone: what it was asked dies with it, and the next send starts another
    h.q = undefined;
    h.prompts = new Prompts();
    for (const w of h.waiting.values()) w.resolve({ behavior: "deny", message: "Stopped." });
    h.waiting.clear();
    h.text = "";
    h.dirty = 0;
    // its agents ran inside it
    for (const a of h.agents.values()) {
      if (a.state === "running") h.agents.set(a.id, { ...a, state: "stopped", ended: this.now() });
    }
    const after = h.afterTurn.splice(0);
    this.set(h, {
      live: false,
      starting: false,
      running: false,
      since: undefined,
      asks: [],
      tool: undefined,
      activity: undefined,
      thinking: undefined,
      queued: [],
      agents: [...h.agents.values()],
      rev: h.status.rev + 1,
    });
    this.flushNow(h);
    this.o.onChange?.();
    for (const run of after) run();
  }

  private take(h: Hosted, m: SDKMessage): void {
    h.lastActive = this.now();
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          // every turn starts with one, a turn claude code started itself too: a queued message, a
          // background task that finished
          this.turnStarted(h);
          this.set(h, {
            mode: asMode(m.permissionMode) ?? h.status.mode,
            model: modelFor(h.status, m.model),
          });
        } else if (m.subtype === "commands_changed") {
          h.commands = commandsOf(m.commands);
        } else if (m.subtype === "status") {
          const mode = asMode(m.permissionMode);
          if (mode && mode !== h.status.mode) this.set(h, { mode });
          if (m.status === "compacting") this.set(h, { activity: "Compacting the conversation" });
          else if (h.status.activity) this.set(h, { activity: undefined });
        } else if (m.subtype === "api_retry") {
          this.set(h, { activity: retryLine(m) });
        } else if (m.subtype === "permission_denied") {
          // turned down without asking (don't ask, auto): nothing would say so otherwise
          const why = firstSentence(m.decision_reason || m.message, 200);
          this.note(h, {
            kind: "denied",
            text: `${toolLabel(m.tool_name)} was turned down. ${why}`,
          });
        } else if (m.subtype === "local_command_output") {
          this.note(h, { kind: "output", text: cut(m.content, 8000) });
        } else if (m.subtype === "informational") {
          // 'info' is for a transcript view, not a chat
          if (m.level !== "info") this.note(h, { kind: "info", text: cut(m.content, 2000) });
        } else if (
          m.subtype === "task_started" ||
          m.subtype === "task_progress" ||
          m.subtype === "task_updated" ||
          m.subtype === "task_notification" ||
          m.subtype === "background_tasks_changed"
        ) {
          this.task(h, m);
        }
        return;
      case "conversation_reset": {
        // /clear: this claude goes on as a new session. what the window shows moves with it
        if (m.new_conversation_id === h.id) return;
        const from = h.id;
        this.hosted.delete(from);
        h.id = m.new_conversation_id;
        this.hosted.set(h.id, h);
        this.set(h, { notes: [], rev: h.status.rev + 1 });
        this.o.onReset?.(from, h.id, { ...h.where, fresh: true });
        this.o.onChange?.();
        return;
      }
      case "stream_event": {
        // a subagent's stream is its own. the turn's own answer is what the window draws
        if (m.parent_tool_use_id) return;
        this.turnStarted(h);
        // something is coming back: a retry or a compaction is over
        if (h.status.activity) this.set(h, { activity: undefined });
        const ev = m.event;
        if (ev.type === "content_block_start") {
          if (ev.content_block.type === "thinking" && !h.status.thinking) {
            this.set(h, { thinking: { since: this.now() } });
          }
          if (ev.content_block.type === "text") this.setText(h, "");
          else if (ev.content_block.type === "tool_use")
            this.set(h, { tool: { name: ev.content_block.name, since: this.now() } });
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          this.setText(h, h.text + ev.delta.text);
        }
        return;
      }
      case "assistant": {
        // a whole message: it is in the transcript now
        if (m.parent_tool_use_id) return;
        this.setText(h, "");
        // a call's input is whole once its block is: what it acts on, for the live line
        const call = m.message.content.findLast((b) => b.type === "tool_use");
        const tool =
          call?.type === "tool_use"
            ? {
                name: call.name,
                target: toolTarget(call.name, call.input, h.where.cwd, os.homedir()),
                since: h.status.tool?.name === call.name ? h.status.tool.since : this.now(),
              }
            : h.status.tool;
        // a thinking block is whole: it is in the transcript, and the turn's thinking row has it
        const thought = m.message.content.some((b) => b.type === "thinking");
        this.set(h, {
          tool,
          ...(thought ? { thinking: undefined } : {}),
          rev: h.status.rev + 1,
        });
        return;
      }
      case "user":
        if (m.parent_tool_use_id) return;
        this.set(h, { tool: undefined, rev: h.status.rev + 1 });
        return;
      case "result": {
        // an interrupt ends like this too, as error_during_execution: it is still a turn's end.
        // the sdk keeps claude's own idle/running states to itself, so this is the end
        this.setText(h, "");
        this.set(h, {
          running: false,
          since: undefined,
          tool: undefined,
          activity: undefined,
          thinking: undefined,
          queued: [],
          rev: h.status.rev + 1,
        });
        this.o.onChange?.();
        for (const run of h.afterTurn.splice(0)) run();
        void this.contextUsage(h);
        return;
      }
    }
  }

  /**
   * how full the conversation is, from claude's own count: the summary answers from the last
   * response's usage in ~30ms (probe) with no token-count call. a turn's result usage can't be used:
   * it is summed over every request of the turn
   */
  private async contextUsage(h: Hosted): Promise<void> {
    const u = await h.q?.getContextUsage({ detail: "summary" }).catch(() => undefined);
    if (typeof u?.totalTokens !== "number") return;
    const limit = u.autoCompactThreshold ?? u.maxTokens;
    if (typeof limit === "number" && limit > 0)
      this.set(h, { context: { used: u.totalTokens, limit } });
  }

  /** a line of what claude said along the way, under the turn. the last few */
  private note(h: Hosted, n: ChatNote): void {
    this.set(h, { notes: [...(h.status.notes ?? []), n].slice(-NOTES_MAX) });
  }

  /**
   * a subagent's life, from the task frames: started, its progress line, its end. a task id is
   * its agent id (probe). only agents: a Bash is a step of the turn, not a task to list
   */
  private task(
    h: Hosted,
    m: Extract<
      SDKMessage,
      {
        subtype:
          | "task_started"
          | "task_progress"
          | "task_updated"
          | "task_notification"
          | "background_tasks_changed";
      }
    >,
  ): void {
    const now = this.now();
    const put = (a: ChatAgent) => h.agents.set(a.id, a);
    /** a workflow's end is its running agents' too: no progress snapshot comes after a stop (probe) */
    const end = (a: ChatAgent, state: ChatAgent["state"]) => {
      put({ ...a, state, ended: a.ended ?? now });
      if (a.kind !== "workflow") return;
      for (const c of h.agents.values()) {
        if (c.workflow === a.id && c.state === "running")
          put({ ...c, state: state === "done" ? "done" : "stopped", ended: now });
      }
    };
    if (m.subtype === "task_started") {
      // a Workflow is one task: its agents only show in its progress frames
      const workflow = m.task_type === "local_workflow";
      if (m.task_type !== "local_agent" && !workflow) return;
      put({
        id: m.task_id,
        description: m.description || m.workflow_name || "Workflow",
        ...(m.subagent_type ? { agentType: m.subagent_type } : {}),
        ...(m.tool_use_id ? { toolUseId: m.tool_use_id } : {}),
        ...(m.is_backgrounded || workflow ? { background: true } : {}),
        ...(workflow ? { kind: "workflow" as const } : {}),
        state: "running",
        since: now,
      });
    } else if (m.subtype === "background_tasks_changed") {
      // every live background task, whole: one this process started before it heard of it is
      // added, one it still thought running and is not in the set any more is over
      const live = new Set(m.tasks.map((t) => t.task_id));
      for (const t of m.tasks) {
        const workflow = t.task_type === "local_workflow";
        if ((t.task_type === "local_agent" || workflow) && !h.agents.has(t.task_id)) {
          put({
            id: t.task_id,
            description: t.description,
            ...(t.subagent_type ? { agentType: t.subagent_type } : {}),
            ...(workflow ? { kind: "workflow" as const, background: true } : {}),
            state: "running",
            since: now,
          });
        }
      }
      for (const a of h.agents.values()) {
        if (a.state === "running" && a.background && !live.has(a.id)) end(a, "done");
      }
    } else {
      const a = h.agents.get(m.task_id);
      if (!a) return;
      if (m.subtype === "task_progress") {
        if (a.kind === "workflow") {
          const progress = (m as { workflow_progress?: unknown }).workflow_progress;
          for (const c of workflowAgents(a.id, progress, h.agents, now)) put(c);
        } else put({ ...a, step: m.summary || m.description });
      } else if (m.subtype === "task_updated") {
        const state = TASK_STATE[m.patch.status ?? ""];
        if (m.patch.is_backgrounded !== undefined)
          put({ ...a, background: m.patch.is_backgrounded });
        if (state) end(h.agents.get(a.id) ?? a, state);
      } else {
        end(a, TASK_STATE[m.status] ?? "done");
      }
    }
    this.set(h, { agents: [...h.agents.values()] });
  }

  /**
   * effort and ultracode as claude applies them. no frame announces a change and an apply's ack
   * can't be trusted, so this is read again after every apply and every model change. getSettings
   * is in the sdk at runtime but not in its types
   */
  private async settings(h: Hosted): Promise<void> {
    const q = h.q as (Query & { getSettings?: () => Promise<{ applied?: Applied }> }) | undefined;
    const a = (await q?.getSettings?.().catch(() => undefined))?.applied;
    if (!a) return;
    this.set(h, {
      // the model it is on before a turn has said so
      ...(typeof a.model === "string" && a.model ? { model: modelFor(h.status, a.model) } : {}),
      effort: typeof a.effort === "string" ? a.effort : undefined,
      ultracode: a.ultracode === true,
      ultracodeAvailable: a.ultracodeAvailable === true,
    });
  }

  private turnStarted(h: Hosted): void {
    if (h.status.running) return;
    this.set(h, { running: true, since: this.now() });
    this.o.onChange?.();
  }

  private ask(
    h: Hosted,
    tool: string,
    input: Record<string, unknown>,
    opts: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const id = randomUUID();
    const view: ChatAsk =
      tool === "AskUserQuestion"
        ? { id, kind: "question", questions: questionsOf(input) }
        : tool === "ExitPlanMode"
          ? { id, kind: "plan", plan: typeof input.plan === "string" ? input.plan : "" }
          : {
              id,
              kind: "permission",
              tool,
              ...(opts.title ? { title: opts.title } : {}),
              detail: detailOf(input),
              canAlways: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
              // a subagent's call: the card names which one
              ...(opts.agentID
                ? { agent: h.agents.get(opts.agentID)?.description ?? "An agent" }
                : {}),
            };
    return new Promise<PermissionResult>((resolve) => {
      h.waiting.set(id, { input, suggestions: opts.suggestions, resolve });
      this.set(h, { asks: [...h.status.asks, view] });
      // Claude Code took the question back: an interrupt, the turn moved on
      opts.signal.addEventListener("abort", () =>
        this.settle(h, id, { behavior: "deny", message: "Cancelled." }),
      );
    });
  }

  private settle(h: Hosted, askId: string, result: PermissionResult): void {
    const w = h.waiting.get(askId);
    if (!w) return;
    h.waiting.delete(askId);
    this.set(h, { asks: h.status.asks.filter((a) => a.id !== askId) });
    w.resolve(result);
  }

  private set(h: Hosted, patch: Partial<ChatStatus>): void {
    h.status = { ...h.status, ...patch };
    for (const w of h.windows) this.deliver(h, w, "grove:chat:status", h.status);
    this.o.onStatus?.(h.id, h.status);
  }

  private setText(h: Hosted, text: string): void {
    if (text === h.text) return;
    const from = text.startsWith(h.text) ? h.text.length : 0;
    h.text = text;
    h.dirty = Math.min(h.dirty ?? from, from);
    h.flush ??= setTimeout(() => this.flushNow(h), FLUSH_MS);
  }

  private flushNow(h: Hosted): void {
    if (h.flush) clearTimeout(h.flush);
    h.flush = undefined;
    if (h.dirty === null) return;
    const at = Math.min(h.dirty, h.text.length);
    h.dirty = null;
    for (const w of h.windows) {
      this.deliver(h, w, "grove:chat:text", { at, text: h.text.slice(at) });
    }
  }

  private deliver(h: Hosted, w: PushTarget, channel: string, payload: unknown): void {
    if (w.isDestroyed()) {
      h.windows.delete(w);
      return;
    }
    try {
      w.send(channel, payload);
    } catch {
      // the window went away between the check and the send
    }
  }
}
