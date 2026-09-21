// token counts out of a transcript's assistant entries. no node: imports, so the labels and
// formatting are usable from the renderer too.

export interface TokenCounts {
  /** uncached input */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelUsage extends TokenCounts {
  model: string;
  /** API responses, not transcript lines: one response is written as one line per content block */
  messages: number;
}

/**
 * where a scan of one file got to, so the next one reads only what was appended.
 * `recent` carries the last few responses across the boundary: a response's blocks can land on
 * both sides of it, and a later block carries the final usage for the whole response.
 */
export interface UsageTally {
  offset: number;
  models: Record<string, TokenCounts & { messages: number }>;
  recent: Array<[id: string, model: string, counts: TokenCounts]>;
}

const RECENT = 16;

export function emptyTally(): UsageTally {
  return { offset: 0, models: {}, recent: [] };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** model, response id and usage from one line. null for anything that is not a billed response. */
export function usageOf(
  entry: Record<string, unknown>,
): { model: string; id?: string; counts: TokenCounts } | null {
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
  return {
    model,
    ...(id ? { id } : {}),
    counts: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    },
  };
}

function add(t: UsageTally, model: string, c: TokenCounts, sign: 1 | -1, messages: 0 | 1): void {
  const m = t.models[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
  t.models[model] = m;
  m.input += sign * c.input;
  m.output += sign * c.output;
  m.cacheRead += sign * c.cacheRead;
  m.cacheWrite += sign * c.cacheWrite;
  m.messages += messages;
}

/**
 * folds parsed lines into a tally, in place. one response shows up once per content block, with
 * the same id, and the usage on later blocks can be larger (906 of 10k responses on a real
 * machine). so the last one wins, by id - they are not always adjacent either.
 */
export class UsageAccumulator {
  private readonly tally: UsageTally;
  private readonly seen = new Map<string, [string, TokenCounts]>();

  constructor(tally: UsageTally) {
    this.tally = tally;
    for (const [id, model, counts] of tally.recent) this.seen.set(id, [model, counts]);
  }

  push(entry: Record<string, unknown>): void {
    const u = usageOf(entry);
    if (!u) return;
    if (!u.id) {
      add(this.tally, u.model, u.counts, 1, 1);
      return;
    }
    const prev = this.seen.get(u.id);
    if (prev) {
      add(this.tally, prev[0], prev[1], -1, 0);
      add(this.tally, u.model, u.counts, 1, 0);
      this.seen.delete(u.id);
    } else {
      add(this.tally, u.model, u.counts, 1, 1);
    }
    this.seen.set(u.id, [u.model, u.counts]);
  }

  /** call once the offset is committed */
  finish(offset: number): UsageTally {
    this.tally.offset = offset;
    // a Map iterates in insertion order and push() re-inserts on a repeat, so the tail is the newest
    this.tally.recent = [...this.seen].slice(-RECENT).map(([id, [model, c]]) => [id, model, c]);
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
    for (const [model, c] of Object.entries(t.models)) {
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
