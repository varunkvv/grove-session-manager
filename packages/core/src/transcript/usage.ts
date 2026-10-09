// token counts and working time out of a transcript's lines. no node: imports, so the labels and
// formatting are usable from the renderer too.
import { extractCommand, extractUserText } from "./prompt.ts";

export interface TokenCounts {
  /** uncached input */
  input: number;
  output: number;
  cacheRead: number;
  /** every cache write, the 5-minute and the 1-hour ones */
  cacheWrite: number;
}

export interface ModelUsage extends TokenCounts {
  model: string;
  /** API responses, not transcript lines: one response is written as one line per content block */
  messages: number;
}

/** one model on one day of one file */
export interface ModelCounts extends TokenCounts {
  /** the part of cacheWrite kept for an hour. it is priced higher than the rest */
  cacheWrite1h: number;
  messages: number;
  /** the agent's working time, on the model that answered at the end of it */
  ms: number;
}

/** one local day of one file */
export interface DayTally {
  models: Record<string, ModelCounts>;
  /** the 5-minute slots of the day with working time in them: 288 bits, in 9 words */
  slots?: number[];
  /** the longest turn that reached this day, as working time. a session's own transcript only */
  turn?: number;
}

/** a response's tokens: its own model's, and an advisor's beside it */
type Parts = Array<[model: string, counts: Omit<ModelCounts, "ms">]>;

/**
 * where a scan of one file got to, so the next one reads only what was appended.
 * `recent` carries the last few responses across the boundary: a response's blocks can land on
 * both sides of it, and a later block carries the final usage for the whole response. each keeps
 * the day it was counted on, so a later block takes it out of the right one.
 */
export interface UsageTally {
  offset: number;
  /** by local day, `YYYY-MM-DD` */
  days: Record<string, DayTally>;
  recent: Array<[id: string, day: string, parts: Parts]>;
  /**
   * the working-time clock across the offset: when the last prompt or response was, whether
   * anything ran after it, and the working time of the turn so far once a person has asked
   */
  clock?: { at: number; idle?: boolean; turn?: number };
}

const RECENT = 16;

/**
 * the longest wait between two lines that still counts as work. Bash gives up after 10 minutes
 * and the slowest advisor call measured took 15. past that it is a permission prompt nobody
 * answered or a sleeping laptop, and none of it counts
 */
export const GAP_CAP_MS = 15 * 60_000;

const SLOT_MS = 5 * 60_000;

/** a tool that waits for the person: what follows is their time, not the agent's */
const ASKS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };

export function emptyTally(): UsageTally {
  return { offset: 0, days: {}, recent: [] };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** the local calendar day of a time, `YYYY-MM-DD` */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function countsOf(usage: Record<string, unknown>): Omit<ModelCounts, "ms" | "messages"> {
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const split = usage.cache_creation;
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite,
    // no split: all of it is the 5-minute kind
    cacheWrite1h: Math.min(cacheWrite, isObject(split) ? num(split.ephemeral_1h_input_tokens) : 0),
  };
}

/**
 * response id and usage from one line, by model. null for anything that is not a billed response.
 *
 * the top-level numbers are the response's own. an advisor call is a second model's response
 * inside it, and is only in `usage.iterations`: there each iteration is counted, an
 * `advisor_message` on its own model
 */
