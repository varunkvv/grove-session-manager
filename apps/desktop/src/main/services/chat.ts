// grove chat's host: one claude per session grove runs itself, through the agent sdk, kept in main
// so it outlives the window it was opened from. no electron import: a window is a PushTarget.
import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
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
import type {
  ChatAnswer,
  ChatAsk,
  ChatAttachment,
  ChatCommand,
  ChatMode,
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
        commands: [],
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
        } else if (m.subtype === "commands_changed") {
          h.commands = commandsOf(m.commands);
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
      ...(typeof a.model === "string" && a.model ? { model: a.model } : {}),
      effort: typeof a.effort === "string" ? a.effort : undefined,
      ultracode: a.ultracode === true,
      ultracodeAvailable: a.ultracodeAvailable === true,
    });
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
