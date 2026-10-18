// grove chat's host: one claude per session grove runs itself, through the agent sdk, kept in main
// so it outlives the window it was opened from. no electron import: a window is a PushTarget.
import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChatAnswer, ChatAsk, ChatMode, ChatQuestion, ChatStatus } from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";
import type { PushTarget } from "../push.ts";

/** an idle session with no window open is let go after this. the next send resumes it */
export const REAP_MS = 10 * 60_000;
/** the streamed answer goes to the window at most this often */
const FLUSH_MS = 50;
/** a permission's input, as the card shows it */
const DETAIL_MAX = 2000;

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
}

export interface ChatHostOptions {
  claudeBin: () => Promise<string>;
  env: () => Promise<NodeJS.ProcessEnv>;
  /** a process came or went, or a turn started or ended: rows say where a session runs */
  onChange?: () => void;
  now?: () => number;
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

  push(text: string): void {
    this.queue.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
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
        options: options.flatMap((x) =>
          x && typeof x === "object" && typeof (x as { label?: unknown }).label === "string"
            ? [
                {
                  label: (x as { label: string }).label,
                  description: String((x as { description?: unknown }).description ?? ""),
                },
              ]
            : [],
        ),
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

  /** a window shows this session from now on. what it needs to catch up is `status` and `text` */
  attach(id: string, target: PushTarget): void {
    this.entry(id).windows.add(target);
  }

  detach(id: string, target: PushTarget): void {
    const h = this.hosted.get(id);
    if (!h) return;
    h.windows.delete(target);
    h.lastActive = this.now();
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
  async send(id: string, where: ChatWhere, text: string): Promise<void> {
    const h = this.entry(id, where);
    const queued = h.status.running;
    h.prompts.push(text);
    if (queued) this.set(h, { queued: [...h.status.queued, text] });
    else this.turnStarted(h);
    await this.warm(id, where);
    if (!h.status.live) throw new Error(h.status.error ?? "Claude did not start.");
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
  }

  answer(id: string, askId: string, a: ChatAnswer): void {
    const h = this.hosted.get(id);
    const w = h?.waiting.get(askId);
    if (!h || !w) throw new Error("That question has already been answered.");
    const ask = h.status.asks.find((x) => x.id === askId);
    if (ask?.kind !== a.kind) throw new Error("That answer is for another kind of question.");
    let result: PermissionResult;
    if (a.kind === "question") {
      result = { behavior: "allow", updatedInput: { ...w.input, answers: a.answers } };
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
    h.q.close();
    await h.ended;
  }

  dispose(): void {
    clearInterval(this.reaper);
    for (const h of this.hosted.values()) h.q?.close();
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
      const [bin, env] = await Promise.all([this.o.claudeBin(), this.o.env()]);
      q = query({
        prompt: h.prompts,
        options: {
          pathToClaudeCodeExecutable: bin,
          cwd: h.where.cwd,
          additionalDirectories: h.where.dirs,
          resume: h.id,
          // CLAUDE.md, skills, hooks and the project's settings, as everywhere else. no mode: the
          // settings' defaultMode decides, as it does in the terminal
          settingSources: ["user", "project", "local"],
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
      this.set(h, {
        live: true,
        starting: false,
        mode,
        modes: modesFor(mode),
        models: (init.models ?? []).map((m) => ({
          value: m.value,
          label: m.displayName,
          ...(m.resolvedModel ? { id: m.resolvedModel } : {}),
        })),
      });
    } catch (e) {
      log.warn(`chat ${h.id.slice(0, 8)} did not start:`, e);
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
    const after = h.afterTurn.splice(0);
    this.set(h, {
      live: false,
      starting: false,
      running: false,
      asks: [],
      tool: undefined,
      queued: [],
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
          this.set(h, { mode: asMode(m.permissionMode) ?? h.status.mode, model: m.model });
        } else if (m.subtype === "status") {
          const mode = asMode(m.permissionMode);
          if (mode && mode !== h.status.mode) this.set(h, { mode });
        }
        return;
      case "stream_event": {
        // a subagent's stream is its own. the turn's own answer is what the window draws
        if (m.parent_tool_use_id) return;
        this.turnStarted(h);
        const ev = m.event;
        if (ev.type === "content_block_start") {
          if (ev.content_block.type === "text") this.setText(h, "");
          else if (ev.content_block.type === "tool_use")
            this.set(h, { tool: ev.content_block.name });
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          this.setText(h, h.text + ev.delta.text);
        }
        return;
      }
      case "assistant":
        // a whole message: it is in the transcript now
        if (m.parent_tool_use_id) return;
        this.setText(h, "");
        this.set(h, { rev: h.status.rev + 1 });
        return;
      case "user":
        if (m.parent_tool_use_id) return;
        this.set(h, { tool: undefined, rev: h.status.rev + 1 });
        return;
      case "result": {
        // an interrupt ends like this too, as error_during_execution: it is still a turn's end.
        // the sdk keeps claude's own idle/running states to itself, so this is the end
        this.setText(h, "");
        this.set(h, { running: false, tool: undefined, queued: [], rev: h.status.rev + 1 });
        this.o.onChange?.();
        for (const run of h.afterTurn.splice(0)) run();
        return;
      }
    }
  }

  private turnStarted(h: Hosted): void {
    if (h.status.running) return;
    this.set(h, { running: true });
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
