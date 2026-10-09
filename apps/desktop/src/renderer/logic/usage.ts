// what the Usage screen draws from main's view: a range and a metric picked, then totals, bars,
// lists and words. pure: every number here was counted in main.
import { formatTokens, localDay, modelLabel } from "@grove/core/pure";
import type { ProjectId, UsageCell, UsageDay, UsageView } from "../../shared/ipc.ts";

export type Range = "1W" | "1M" | "1Y";
export type Metric = "cost" | "time" | "tokens";

export const RANGES: Range[] = ["1W", "1M", "1Y"];
export const METRICS: Metric[] = ["cost", "time", "tokens"];

/** how many days a range covers, and how many go into one bar. a year is 52 whole weeks */
const SHAPE: Record<Range, { days: number; per: number; before: string }> = {
  "1W": { days: 7, per: 1, before: "the week before" },
  "1M": { days: 30, per: 1, before: "the month before" },
  "1Y": { days: 364, per: 7, before: "the year before" },
};

/** rows a list names before the rest is folded into one */
const ROWS = 6;

/** a project, every session in no project, or the projects a list folded away */
export type Slice = { project: ProjectId } | "none" | "other";

const sliceKey = (s: Slice): string => (typeof s === "string" ? s : `p:${s.project}`);

export interface Tile {
  total: number;
  /** against the range before, as a fraction: 0.18 is +18%. absent when that range has nothing */
  change?: number;
}

export interface Bar {
  /** the period, as its tooltip says it: `Thu, Oct 8`, `Oct 2 - Oct 8` */
  label: string;
  /** what the axis says under it, on the few bars that carry a label */
  tick?: string;
  total: number;
  /** bottom to top, the same order in every bar. only the ones with something */
  segments: Array<{ slice: Slice; key: string; value: number }>;
}

export interface ListRow {
  key: string;
  name: string;
  /** a project's row carries its mark */
  slice?: Slice;
  value: number;
  /** against the biggest row, 0 to 1: the length of its bar */
  share: number;
}

export interface UsageModel {
  tiles: Record<Metric, Tile>;
  /** what the change is against: `the week before` */
  before: string;
  /** oldest first: 7, 30 or 52 */
  bars: Bar[];
  /** every slice a bar of this range holds, bottom to top */
  stack: Array<{ slice: Slice; key: string }>;
  /** the axis, bottom to top, from 0. the last one is the top of the plot */
  ticks: Tick[];
  byProject: ListRow[];
  byModel: ListRow[];
  extras: {
    sessions: number;
    subagents: number;
    /** cache read over every input token, 0 to 1. null with no input at all */
    cacheHit: number | null;
    peak: number;
    /** the day of the peak, as words */
    peakDay?: string;
    longest: number;
  };
  /** tokens in the range on models with no known price */
  unpriced: number;
  /** nothing at all in the range */
  empty: boolean;
}

const tokensOf = (c: UsageCell): number => c.tokens.reduce((n, t) => n + t, 0);

export function metricOf(c: UsageCell, metric: Metric): number {
  return metric === "cost" ? c.cost : metric === "time" ? c.ms : tokensOf(c);
}

/** the last `n` local days ending today, oldest first. by the calendar: a day is not always 24h */
function lastDays(now: number, n: number, skip = 0): string[] {
  const out: string[] = [];
  for (let back = skip + n - 1; back >= skip; back--) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - back);
    out.push(localDay(d.getTime()));
  }
  return out;
}

const dateOf = (day: string): Date => new Date(`${day}T12:00:00`);
const words = (day: string, o: Intl.DateTimeFormatOptions): string =>
  dateOf(day).toLocaleDateString("en-US", o);
const monthDay = (day: string): string => words(day, { month: "short", day: "numeric" });

