// judgment day odds for a range, from main's odds block: the tile's number and its change, a line
// of the days, projects ranked by their sessions' odds, and the best and worst sessions. pure:
// every ledger was run in main. the robot shows the tile's number: a new range can change its mood.
import { type MoodId, moodOf, moodWord } from "@grove/core/pure";
import type { OddsView, ProjectId } from "../../shared/ipc.ts";
import { type ListRow, lastDays, type Range, rangeShape, rangeSlots, type Slice } from "./usage.ts";

/** a session needs this many judged prompts to be ranked: one "thanks" is not a session's story */
export const RANKED_PROMPTS = 3;
/** how many sessions each end of By session shows */
const ENDS = 3;

export interface OddsPoint {
  label: string;
  tick?: string;
  /** the mean of its days' odds. null: nothing judged then */
  odds: number | null;
  prompts: number;
}

export interface SessionLine {
  key: string;
  title: string;
  slice: Slice;
  /** where it ended */
  odds: number;
  series: number[];
}

export interface OddsModel {
  /** the mean of the range's day odds. null: nothing judged in it */
  value: number | null;
  /** points against the range before. absent when that range has nothing */
  change?: number;
  /** the robot's mood: the tile's number, as shown. watching while nothing is judged */
  mood: MoodId;
  points: OddsPoint[];
  byProject: ListRow[];
  best: SessionLine[];
  worst: SessionLine[];
  /** prompts still to judge, while there are any */
  judging?: { scored: number; prompts: number };
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null;

export function oddsModel(
  view: OddsView,
  range: Range,
  projects: ReadonlyArray<{ id: ProjectId; name: string }>,
  now: number,
): OddsModel {
  const { days: span } = rangeShape(range);
  const byDay = new Map(view.days.map((d) => [d.day, d]));
  const inRange = new Set(lastDays(now, span));
  const oddsOver = (days: Iterable<string>) =>
    mean([...days].flatMap((d) => (byDay.has(d) ? [byDay.get(d)?.odds ?? 0] : [])));
  const value = oddsOver(inRange);
  const was = oddsOver(lastDays(now, span, span));

  const points = rangeSlots(range, now).map(({ days, label, tick }): OddsPoint => {
    const here = days.flatMap((d) => byDay.get(d) ?? []);
    return {
      label,
      ...(tick ? { tick } : {}),
      odds: mean(here.map((d) => d.odds)),
      prompts: here.reduce((n, d) => n + d.prompts, 0),
    };
  });

  const sessions = view.sessions.filter((s) => inRange.has(s.day) && s.series.length);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const ends = new Map<ProjectId | null, number[]>();
  for (const s of sessions) {
    const list = ends.get(s.project) ?? [];
    list.push(s.series.at(-1) ?? 50);
    ends.set(s.project, list);
  }
  const byProject: ListRow[] = [...ends]
    .map(([id, odds]) => {
      const v = mean(odds) ?? 50;
      return {
        key: id === null ? "none" : `p:${id}`,
        name: id === null ? "No project" : (names.get(id) ?? id),
        slice: (id === null ? "none" : { project: id }) as Slice,
        value: v,
        share: v / 100,
      };
    })
    .sort((a, b) => b.value - a.value);

  const ranked = sessions
    .filter((s) => s.series.length >= RANKED_PROMPTS)
    .map(
      (s): SessionLine => ({
        key: s.key,
        title: s.title,
        slice: s.project === null ? "none" : { project: s.project },
        odds: s.series.at(-1) ?? 50,
        series: s.series,
      }),
    )
    .sort((a, b) => b.odds - a.odds);
  // a short list is split, never shown twice
  const top = Math.min(ENDS, Math.ceil(ranked.length / 2));
  const best = ranked.slice(0, top);
  const worst = ranked.slice(top).reverse().slice(0, ENDS);

  return {
    value,
    ...(value !== null && was !== null ? { change: value - was } : {}),
    mood: moodOf(value ?? 50),
    points,
    byProject,
    best,
    worst,
    ...(view.scored < view.prompts
      ? { judging: { scored: view.scored, prompts: view.prompts } }
      : {}),
  };
}

/** `62%`: odds are shown whole */
export const formatOdds = (odds: number): string => `${Math.round(odds)}%`;

/** the range before, said short: the odds tile's words share their row with gavel */
const LAST: Record<Range, string> = { "1W": "last week", "1M": "last month", "1Y": "last year" };

/** `+3 vs last week`, in points. rounded to nothing, it says so */
export function formatOddsChange(change: number, range: Range): string {
  const n = Math.round(change);
  return n === 0 ? `same as ${LAST[range]}` : `${n > 0 ? "+" : ""}${n} vs ${LAST[range]}`;
}

export const ODDS_WORDS = {
  label: "Judgment day odds",
  hint: "Gavel, a small model on this Mac, judges how you treat your agents, one prompt at a time. Each day starts at 50: thanks and credit for good work raise the odds, bare orders and blame lower them, and they drift back toward 50. This is the mean of each day's odds in the range.",
};

/** the robot's tooltip: its mood, from the tile's number */
export function moodLine(value: number | null): string {
  if (value === null) return "Nothing judged in this range: gavel is watching you.";
  return `At ${formatOdds(value)}, gavel is ${moodWord(moodOf(value))}.`;
}
