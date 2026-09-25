// a session's own conversation, folded out of its transcript line by line: turns of a prompt,
// the work, and the answer. no node: imports - reading the file is conversationFile.ts.
//
// the work of a turn is folded exactly like an agent's life (TimelineFold): the same steps, the
// same pairing of calls and results, the same rule for what the final message is. what this adds
// is where a turn starts and ends, and the few things that are the conversation rather than the
// work: a plan it proposed, a question it asked, what the person said while it worked.
import { cleanBlockText, extractCommand } from "../transcript/prompt.ts";
import { squash } from "../transcript/title.ts";
import {
  emptyTimelineState,
  type FoldOptions,
  type LineRef,
  resultText,
  TimelineFold,
  type TimelineState,
} from "./timeline.ts";

/** bumped when the folded shape changes, so a cached conversation from an older build is not trusted */
export const CONVERSATION_VERSION = 1;

/** what a conversation's steps keep. the view never shows a step's input or result preview. */
const TURN_FOLD: FoldOptions = { inputPreview: 0, resultPreview: 0, promptless: true };
/** a prompt is what a person typed. past this it is a pasted file, and the rest is on disk. */
const PROMPT_MAX = 50_000;
/** a plan is read, so it is kept whole - up to this */
const PLAN_MAX = 50_000;
/** what Claude Code wrote to carry a compacted session on */
const SUMMARY_MAX = 20_000;
/** a command's output: `/mcp` says a line, `/context` a table */
const OUTPUT_MAX = 8_000;
const INTERRUPTED = "[Request interrupted";

/** where a turn came from */
export interface Prompt {
  /** a person typed it, a slash command, or Claude Code saying a background task finished */
  kind: "human" | "command" | "task";
  /** what they typed, `/mcp args`, or the task's summary */
  text: string;
  at: number;
  /** images pasted with it. counted, never decoded. */
  images?: number;
  /** it was typed in plan mode */
  plan?: boolean;
  /** a task notification's status: completed, failed, killed... */
  status?: string;
}

export interface Question {
  header?: string;
  question: string;
  options: string[];
  /** what the person picked, or typed instead */
  picked?: string;
}

/**
 * the parts of a turn that are the conversation, not the work. each sits at a step of the work -
 * `step` is where it goes when the work is open - and all of them show when it is closed.
 */
export type Mark =
  | {
      kind: "plan";
      step: number;
      at: number;
      /** markdown */
      text: string;
      outcome?: "approved" | "rejected";
      /** what the person said back when they turned it down */
      said?: string;
    }
  | { kind: "question"; step: number; at: number; questions: Question[]; declined?: boolean }
  /** something the person typed while it worked. Claude Code hands it over mid-turn. */
  | { kind: "said"; step: number; at: number; text: string; images?: number };

export interface Turn {
  kind: "turn";
  /** absent when the turn goes on after a compaction: the work carried on with nobody asking */
  prompt?: Prompt;
  /** the steps, the final message, the tokens: the same fold as an agent's */
  work: TimelineState;
  marks: Mark[];
  /** a command's output */
  output?: string;
  /** the last api error of a run of retries nothing came after */
  apiError?: string;
  /** Claude Code's own measure of the turn, where it writes one */
  durationMs?: number;
}

/** a compaction: everything before it was summarised into what came after */
export interface Divider {
  kind: "compact";
  at: number;
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  /** the summary Claude Code carried on with */
  summary?: string;
}

export type ConversationItem = Turn | Divider;

/** everything the fold keeps between reads. plain data: it is cached as json. */
export interface ConversationState {
  version: number;
  /** bytes of whole lines read so far. the next read starts here. */
  offset: number;
  items: ConversationItem[];
  /**
   * every uuid folded. after a compaction Claude Code writes part of the conversation again with
   * the same uuids, and a copy is not something that happened twice.
   */
  seen: string[];
  startedAt?: number;
  lastAt?: number;
}