function total(days: readonly UsageDay[], metric: Metric): number {
  return days.reduce((n, d) => n + d.projects.reduce((k, p) => k + metricOf(p, metric), 0), 0);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

/** elapsed time, not a calendar's: a day is 24 hours, a week 7 days, a year 365. no months */
const UNITS: ReadonlyArray<{ ms: number; sign: string; steps: number[] }> = [
  { ms: YEAR, sign: "y", steps: [1, 2, 5, 10, 20, 50] },
  { ms: WEEK, sign: "w", steps: [1, 2, 4, 5, 10, 13, 26] },
  { ms: DAY, sign: "d", steps: [1, 2] },
  { ms: HOUR, sign: "h", steps: [1, 2, 3, 4, 6, 8, 12] },
  { ms: MIN, sign: "m", steps: [1, 2, 5, 10, 15, 20, 30] },
];

export interface Tick {
  value: number;
  label: string;
}

/**
 * the axis for a largest bar, from 0: at most four steps of a round size, the top one at or over
 * it. money and tokens step by 1, 2, 2.5 or 5 times a power of ten. time is in ONE unit for the
 * whole axis, the largest the bar holds one of, so no two lines have to be converted to be
 * compared and the top one reads small: `20m`, `6h`, `3d`, `2w`. never `48h` or `120m`
 */
export function axisTicks(max: number, metric: Metric): Tick[] {
  if (max <= 0) return [{ value: 0, label: formatTick(0, metric) }];
  let step: number;
  let label = (n: number) => formatTick(n, metric);
  if (metric === "time") {
    const unit = UNITS.find((u) => max >= u.ms) ?? UNITS[UNITS.length - 1]!;
    const of = max / unit.ms;
    step = (unit.steps.find((s) => of / s <= 4) ?? Math.ceil(of / 4)) * unit.ms;
    label = (n) => (n === 0 ? "0" : `${Math.round(n / unit.ms)}${unit.sign}`);
  } else {
    const pow = 10 ** Math.floor(Math.log10(max / 4));
    step = ([1, 2, 2.5, 5, 10].find((m) => max / (m * pow) <= 4) ?? 10) * pow;
    // a token is not cut in two
    if (metric === "tokens") step = Math.max(1, Math.ceil(step));
  }
  const n = Math.max(1, Math.ceil(max / step - 1e-9));
  return Array.from({ length: n + 1 }, (_, i) => ({ value: i * step, label: label(i * step) }));
}

/** biggest first, and past six rows the smallest are one row: `Other` */
function fold<T extends { value: number }>(rows: T[], other: (rest: T[]) => T): T[] {
  const sorted = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= ROWS) return sorted;
  return [...sorted.slice(0, ROWS - 1), other(sorted.slice(ROWS - 1))];
}

const shares = (rows: Array<Omit<ListRow, "share">>): ListRow[] => {
  const top = Math.max(0, ...rows.map((r) => r.value));
  return rows.map((r) => ({ ...r, share: top > 0 ? r.value / top : 0 }));
};

export function usageModel(
  view: UsageView,
  range: Range,
  metric: Metric,
  /** in the sidebar's order: a bar stacks them the same way every time */
  projects: ReadonlyArray<{ id: ProjectId; name: string }>,
  now: number,
): UsageModel {
  const { days: span, per, before } = SHAPE[range];
  const byDay = new Map(view.days.map((d) => [d.day, d]));
  const pick = (days: string[]) => days.flatMap((d) => byDay.get(d) ?? []);
  const dayList = lastDays(now, span);
  const mine = pick(dayList);
  const prior = pick(lastDays(now, span, span));

  const tiles = Object.fromEntries(
    METRICS.map((m) => {
      const cur = total(mine, m);
      const was = total(prior, m);
      return [m, { total: cur, ...(was > 0 ? { change: (cur - was) / was } : {}) }];
    }),
  ) as Record<Metric, Tile>;

  // the range's projects, biggest first: the list under the chart, and which of them a bar names
  const sums = new Map<ProjectId | null, number>();
  for (const d of mine) {
    for (const p of d.projects) {
      sums.set(p.project, (sums.get(p.project) ?? 0) + metricOf(p, metric));
    }
  }
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const byProject = fold(
    [...sums].map(([id, value]) => ({
      key: id === null ? "none" : `p:${id}`,
      // a project that has left the list since is still named by its folder
      name: id === null ? "No project" : (names.get(id) ?? id),
      slice: (id === null ? "none" : { project: id }) as Slice,
      value,
    })),
    (rest) => ({
      key: "other",
      name: `Other (${rest.length})`,
      slice: "other" as Slice,
      value: rest.reduce((n, r) => n + r.value, 0),
    }),
  );
  const named = new Set(byProject.map((r) => r.key));
  // the sidebar's order, then the two greys on top
  const order = [
    ...projects.map((p) => `p:${p.id}`),
    ...[...sums.keys()].flatMap((id) => (id === null || names.has(id) ? [] : [`p:${id}`])),
    "none",
    "other",
  ];

  const bars: Bar[] = [];
  for (let i = 0; i < dayList.length; i += per) {
    const chunk = dayList.slice(i, i + per);
    const first = chunk[0] ?? "";
    const last = chunk.at(-1) ?? first;
    const by = new Map<string, { slice: Slice; key: string; value: number }>();
    for (const d of pick(chunk)) {
      for (const p of d.projects) {
        const own = p.project === null ? "none" : `p:${p.project}`;
        const slice: Slice = !named.has(own)
          ? "other"
          : p.project === null
            ? "none"
            : { project: p.project };
        const key = sliceKey(slice);
        const seg = by.get(key) ?? { slice, key, value: 0 };
        seg.value += metricOf(p, metric);
        by.set(key, seg);
      }
    }
    const segments = order.flatMap((k) => by.get(k) ?? []).filter((s) => s.value > 0);
    const n = bars.length;
    const count = dayList.length / per;
    let tick: string | undefined;
    if (range === "1W") tick = words(first, { weekday: "short" });
    // a date a week, counted back from today
    else if (range === "1M") tick = (count - 1 - n) % 7 === 0 ? monthDay(first) : undefined;
    // a month where it starts
    else if (chunk.some((d) => d.endsWith("-01"))) tick = words(last, { month: "short" });
    bars.push({
      label:
        per === 1
          ? words(first, { weekday: "short", month: "short", day: "numeric" })
          : `${monthDay(first)} - ${monthDay(last)}`,
      ...(tick ? { tick } : {}),
      total: segments.reduce((k, s) => k + s.value, 0),
      segments,
    });
  }

  const stacked = new Map(bars.flatMap((b) => b.segments.map((s) => [s.key, s.slice] as const)));
  const stack = order.flatMap((key) => {
    const slice = stacked.get(key);
    return slice ? [{ slice, key }] : [];
  });

  const models = new Map<string, number>();
  const tokens = [0, 0, 0, 0, 0];
  const sessions = new Set<number>();
  let subagents = 0;
  let unpriced = 0;
  let peak: UsageDay | undefined;
  let longest = 0;
  for (const d of mine) {
    for (const m of d.models) {
      models.set(m.model, (models.get(m.model) ?? 0) + metricOf(m, metric));
      m.tokens.forEach((t, i) => {
        tokens[i] = (tokens[i] ?? 0) + t;
      });
    }
    for (const s of d.sessions) sessions.add(s);
    subagents += d.subagents;
    unpriced += d.unpriced;
    if (d.peak > (peak?.peak ?? 0)) peak = d;
    longest = Math.max(longest, d.longest);
  }
  const byModel = fold(
    [...models].map(([model, value]) => ({ key: model, name: modelLabel(model), value })),
    (rest) => ({
      key: "other",
      name: `Other (${rest.length})`,
      value: rest.reduce((n, r) => n + r.value, 0),
    }),
  );
  const input = (tokens[0] ?? 0) + (tokens[2] ?? 0) + (tokens[3] ?? 0) + (tokens[4] ?? 0);

  return {
    tiles,
    before,
    bars,
    stack,
    ticks: axisTicks(Math.max(0, ...bars.map((b) => b.total)), metric),
    byProject: shares(byProject),
    byModel: shares(byModel),
    extras: {
      sessions: sessions.size,
      subagents,
      cacheHit: input > 0 ? (tokens[2] ?? 0) / input : null,
      peak: peak?.peak ?? 0,
      ...(peak
        ? { peakDay: words(peak.day, { weekday: "long", month: "long", day: "numeric" }) }
        : {}),
      longest,
    },
    unpriced,
    empty: mine.length === 0,
  };
}