export function usageOf(entry: Record<string, unknown>): { id?: string; parts: Parts } | null {
  if (entry.type !== "assistant") return null;
  const m = entry.message;
  if (typeof m !== "object" || m === null) return null;
  const msg = m as Record<string, unknown>;
  const model = msg.model;
  // "<synthetic>" marks entries Claude Code writes itself, such as API errors. nothing was billed.
  if (typeof model !== "string" || !model || model.startsWith("<")) return null;
  const u = msg.usage;
  if (typeof u !== "object" || u === null) return null;
  const usage = u as Record<string, unknown>;
  const id =
    typeof msg.id === "string"
      ? msg.id
      : typeof entry.requestId === "string"
        ? entry.requestId
        : undefined;
  const by = new Map<string, Omit<ModelCounts, "ms">>([[model, { ...ZERO, messages: 1 }]]);
  const iterations = Array.isArray(usage.iterations) ? usage.iterations.filter(isObject) : [];
  for (const it of iterations.length ? iterations : [usage]) {
    const advisor = it.type === "advisor_message" && typeof it.model === "string" && it.model;
    const into = by.get(advisor || model) ?? { ...ZERO, messages: 0 };
    by.set(advisor || model, into);
    plus(into, countsOf(it), 1);
    if (advisor) into.messages += 1;
  }
  return { ...(id ? { id } : {}), parts: [...by] };
}

function plus(into: Omit<ModelCounts, "ms" | "messages">, c: typeof ZERO, sign: 1 | -1): void {
  into.input += sign * c.input;
  into.output += sign * c.output;
  into.cacheRead += sign * c.cacheRead;
  into.cacheWrite += sign * c.cacheWrite;
  into.cacheWrite1h += sign * c.cacheWrite1h;
}

function dayOn(t: UsageTally, day: string): DayTally {
  let d = t.days[day];
  if (!d) {
    d = { models: {} };
    t.days[day] = d;
  }
  return d;
}

function modelOn(t: UsageTally, day: string, model: string): ModelCounts {
  const d = dayOn(t, day);
  let m = d.models[model];
  if (!m) {
    m = { ...ZERO, messages: 0, ms: 0 };
    d.models[model] = m;
  }
  return m;
}

function add(t: UsageTally, day: string, parts: Parts, sign: 1 | -1): void {
  for (const [model, c] of parts) {
    const m = modelOn(t, day, model);
    plus(m, c, sign);
    m.messages += sign * c.messages;
  }
}

/**
 * folds parsed lines into a tally, in place. one response shows up once per content block, with
 * the same id, and the usage on later blocks can be larger (906 of 10k responses on a real
 * machine). so the last one wins, by id - they are not always adjacent either.
 *
 * working time comes from the gaps between lines: one that ends at a response is the model
 * answering or a tool running. one that ends at anything a turn starts with is nobody's
 */
export class UsageAccumulator {
  private readonly tally: UsageTally;
  private readonly seen = new Map<string, [string, Parts]>();

  constructor(tally: UsageTally) {
    this.tally = tally;
    for (const [id, day, parts] of tally.recent) this.seen.set(id, [day, parts]);
  }

  push(entry: Record<string, unknown>): void {
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (entry.type === "user") {
      this.starts(entry, at);
      return;
    }
    const u = usageOf(entry);
    if (!u) return;
    // a line with no time is counted on the day of the line before it
    const day = localDay(Number.isFinite(at) ? at : (this.tally.clock?.at ?? 0));
    if (u.id) {
      const prev = this.seen.get(u.id);
      if (prev) {
        add(this.tally, prev[0], prev[1], -1);
        this.seen.delete(u.id);
      }
      this.seen.set(u.id, [day, u.parts]);
    }
    add(this.tally, day, u.parts, 1);
    this.answers(entry, at, u.parts[0]?.[0] ?? "");
  }

  /** a line a turn starts with: a prompt, a command, a background task's news, an agent's brief */
  private starts(entry: Record<string, unknown>, at: number): void {
    const clock = this.tally.clock;
    // Claude Code's own notes ride along with other lines. a copy written again carries the time
    // of the original, and the clock never goes back
    if (entry.isMeta === true || !Number.isFinite(at) || (clock && at <= clock.at)) return;
    const content = isObject(entry.message) ? entry.message.content : undefined;
    const result =
      Array.isArray(content) && content.some((b) => isObject(b) && b.type === "tool_result");
    if (result || (entry.toolUseResult !== undefined && entry.toolUseResult !== null)) return;
    // the person asked: a new turn. anything else leaves the turn it is in running
    const asked = (extractUserText(entry) ?? extractCommand(entry)) !== undefined;
    const turn = asked ? 0 : clock?.turn;
    this.tally.clock = { at, ...(turn !== undefined ? { turn } : {}) };
  }