export function emptyConversationState(): ConversationState {
  return { version: CONVERSATION_VERSION, offset: 0, items: [], seen: [] };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function blocksOf(content: unknown): unknown[] {
  return Array.isArray(content) ? content : typeof content === "string" ? [content] : [];
}

function textOf(content: unknown): string {
  return blocksOf(content)
    .map((b) => (typeof b === "string" ? b : isObject(b) && b.type === "text" ? str(b.text) : ""))
    .filter(Boolean)
    .join("\n");
}

function imagesIn(content: unknown): number {
  return blocksOf(content).filter((b) => isObject(b) && b.type === "image").length;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
const unentity = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1] : undefined;
}

/**
 * what a person typed, the way they typed it: every block without the editor's context Claude
 * Code puts in front (`<ide_opened_file>`, `<ide_selection>`) or the reminders it wraps around.
 * a prompt that was nothing but that context still started a turn, so it keeps what it said.
 */
function typed(content: unknown): string {
  const kept: string[] = [];
  for (const b of blocksOf(content)) {
    const text = typeof b === "string" ? b : isObject(b) && b.type === "text" ? str(b.text) : "";
    const clean = text ? cleanBlockText(text) : null;
    if (clean) kept.push(clean);
  }
  if (kept.length > 0) return cut(kept.join("\n\n"), PROMPT_MAX);
  return squash(
    textOf(content)
      .replace(/<[^>]+>/g, " ")
      .trim(),
    300,
  );
}

