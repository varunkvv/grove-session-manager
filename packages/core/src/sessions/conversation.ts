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

/** a message, whole: a 2,000-line report is ~150KB. the panel's view cuts it far shorter */
export const MESSAGE_MAX = 200_000;
/** what a conversation's steps keep. the view never shows a step's input or result preview. */
const TURN_FOLD: FoldOptions = {
  inputPreview: 0,
  resultPreview: 0,
  promptless: true,
  textMax: MESSAGE_MAX,
};
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
  /** the names of the files attached to it as documents (a pdf, a text file) */
  files?: string[];
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

/** everything the fold keeps between reads. plain data */
export interface ConversationState {
  /** bytes of whole lines read so far. the next read starts here. */
  offset: number;
  /**
   * where the newest line of the conversation ends: a user, assistant or typed-mid-turn line.
   * the file's size is not this. Claude Code appends bookkeeping long after a turn is over
   * (`last-prompt`, `cost-state`, hook results), so the size moves while nothing was said
   */
  end: number;
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
  return { offset: 0, end: 0, items: [], seen: [] };
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

/** the titles of the documents attached to a message: what grove chat and vs code name them */
function filesIn(content: unknown): string[] {
  return blocksOf(content).flatMap((b) =>
    isObject(b) && b.type === "document" ? [cut(str(b.title) || "a file", 200)] : [],
  );
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
    // a subagent's lines are its own transcript's
    if (entry.isSidechain === true) return;
    if (type !== "system") this.state.end = offset + length;
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
    // a command claude code answers itself (/context, /cost): its own words, as a command's output
    const said = textOf(content).trim();
    if (
      str(message.model) === "<synthetic>" &&
      entry.isApiErrorMessage !== true &&
      !said.startsWith("API Error") &&
      turn.output === undefined &&
      (turn.prompt?.kind === "command" || turn.prompt?.text.startsWith("/"))
    ) {
      turn.output = cut(said, OUTPUT_MAX);
    }
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
    const files = filesIn(content);
    const said = typed(content);
    if (!said && images === 0 && files.length === 0) return;
    this.startTurn({
      kind: "human",
      text: said,
      at,
      ...(images ? { images } : {}),
      ...(files.length ? { files } : {}),
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
    // a subagent's hand-back report is queued the same way, with `origin.kind: "peer"`
    if (isObject(attachment.origin) && attachment.origin.kind !== "human") return;
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

/** the message a turn ended on, whole. empty when it ended on a tool call, an error or nothing */
export function answerOf(work: TimelineState): string {
  return answerSteps(work)
    .flatMap((n) => {
      const step = work.steps[n];
      return step?.kind === "text" ? [step.text] : [];
    })
    .join("\n\n");
}

/** the tools that change a file. a run of edits to one file is one file edited. */
export const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** a diff shows this many lines, then says how many more */
const DIFF_MAX = 400;

/**
 * what an edit changed, as lines a diff draws by their first character: "+" added, "-" taken out,
 * " " around them, "@" where a hunk starts, "…" what was left out. from Claude Code's own patch
 * (`toolUseResult.structuredPatch`) when there is one, else from the call's input: a Write is all
 * added, an Edit its old and new strings. undefined for a tool that edits nothing
 */
export function editDiff(name: string, input: unknown, result?: unknown): string[] | undefined {
  if (!EDITS.has(name)) return undefined;
  const i = isObject(input) ? input : {};
  const r = isObject(result) ? result : {};
  const as = (text: unknown, mark: string) =>
    typeof text === "string"
      ? text
          .replace(/\n$/, "")
          .split("\n")
          .map((l) => mark + l)
      : [];
  let out: string[] = [];
  const patch = Array.isArray(r.structuredPatch) ? r.structuredPatch.filter(isObject) : [];
  if (patch.length) {
    for (const h of patch) {
      out.push(
        `@@ -${num(h.oldStart) ?? 0},${num(h.oldLines) ?? 0} +${num(h.newStart) ?? 0},${num(h.newLines) ?? 0} @@`,
      );
      if (Array.isArray(h.lines))
        out.push(...h.lines.filter((l): l is string => typeof l === "string"));
    }
  } else if (name === "Write") {
    out = as(r.content ?? i.content, "+");
  } else if (name === "Edit") {
    out = [...as(i.old_string, "-"), ...as(i.new_string, "+")];
  } else if (name === "MultiEdit" && Array.isArray(i.edits)) {
    out = i.edits
      .filter(isObject)
      .flatMap((e, n) => [
        ...(n ? ["@@"] : []),
        ...as(e.old_string, "-"),
        ...as(e.new_string, "+"),
      ]);
  } else if (name === "NotebookEdit") {
    out = as(i.new_source, "+");
  }
  return out.length > DIFF_MAX
    ? [...out.slice(0, DIFF_MAX), `… ${out.length - DIFF_MAX} more lines`]
    : out;
}

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

// ---------- what the page gets: the turns without the steps inside them

/** how many turns the page gets. the ones before them are in the editor */
export const VIEW_TURNS = 100;
/** a prompt keeps its start. a message keeps its end, where the question is */
const VIEW_PROMPT = 4000;
const VIEW_TEXT = 8000;
/** the last message is what the panel is for */
const VIEW_LAST_TEXT = 20_000;

export interface TurnView {
  kind: "turn";
  /** what started it. absent when the work carried on after a compaction */
  prompt?: { kind: Prompt["kind"]; text: string; images?: number; files?: string[] };
  /** what the person typed while it worked */
  said?: string[];
  /** tool calls, files edited, subagents started, and how long it took */
  tools: number;
  files: number;
  agents: number;
  ms?: number;
  /**
   * the message it ended on. markdown, and an agent's: untrusted. for the last turn, when it has
   * not ended on one, the last thing it said
   */
  text?: string;
  /** how it ended when not on a message: an interrupt, an api error */
  note?: string;
  /** files it wrote that can be looked at, and images it read: what a chat window shows a card for */
  outputs?: FileMark[];
  /**
   * a chat window's only: what the turn did before it answered, in order - its thinking, the
   * tools it ran, what it said between them. `stepsBefore`: older steps left out of a long turn
   */
  steps?: StepView[];
  stepsBefore?: number;
  /** a chat window's only: the thinking right before its answer, and how long it took */
  thought?: { text: string; ms?: number };
  /** a chat window's only: what a slash command answered, /context's table */
  output?: string;
  /** a chat window's only: Workflow runs it started. their agents are in the agents list */
  workflows?: number;
  /** a chat window's only: it ended on an api error (the note says which), so it can be asked again */
  failed?: boolean;
}

/** one step of a turn's work, as a chat window lists it */
export type StepView =
  | {
      kind: "tool";
      /** the tool_use id: an Agent call is the agent it started */
      id: string;
      name: string;
      target: string;
      /** absent while it runs */
      ms?: number;
      /** "exit 1", "rejected", "error": only on a step that failed */
      failed?: string;
    }
  | { kind: "thinking"; text: string; ms?: number }
  | { kind: "text"; text: string };

/** a long turn's list keeps its last steps: the rest are counted */
const VIEW_STEPS = 300;
const VIEW_STEP_TEXT = 4000;

/**
 * a turn's work as a chat window lists it: every step but the answer, and the thinking that came
 * right before the answer apart, since that is the one shown beside it. a thinking block's time
 * is from what came before it (the prompt, or the last result) to when it was written
 */
function stepsOf(turn: Turn): Pick<TurnView, "steps" | "stepsBefore" | "thought"> {
  const work = turn.work;
  const answer = new Set(answerSteps(work));
  let was = turn.prompt?.at ?? work.startedAt ?? 0;
  const views: Array<{ view: StepView; i: number }> = [];
  work.steps.forEach((s, i) => {
    if (s.kind === "tool") {
      if (s.server) return;
      views.push({
        i,
        view: {
          kind: "tool",
          id: s.id,
          name: s.name,
          target: s.target,
          ...(s.durationMs !== undefined ? { ms: s.durationMs } : {}),
          ...(s.isError ? { failed: s.failure ?? "error" } : {}),
        },
      });
      was = Math.max(was, s.at + (s.durationMs ?? 0));
    } else if (s.kind === "thinking") {
      const ms = s.at > was ? s.at - was : undefined;
      views.push({
        i,
        view: { kind: "thinking", text: cut(s.text, VIEW_STEP_TEXT), ...(ms ? { ms } : {}) },
      });
      was = Math.max(was, s.at);
    } else if (s.kind === "text" && !answer.has(i)) {
      views.push({ i, view: { kind: "text", text: cut(s.text, VIEW_STEP_TEXT) } });
      was = Math.max(was, s.at);
    }
  });
  // the thinking after the last tool is the answer's: it shows with it, not in the list
  let thought: TurnView["thought"];
  const lastTool = views.findLastIndex((v) => v.view.kind === "tool");
  const after = views.slice(lastTool + 1).filter((v) => v.view.kind === "thinking");
  if (after.length && (answer.size > 0 || lastTool < 0)) {
    const texts = after.map((v) => (v.view as { text: string }).text);
    const ms = after.reduce((n, v) => n + ((v.view as { ms?: number }).ms ?? 0), 0);
    thought = { text: texts.join("\n\n"), ...(ms ? { ms } : {}) };
    const drop = new Set(after.map((v) => v.i));
    views.splice(0, views.length, ...views.filter((v) => !drop.has(v.i)));
  }
  const steps = views.map((v) => v.view);
  const before = Math.max(0, steps.length - VIEW_STEPS);
  return {
    ...(steps.length ? { steps: steps.slice(before) } : {}),
    ...(before ? { stepsBefore: before } : {}),
    ...(thought ? { thought } : {}),
  };
}

/** a file a turn showed: one it wrote or edited, or with `read` an image it looked at */
export interface FileMark {
  path: string;
  read?: true;
}

/** what a file's name says it is, for what a chat window can draw of it */
export function fileKind(path: string): "image" | "markdown" | "html" | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return undefined;
}

/** a turn's files worth a card: written ones that can be drawn, read ones that are images */
function fileMarks(work: TimelineState): FileMark[] {
  const marks = new Map<string, FileMark>();
  for (const s of work.steps) {
    if (s.kind !== "tool" || !s.path || s.isError) continue;
    const kind = fileKind(s.path);
    const read = s.name === "Read";
    if (!kind || (read && kind !== "image")) continue;
    // written after it was read: a card for what it wrote
    if (read && marks.has(s.path)) continue;
    marks.delete(s.path);
    marks.set(s.path, read ? { path: s.path, read: true } : { path: s.path });
  }
  return [...marks.values()];
}

/** every file the session wrote or edited, the latest first */
export function filesWritten(state: ConversationState): string[] {
  const seen = new Set<string>();
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item?.kind !== "turn") continue;
    for (let j = item.work.steps.length - 1; j >= 0; j--) {
      const s = item.work.steps[j];
      if (s?.kind === "tool" && s.path && EDITS.has(s.name) && !s.isError) seen.add(s.path);
    }
  }
  return [...seen];
}

export type ConversationViewItem = TurnView | { kind: "compact" };

export interface ConversationView {
  items: ConversationViewItem[];
  /** turns before these, not sent */
  older: number;
}

/**
 * the conversation as markdown, to copy or keep: each prompt and the answer it got, whole, in
 * order, with where it was compacted. the work in between is left out, as a chat reads
 */
export function conversationMarkdown(state: ConversationState, title: string): string {
  const out = [`# ${title}`];
  for (const item of state.items) {
    if (item.kind === "compact") {
      out.push("_Compacted: what came before was summarised._");
      continue;
    }
    const p = item.prompt;
    if (p)
      out.push(
        p.kind === "human"
          ? `## You\n\n${p.text}`
          : `## ${p.kind === "command" ? "Command" : "Task"}\n\n${p.text}`,
      );
    const answer = answerOf(item.work);
    if (answer) out.push(`## Claude\n\n${answer}`);
    else if (item.apiError) out.push(`_${item.apiError}_`);
  }
  return `${out.join("\n\n")}\n`;
}

/** the last turns (VIEW_TURNS, or `turns`), each text cut. compactions stay where they happened */
export function conversationView(
  state: ConversationState,
  /**
   * `textMax`: what a message keeps, every turn's. a chat window reads them whole. `chat`: what
   * only a chat window draws - the files a prompt came with, the steps, the thinking. `turns`: how
   * many of the last turns, when not VIEW_TURNS (a chat window's "Show older")
   */
  opts: { textMax?: number; chat?: boolean; turns?: number } = {},
): ConversationView {
  const turns = state.items.filter((i) => i.kind === "turn").length;
  const older = Math.max(0, turns - (opts.turns ?? VIEW_TURNS));
  let skip = older;
  const from = state.items.findIndex((i) => i.kind === "turn" && skip-- === 0);
  const items = from < 0 ? [] : state.items.slice(from);
  return {
    older,
    items: items.map(
      (item, i): ConversationViewItem =>
        item.kind === "compact"
          ? { kind: "compact" }
          : turnView(item, i === items.length - 1, opts),
    ),
  };
}

/** one turn as the page gets it. `last`: the one under way, or the one the panel is for */
function turnView(item: Turn, last: boolean, opts: { textMax?: number; chat?: boolean }): TurnView {
  const n = turnNumbers(item);
  const said = item.marks.flatMap((m) => (m.kind === "said" ? [cut(m.text, VIEW_PROMPT)] : []));
  const answer = answerOf(item.work);
  // a turn still under way, or one that stopped: the last thing it said, as the panel always showed
  const words = last && !answer ? item.work.steps.findLast((s) => s.kind === "text") : undefined;
  const text = answer || (words?.kind === "text" ? words.text : "");
  const max = opts.textMax ?? (last ? VIEW_LAST_TEXT : VIEW_TEXT);
  const error = item.work.last?.error ?? (answer ? undefined : item.apiError);
  const outputs = fileMarks(item.work);
  return {
    kind: "turn",
    ...(item.prompt
      ? {
          prompt: {
            kind: item.prompt.kind,
            text: cut(item.prompt.text, VIEW_PROMPT),
            ...(item.prompt.images ? { images: item.prompt.images } : {}),
            ...(opts.chat && item.prompt.files ? { files: item.prompt.files } : {}),
          },
        }
      : {}),
    ...(said.length ? { said } : {}),
    tools: n.tools,
    files: n.filesEdited,
    agents: n.agents,
    ...(n.durationMs !== undefined ? { ms: n.durationMs } : {}),
    ...(text ? { text: text.length > max ? `…${text.slice(1 - max)}` : text } : {}),
    ...(error ? { note: error } : item.work.interrupted ? { note: "Interrupted" } : {}),
    ...(outputs.length ? { outputs } : {}),
    ...(opts.chat ? stepsOf(item) : {}),
    ...(opts.chat && item.output ? { output: item.output } : {}),
    ...(opts.chat ? workflowsOf(item.work) : {}),
    ...(opts.chat && error ? { failed: true } : {}),
  };
}

function workflowsOf(work: TimelineState): Pick<TurnView, "workflows"> {
  const n = work.steps.filter((s) => s.kind === "tool" && s.name === "Workflow").length;
  return n ? { workflows: n } : {};
}

/**
 * a subagent's own transcript as one turn of a chat window: what it was asked, what it did, what
 * it came back with. the same view a turn of the session gets, so it is drawn the same way
 */
export function agentView(work: TimelineState): TurnView {
  const turn: Turn = { kind: "turn", work, marks: [] };
  if (work.prompt !== undefined) {
    turn.prompt = { kind: "human", text: work.prompt, at: work.startedAt ?? 0 };
  }
  return turnView(turn, true, { textMax: MESSAGE_MAX, chat: true });
}