  /** a response: the time since the line before it was the agent's, unless nothing was running */
  private answers(entry: Record<string, unknown>, at: number, model: string): void {
    const clock = this.tally.clock;
    if (!Number.isFinite(at) || (clock && at <= clock.at)) return;
    const gap = clock && !clock.idle ? at - clock.at : 0;
    let turn = clock?.turn;
    if (gap > 0 && gap <= GAP_CAP_MS && clock) {
      const day = localDay(at);
      modelOn(this.tally, day, model).ms += gap;
      const d = dayOn(this.tally, day);
      if (turn !== undefined) {
        turn += gap;
        d.turn = Math.max(d.turn ?? 0, turn);
      }
      for (let s = Math.floor(clock.at / SLOT_MS); s * SLOT_MS < at; s++) this.slot(s * SLOT_MS);
    }
    const msg = entry.message as Record<string, unknown>;
    const blocks = Array.isArray(msg.content) ? msg.content.filter(isObject) : [];
    // the turn is over, or it waits on the person: what comes next is not the agent's time
    const idle =
      msg.stop_reason === "end_turn" ||
      blocks.some((b) => b.type === "tool_use" && ASKS.has(String(b.name)));
    this.tally.clock = { at, ...(idle ? { idle } : {}), ...(turn !== undefined ? { turn } : {}) };
  }

  private slot(at: number): void {
    const d = new Date(at);
    const day = dayOn(this.tally, localDay(at));
    day.slots ??= new Array(9).fill(0);
    const slots = day.slots;
    // by the clock on the wall, so the hour a clock change repeats shares its slots
    const i = d.getHours() * 12 + Math.floor(d.getMinutes() / 5);
    slots[i >> 5] = ((slots[i >> 5] ?? 0) | (1 << (i & 31))) >>> 0;
  }

  /** call once the offset is committed */
  finish(offset: number): UsageTally {
    this.tally.offset = offset;
    // a Map iterates in insertion order and push() re-inserts on a repeat, so the tail is the newest
    this.tally.recent = [...this.seen].slice(-RECENT).map(([id, [day, parts]]) => [id, day, parts]);
    return this.tally;
  }
}

export function tokenTotal(c: TokenCounts): number {
  return c.input + c.output + c.cacheRead + c.cacheWrite;
}

/** several files (a session and its subagents) into one row per model, the biggest first */
export function summarizeUsage(tallies: Iterable<UsageTally>): ModelUsage[] {
  const by = new Map<string, ModelUsage>();
  for (const t of tallies) {
    for (const day of Object.values(t.days)) {
      for (const [model, c] of Object.entries(day.models)) {
        const m = by.get(model) ?? {
          model,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          messages: 0,
        };
        m.input += c.input;
        m.output += c.output;
        m.cacheRead += c.cacheRead;
        m.cacheWrite += c.cacheWrite;
        m.messages += c.messages;
        by.set(model, m);
      }
    }
  }
  return [...by.values()]
    .filter((m) => m.messages > 0)
    .sort((a, b) => tokenTotal(b) - tokenTotal(a) || a.model.localeCompare(b.model));
}

/**
 * "claude-opus-5" -> "opus 5", "claude-haiku-4-5-20251001" -> "haiku 4.5",
 * "claude-opus-5[1m]" -> "opus 5 1m". anything that does not look like that is shown as is.
 */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)((?:-\d{1,3})*)(?:-\d{8})?(?:\[([^\]]+)\])?$/.exec(model);
  if (!m) return model;
  const version = (m[2] ?? "").split("-").filter(Boolean).join(".");
  return [m[1], version, m[3]].filter(Boolean).join(" ");
}

/** 950 -> "950", 12_400 -> "12k", 3_450_000 -> "3.5M" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n < 999_500_000) return `${Math.round(n / 1_000_000)}M`;
  return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
}