/** a command's output without the envelope Claude Code wraps it in, or its terminal colours */
function commandOutput(text: string): string | undefined {
  const out = tag(text, "local-command-stdout") ?? tag(text, "local-command-stderr");
  if (out === undefined) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes are the point
  return cut(out.replace(/\u001b\[[0-9;]*m/g, "").trim(), OUTPUT_MAX);
}

/** the person's words out of a turned-down tool call: "…the reason for the rejection: <words>" */
function rejectionWords(text: string): string | undefined {
  const m = /(?:reason for the rejection:|the user said:)\s*([\s\S]+)$/.exec(text);
  const said = m?.[1]?.trim();
  return said ? cut(said, PROMPT_MAX) : undefined;
}

/** the questions of an AskUserQuestion call, from its input */
export function questionsOf(input: unknown): Question[] {
  if (!isObject(input) || !Array.isArray(input.questions)) return [];
  return input.questions.flatMap((q): Question[] => {
    if (!isObject(q) || typeof q.question !== "string") return [];
    const options = Array.isArray(q.options)
      ? q.options.flatMap((o) =>
          isObject(o) && typeof o.label === "string" ? [o.label] : typeof o === "string" ? [o] : [],
        )
      : [];
    return [
      {
        question: q.question,
        options,
        ...(typeof q.header === "string" && q.header ? { header: q.header } : {}),
      },
    ];
  });
}

/**
 * the picks, in the order the questions were asked. `answers` is keyed by the question's text;
 * when a key does not match exactly (it was edited, or cut), the answer at the same position is
 * the one that belongs to it.
 */
export function withPicks(questions: Question[], answers: unknown): Question[] {
  if (!isObject(answers)) return questions;
  const values = Object.values(answers);
  return questions.map((q, i) => {
    const byText = answers[q.question];
    const picked = typeof byText === "string" ? byText : values[i];
    if (typeof picked === "string" && picked) return { ...q, picked };
    if (Array.isArray(picked)) return { ...q, picked: picked.filter(Boolean).join(", ") };
    return q;
  });
}

export interface ConversationFoldOptions {
  home?: string;
}

/**
 * folds a session's transcript lines into turns, in place. an item is replaced, never changed, so
 * an item that did not change is the same object before and after a read - that is how a tail
 * finds the first turn worth sending again. inside a turn the same holds for its steps.
 */
export class ConversationFold {
  readonly state: ConversationState;
  private readonly foldOpts: FoldOptions;
  private readonly seen: Set<string>;
  /** the turns this read has copied, and the fold writing each one's work */
  private readonly open = new Map<number, TimelineFold>();
  /** tool_use id -> the item that made the call, while its result has not come back */
  private readonly pending = new Map<string, number>();

  constructor(
    state: ConversationState = emptyConversationState(),
    opts: ConversationFoldOptions = {},
  ) {
    // the arrays are copied and the items shared: the caller's copy must not see a change
    this.state = { ...state, items: [...state.items], seen: [...state.seen] };
    this.seen = new Set(state.seen);
    this.foldOpts = { ...TURN_FOLD, ...(opts.home ? { home: opts.home } : {}) };
    state.items.forEach((item, i) => {
      if (item.kind !== "turn") return;
      for (const s of item.work.steps) {
        if (s.kind === "tool" && s.durationMs === undefined && !s.ref) this.pending.set(s.id, i);
      }
    });
  }

  /** one whole line, and where it sits in the file */
  line(text: string, offset: number, length: number): void {
    if (text.charCodeAt(0) !== 0x7b) return;
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      // a torn or junk line. the rest of the file still counts.
      return;
    }
    if (!isObject(entry)) return;
    const type = entry.type;
    const queued =
      type === "attachment" &&
      isObject(entry.attachment) &&
      entry.attachment.type === "queued_command";
    if (type !== "user" && type !== "assistant" && type !== "system" && !queued) return;
    const uuid = str(entry.uuid);
    if (uuid) {
      if (this.seen.has(uuid)) return;
      this.seen.add(uuid);
      this.state.seen.push(uuid);
    }
    const s = this.state;
    const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isFinite(parsed)) {
      s.startedAt ??= parsed;
      // a copy Claude Code wrote again carries the time of the original: the clock never goes back
      s.lastAt = Math.max(s.lastAt ?? parsed, parsed);
    }
    const at = Number.isFinite(parsed) ? parsed : (s.lastAt ?? 0);
    const line = { offset, length };
    if (type === "assistant") this.assistant(entry, line);
    else if (type === "user") this.user(entry, at, line);
    else if (type === "system") this.system(entry, at);
    else if (queued) this.queued(entry.attachment as Record<string, unknown>, at);
  }

  /** the turn at `i`, copied for this read the first time it is touched */
  private thaw(i: number): { turn: Turn; fold: TimelineFold } | null {
    const item = this.state.items[i];
    if (item?.kind !== "turn") return null;
    let fold = this.open.get(i);
    if (!fold) {
      fold = new TimelineFold(item.work, this.foldOpts);
      this.open.set(i, fold);
      this.state.items[i] = { ...item, marks: [...item.marks], work: fold.state };
    }
    return { turn: this.state.items[i] as Turn, fold };
  }

  /** the turn still being written to, if the last thing is one */
  private current(): { turn: Turn; fold: TimelineFold } | null {
    return this.thaw(this.state.items.length - 1);
  }

  private startTurn(prompt?: Prompt): { turn: Turn; fold: TimelineFold } {
    const turn: Turn = { kind: "turn", work: emptyTimelineState(), marks: [] };
    if (prompt) turn.prompt = prompt;
    this.state.items.push(turn);
    return this.thaw(this.state.items.length - 1) as { turn: Turn; fold: TimelineFold };
  }

  private assistant(entry: Record<string, unknown>, line: LineRef): void {
    const message = entry.message;
    if (!isObject(message)) return;
    // work with nobody asking: the start of a file, or the turn going on after a compaction
    const { turn, fold } = this.current() ?? this.startTurn();
    const index = this.state.items.length - 1;
    const content = Array.isArray(message.content) ? message.content : [];
    const from = fold.state.steps.length;
    fold.entry(entry, line.offset, line.length);
    // something came after the error, so the retry worked and the error was noise
    if (turn.apiError && str(message.model) !== "<synthetic>" && entry.isApiErrorMessage !== true) {
      delete turn.apiError;
    }
    for (let i = from; i < fold.state.steps.length; i++) {
      const step = fold.state.steps[i];
      if (step?.kind !== "tool" || step.server) continue;
      this.pending.set(step.id, index);
      if (step.name !== "ExitPlanMode" && step.name !== "AskUserQuestion") continue;
      const block = content.find((b) => isObject(b) && b.id === step.id);
      const input = isObject(block) ? block.input : undefined;
      if (step.name === "ExitPlanMode") {
        const plan = isObject(input) ? str(input.plan) : undefined;
        if (plan?.trim()) {
          turn.marks.push({ kind: "plan", step: i, at: step.at, text: cut(plan, PLAN_MAX) });
        }
      } else {
        const questions = questionsOf(input);
        if (questions.length)
          turn.marks.push({ kind: "question", step: i, at: step.at, questions });
      }
    }
  }

  private user(entry: Record<string, unknown>, at: number, line: LineRef): void {
    const message = entry.message;
    if (!isObject(message)) return;
    const content = message.content;
    if (Array.isArray(content) && content.some((b) => isObject(b) && b.type === "tool_result")) {
      this.results(entry, content, line);
      return;
    }
    const origin = isObject(entry.origin) ? str(entry.origin.kind) : undefined;
    if (entry.isCompactSummary === true) {
      const last = this.state.items.at(-1);
      if (last?.kind === "compact" && last.summary === undefined) {
        this.state.items[this.state.items.length - 1] = {
          ...last,
          summary: cut(textOf(content).trim(), SUMMARY_MAX),
        };
      }
      return;
    }
    const text = textOf(content).trim();
    if (text.startsWith(INTERRUPTED)) {
      this.current()?.fold.entry(entry, line.offset, line.length);
      return;
    }
    // Claude Code talking to itself: a command's expansion, a caveat, image sizes, a nudge
    if (entry.isMeta === true) return;
    if (text.includes("<command-name>")) {
      const command = extractCommand(entry) ?? "/command";
      this.startTurn({ kind: "command", text: command, at });
      return;
    }
    const output = commandOutput(text);
    if (output !== undefined) {
      this.commandOutput(output);
      return;
    }
    if (origin === "task-notification" || text.startsWith("<task-notification>")) {
      const summary = tag(text, "summary");
      const status = tag(text, "status")?.trim();
      this.startTurn({
        kind: "task",
        text: squash(unentity(summary ?? "a background task finished"), 500),
        at,
        ...(status ? { status } : {}),
      });
      return;
    }
    const images = imagesIn(content);
    const said = typed(content);
    if (!said && images === 0) return;
    this.startTurn({
      kind: "human",
      text: said,
      at,
      ...(images ? { images } : {}),
      ...(entry.permissionMode === "plan" ? { plan: true } : {}),
    });
  }

  private commandOutput(output: string): void {
    const open = this.current();
    if (open?.turn.prompt?.kind !== "command" || open.turn.output !== undefined) return;
    open.turn.output = output;
  }

  /** tool results go to the turn that made the call, which is nearly always the open one */
  private results(entry: Record<string, unknown>, content: unknown[], line: LineRef): void {
    const ids = content.flatMap((b) =>
      isObject(b) && b.type === "tool_result" && typeof b.tool_use_id === "string"
        ? [b.tool_use_id]
        : [],
    );
    const index = ids.map((id) => this.pending.get(id)).find((i) => i !== undefined);
    const open = index !== undefined ? this.thaw(index) : this.current();
    if (!open) return;
    for (const id of ids) this.pending.delete(id);
    open.fold.entry(entry, line.offset, line.length);
    // what a plan and a question came back with: the person's answer
    const told = entry.toolUseResult;
    for (const b of content) {
      if (!isObject(b) || b.type !== "tool_result") continue;
      const i = open.turn.marks.findIndex(
        (m) =>
          (m.kind === "plan" || m.kind === "question") &&
          open.turn.work.steps[m.step]?.kind === "tool" &&
          (open.turn.work.steps[m.step] as { id: string }).id === b.tool_use_id,
      );
      const mark = open.turn.marks[i];
      if (!mark) continue;
      const text = resultText(b.content);
      if (mark.kind === "plan") {
        const said = b.is_error === true ? rejectionWords(text) : undefined;
        open.turn.marks[i] = {
          ...mark,
          outcome: b.is_error === true ? "rejected" : "approved",
          ...(said ? { said } : {}),
        };
      } else if (mark.kind === "question") {
        open.turn.marks[i] =
          b.is_error === true
            ? { ...mark, declined: true }
            : {
                ...mark,
                questions: withPicks(mark.questions, isObject(told) ? told.answers : undefined),
              };
      }
    }
  }

  private system(entry: Record<string, unknown>, at: number): void {
    switch (entry.subtype) {
      case "compact_boundary": {
        const meta = isObject(entry.compactMetadata) ? entry.compactMetadata : {};
        const divider: Divider = { kind: "compact", at };
        const trigger = str(meta.trigger);
        if (trigger) divider.trigger = trigger;
        const pre = num(meta.preTokens);
        if (pre !== undefined) divider.preTokens = pre;
        const post = num(meta.postTokens);
        if (post !== undefined) divider.postTokens = post;
        this.state.items.push(divider);
        return;
      }
      case "local_command": {
        const output = commandOutput(str(entry.content) ?? "");
        if (output !== undefined) this.commandOutput(output);
        return;
      }
      case "api_error": {
        const open = this.current();
        if (!open) return;
        const error = isObject(entry.error) ? entry.error : {};
        const said = str(error.formatted) ?? str(error.message) ?? "API error";
        const attempt = num(entry.retryAttempt);
        const max = num(entry.maxRetries);
        open.turn.apiError =
          attempt !== undefined && max !== undefined
            ? `${said} · retry ${attempt} of ${max}`
            : said;
        return;
      }
      case "turn_duration": {
        const open = this.current();
        const ms = num(entry.durationMs);
        if (open && ms !== undefined) open.turn.durationMs = ms;
        return;
      }
    }
  }

  /** something typed or delivered while it worked. only what a person typed is the conversation. */
  private queued(attachment: Record<string, unknown>, at: number): void {
    if (attachment.commandMode !== "prompt") return;
    const open = this.current();
    if (!open) return;
    const text = typed(attachment.prompt);
    const images = imagesIn(attachment.prompt);
    if (!text && images === 0) return;
    // the prompt sent twice (a double submit): the second copy is not something else they said
    if (open.turn.prompt?.kind === "human" && open.turn.prompt.text === text) return;
    open.turn.marks.push({
      kind: "said",
      step: open.turn.work.steps.length,
      at,
      text,
      ...(images ? { images } : {}),
    });
  }
}