// ---------- the words

const grouped = (n: number, digits = 0): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** `$1,284`, and cents only under ten dollars: `$4.20` */
export function formatCost(usd: number): string {
  return `$${grouped(usd, usd < 10 ? 2 : 0)}`;
}

/**
 * a duration in the unit that fits it: its two largest, so the leading number stays small, and
 * rounded down. `52m`, `7h 12m`, `3d 4h`, `5w 6d`, `1y 12w`. a second unit of zero is left out.
 * core's formatDuration is for a turn or a session, and would say `1000h` here
 */
export function formatTime(ms: number): string {
  if (ms <= 0) return "0m";
  if (ms < MIN) return "<1m";
  const at = UNITS.findIndex((u) => ms >= u.ms);
  const first = UNITS[at]!;
  const second = UNITS[at + 1];
  const rest = second ? Math.floor((ms % first.ms) / second.ms) : 0;
  return `${Math.floor(ms / first.ms)}${first.sign}${rest > 0 && second ? ` ${rest}${second.sign}` : ""}`;
}

export function formatValue(n: number, metric: Metric): string {
  return metric === "cost" ? formatCost(n) : metric === "time" ? formatTime(n) : formatTokens(n);
}

/** an axis value of money or tokens: round by construction, so never cents on a dollar amount that has none */
function formatTick(n: number, metric: Metric): string {
  if (metric === "cost") return `$${grouped(n, Number.isInteger(n) ? 0 : 2)}`;
  return metric === "time" ? formatTime(n) : formatTokens(n);
}

/** `+18%`, `-4%`, and past ten times over, `12x` */
export function formatChange(change: number): string {
  if (change >= 9) return `${grouped(change + 1, change + 1 < 100 ? 1 : 0).replace(/\.0$/, "")}x`;
  const pct = Math.round(change * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

/** `94%`, and one decimal under ten */
export function formatShare(share: number): string {
  const pct = share * 100;
  return `${grouped(pct, pct > 0 && pct < 10 ? 1 : 0)}%`;
}

export const METRIC_WORDS: Record<Metric, { label: string; hint: string }> = {
  cost: {
    label: "API-equivalent cost",
    hint: "What this usage would cost at API list prices. Your plan is not billed this way.",
  },
  time: {
    label: "Agent time",
    hint: "Time agents spent working, every agent counted: three subagents working ten minutes at once is thirty minutes. It is not wall clock, and a day here is 24 hours of agent work.",
  },
  tokens: {
    label: "Tokens",
    hint: "Input + output + cache read + cache write.",
  },
};
