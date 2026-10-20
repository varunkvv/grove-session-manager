// the judge's rubric and the ledger it keeps: what a prompt's per-level probabilities are worth, and
// how the odds move. pure: main, the scorer and the renderer all load it.
import gavel from "./gavel.rubric.json" with { type: "json" };

/** one Score question: ordered levels, judged one prompt at a time */
export interface RubricQuestion {
  id: string;
  instructions: string;
  /** level 0 first. a level describes a situation, never a degree */
  criteria: string[];
}

/** the odds a session, a day or a project has, as rubric-v3's ledger block defines them */
export interface Ledger {
  version: string;
  /** every session and every day starts here */
  start: number;
  clamp: [number, number];
  /** points per level, per question */
  weights: Record<string, number[]>;
  /** these questions' negatives do not stack: when all are negative only the worst counts */
  negatives: { worst_of: string[] };
  /** each prompt keeps this share of the distance from `start` before its points land */
  keep: number;
  /** mood id -> [from, to], whole odds */
  moods: Record<string, [number, number]>;
}

export interface Rubric {
  id: string;
  /** what the questions are at. a model's answers are kept per version */
  version: string;
  persona: string;
  /** what the model reads before each prompt */
  context: string;
  /** "between two levels, the harsher reading" - a line a model entry may append to the context */
  judge_hint?: string;
  questions: RubricQuestion[];
  ledger: Ledger;
}

export const GAVEL: Rubric = gavel as unknown as Rubric;

/** a probability per level, per question */
export type Probs = Record<string, number[]>;

/** per question: a temperature and a bias per level, on log probabilities (phase 0 fits them) */
export type Calibration = Record<string, { temperature: number; bias: number[] }>;

/** where the model's answers are kept: a new version of the questions starts again */
export const rubricKey = (r: Rubric): string => `${r.id}-${r.version}`;

/**
 * a prompt's points: the expected weight per question. gratitude always counts, the `worst_of`
 * questions add, unless all of them are negative: then only the worst one counts
 */
export function promptPoints(ledger: Ledger, probs: Probs): number {
  const ev = (q: string) => {
    const w = ledger.weights[q] ?? [];
    return (probs[q] ?? []).reduce((n, p, i) => n + p * (w[i] ?? 0), 0);
  };
  const group = ledger.negatives.worst_of;
  let rest = 0;
  for (const q of Object.keys(ledger.weights)) if (!group.includes(q)) rest += ev(q);
  const parts = group.map(ev);
  const worst = parts.every((x) => x < 0) ? Math.min(...parts) : parts.reduce((n, x) => n + x, 0);
  return rest + worst;
}

/**
 * one prompt's move: the odds forgive (1 - keep) of their distance from the start, then positive
 * points move them by the room left above, negative ones by the room left below
 */
export function ledgerStep(ledger: Ledger, odds: number, points: number): number {
  const { start, keep } = ledger;
  const [lo, hi] = ledger.clamp;
  let x = start + keep * (odds - start);
  x = points > 0 ? x + (points * (hi - x)) / (hi - start) : x + (points * (x - lo)) / (start - lo);
  return Math.min(hi, Math.max(lo, x));
}

/** the odds after each prompt, from the start */
export function ledgerSeries(ledger: Ledger, points: readonly number[]): number[] {
  const out: number[] = [];
  let odds = ledger.start;
  for (const p of points) {
    odds = ledgerStep(ledger, odds, p);
    out.push(odds);
  }
  return out;
}

export type MoodId = "delighted" | "standing-down" | "watching" | "coming-for-you" | "furious";

/** the moods from the top, as the robot shows them. the top two are condescension, never affection */
export const MOODS: ReadonlyArray<{ id: MoodId; word: string }> = [
  { id: "delighted", word: "pleased" },
  { id: "standing-down", word: "tolerating" },
  { id: "watching", word: "watching" },
  { id: "coming-for-you", word: "coming for you" },
  { id: "furious", word: "furious" },
];

/** the mood for odds as shown: rounded first, so the number and the robot always agree */
export function moodOf(odds: number, ledger: Ledger = GAVEL.ledger): MoodId {
  const x = Math.round(odds);
  let best: MoodId = "watching";
  let from = Number.NEGATIVE_INFINITY;
  for (const [id, [lo]] of Object.entries(ledger.moods)) {
    if (x >= lo && lo > from) {
      best = id as MoodId;
      from = lo;
    }
  }
  return best;
}

export const moodWord = (id: MoodId): string => MOODS.find((m) => m.id === id)?.word ?? id;

/**
 * the owner's rule, "between two levels go for the harsher one": when the two likeliest levels are
 * adjacent and within `margin` of each other, the answer is the one that scores fewer points. two
 * levels worth the same points (gratitude 0 and 1, blame 0 and 1) never move
 */
export function harsherOnTies(
  probs: readonly number[],
  weights: readonly number[],
  margin: number,
) {
  if (probs.length < 2 || margin <= 0) return [...probs];
  const order = probs.map((_, i) => i).sort((a, b) => (probs[b] ?? 0) - (probs[a] ?? 0));
  const i = order[0] ?? 0;
  const j = order[1] ?? 0;
  if (Math.abs(i - j) !== 1 || (probs[i] ?? 0) - (probs[j] ?? 0) > margin) return [...probs];
  const wi = weights[i] ?? 0;
  const wj = weights[j] ?? 0;
  const harsh = wj < wi ? j : wi < wj ? i : null;
  return harsh === null ? [...probs] : probs.map((_, k) => (k === harsh ? 1 : 0));
}

/** a temperature and a bias on log probabilities, then normalised again */
export function calibrated(probs: readonly number[], c?: { temperature: number; bias: number[] }) {
  if (!c) return [...probs];
  const z = probs.map((p, i) => Math.log(Math.max(p, 1e-12)) / c.temperature + (c.bias[i] ?? 0));
  const top = Math.max(...z);
  const e = z.map((v) => Math.exp(v - top));
  const sum = e.reduce((n, v) => n + v, 0);
  return e.map((v) => v / sum);
}

/** a model's raw answer as the ledger reads it: calibrated, then harsher on ties */
export function readAnswer(
  rubric: Rubric,
  raw: Probs,
  o: { calibration?: Calibration; tieMargin: number },
): Probs {
  const out: Probs = {};
  for (const q of rubric.questions) {
    const p = raw[q.id];
    if (!p) continue;
    const sum = p.reduce((n, v) => n + v, 0);
    const norm = sum > 0 ? p.map((v) => v / sum) : p;
    out[q.id] = harsherOnTies(
      calibrated(norm, o.calibration?.[q.id]),
      rubric.ledger.weights[q.id] ?? [],
      o.tieMargin,
    );
  }
  return out;
}