/** the steps a turn's answer is: every text block of a final message that calls no tool */
export function answerSteps(work: TimelineState): number[] {
  const last = work.last;
  return last && !last.tool && !last.error ? last.texts : [];
}

/** the tools that change a file. a run of edits to one file is one file edited. */
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export interface TurnNumbers {
  /** tool calls. the advisor runs on the api side and is not one. */
  tools: number;
  filesEdited: number;
  agents: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

/** the numbers on a turn's work line */
export function turnNumbers(turn: Turn): TurnNumbers {
  const files = new Set<string>();
  let agents = 0;
  for (const s of turn.work.steps) {
    if (s.kind !== "tool" || s.server) continue;
    if (EDITS.has(s.name) && s.target) files.add(s.target);
    if (s.name === "Agent" || s.name === "Task") agents++;
  }
  const startedAt = turn.prompt?.at ?? turn.work.startedAt;
  const endedAt = Math.max(turn.work.lastAt ?? 0, startedAt ?? 0) || undefined;
  const out: TurnNumbers = { tools: turn.work.toolCount, filesEdited: files.size, agents };
  if (startedAt !== undefined) out.startedAt = startedAt;
  if (endedAt !== undefined) out.endedAt = endedAt;
  const ms =
    turn.durationMs ??
    (startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined);
  if (ms !== undefined) out.durationMs = ms;
  return out;
}

export interface ConversationTotals {
  /** the model of the last real response */
  model?: string;
  /** the context the last response ran with */
  tokens: number;
  tools: number;
  turns: number;
  startedAt?: number;
  lastAt?: number;
}

export function conversationTotals(state: ConversationState): ConversationTotals {
  let model: string | undefined;
  let tokens = 0;
  let tools = 0;
  let turns = 0;
  for (const item of state.items) {
    if (item.kind !== "turn") continue;
    turns++;
    tools += item.work.toolCount;
    if (item.work.model) model = item.work.model;
    if (item.work.tokens > 0) tokens = item.work.tokens;
  }
  const out: ConversationTotals = { tokens, tools, turns };
  if (model) out.model = model;
  if (state.startedAt !== undefined) out.startedAt = state.startedAt;
  if (state.lastAt !== undefined) out.lastAt = state.lastAt;
  return out;
}
