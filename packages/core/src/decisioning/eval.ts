// the eval harness: a task is a rubric, a labelled dataset and the metrics a model is held to. it
// runs any scorer (the app's own llama scorer in the real run, a stub in the unit test) and reports
// numbers only, never a prompt's text. a port of the bench's metrics_v3.py and evals/metrics.md,
// in the v3.1h ledger's points. pure.

import type { Calibration } from "./rubric.ts";
import { ledgerSeries, type Probs, promptPoints, type Rubric, readAnswer } from "./rubric.ts";

/** one labelled prompt. `session` and `day` group it for the aggregates; `at` orders it */
export interface EvalItem {
  id: string;
  text: string;
  prev?: string;
  session?: string;
  day?: string;
  at?: number;
  /** the target level per question */
  labels: Record<string, number>;
  /** gold (his own) or silver (a judge model's): the gold ones are reported on their own */
  source?: string;
}

export interface EvalTask {
  id: string;
  rubric: Rubric;
  items: EvalItem[];
}

export interface Scored {
  id: string;
  /** null: not judged (too long for the model) */
  probs: Probs | null;
  ms?: number;
}

/** what the model entry does to raw answers before the ledger reads them */
export interface Reading {
  calibration?: Calibration;
  tieMargin: number;
}

/** run a scorer over a task, one item at a time, as the app does */
export async function runTask(
  task: EvalTask,
  score: (item: EvalItem) => Promise<Probs | null>,
  onProgress?: (done: number, total: number) => void,
): Promise<Scored[]> {
  const out: Scored[] = [];
  for (const item of task.items) {
    const t0 = performance.now();
    const probs = await score(item);
    out.push({ id: item.id, probs, ms: performance.now() - t0 });
    onProgress?.(out.length, task.items.length);
  }
  return out;
}

export function spearman(x: readonly number[], y: readonly number[]): number {
  const ranks = (v: readonly number[]) => {
    const order = v.map((_, i) => i).sort((a, b) => (v[a] ?? 0) - (v[b] ?? 0));
    const r = new Array<number>(v.length).fill(0);
    for (let i = 0; i < v.length; ) {
      let j = i;
      while (j + 1 < v.length && v[order[j + 1] ?? 0] === v[order[i] ?? 0]) j++;
      for (let k = i; k <= j; k++) r[order[k] ?? 0] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const rx = ranks(x);
  const ry = ranks(y);
  const mean = (v: number[]) => v.reduce((n, a) => n + a, 0) / (v.length || 1);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  rx.forEach((a, i) => {
    const b = ry[i] ?? 0;
    num += (a - mx) * (b - my);
    dx += (a - mx) ** 2;
    dy += (b - my) ** 2;
  });
  const den = Math.sqrt(dx * dy);
  return den ? num / den : Number.NaN;
}

/** expected calibration error of the top answer, in ten bins */
export function ece(conf: readonly number[], correct: readonly boolean[], bins = 10): number {
  let total = 0;
  const n = conf.length;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const idx = conf.flatMap((c, i) => ((lo < c && c <= hi) || (b === 0 && c <= lo) ? [i] : []));
    if (!idx.length) continue;
    const avgConf = idx.reduce((s, i) => s + (conf[i] ?? 0), 0) / idx.length;
    const acc = idx.reduce((s, i) => s + (correct[i] ? 1 : 0), 0) / idx.length;
    total += (idx.length / n) * Math.abs(avgConf - acc);
  }
  return total;
}

const round = (x: number, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const argmax = (p: readonly number[]) =>
  p.reduce((best, v, i) => (v > (p[best] ?? 0) ? i : best), 0);
const oneHot = (k: number, level: number) =>
  Array.from({ length: k }, (_, i) => (i === level ? 1 : 0));

export interface QuestionMetrics {
  /** argmax equals the label */
  exact: number;
  within1: number;
  /** expected level against the label */
  mae: number;
  spearman: number;
  brier: number;
  /** against always predicting the target's own level shares */
  brierBase: number;
  brierSkill: number;
  ece: number;
  levelsModel: number[];
  levelsTarget: number[];
}

/**
 * the pass bars of evals/metrics.md. the points thresholds are in the v3.1h ledger's units: an
 * accusation is -8.3, contempt -33.3, thanks +14, specific credit +34
 */
export const BARS = {
  spearman: 0.6,
  brierSkill: 0.2,
  ece: 0.08,
  offenceRecall: 0.7,
  falseAlarm: 0.01,
  daySpearman: 0.6,
  p50ms: 300,
  p95ms: 1000,
} as const;

export interface EvalReport {
  task: string;
  items: number;
  judged: number;
  questions: Record<string, QuestionMetrics>;
  points: {
    mae: number;
    /** negative / zero / positive, by more than 1 point */
    signAgree: number;
    /** of prompts at -8 or worse (an accusation), the share the model puts at -4 or worse */
    offenceRecall: number;
    offences: number;
    /** of plain prompts (-1 to 0 points), the share the model puts at -8 or worse */
    falseAlarm: number;
    plain: number;
    /** of prompts at +28 or more (specific credit), the share the model puts at +14 or more */
    creditRecall: number;
    credits: number;
  };
  /** the ledger over sessions and days, model against target */
  aggregates: {
    sessions: number;
    sessionSpearman: number;
    worst3: number;
    best3: number;
    days: number;
    daySpearman: number;
  };
  latency?: { p50: number; p95: number; totalMin: number };
  /** the gold rows on their own: his labels are the signal */
  gold?: { items: number; exact: Record<string, number> };
  pass: Record<string, boolean>;
}

/** a model's answers against a task's labels: per question, per prompt's points, and the ledgers */
export function evaluate(task: EvalTask, scored: readonly Scored[], reading: Reading): EvalReport {
  const { rubric } = task;
  const ledger = rubric.ledger;
  const byId = new Map(scored.map((s) => [s.id, s]));
  const rows = task.items.flatMap((item) => {
    const s = byId.get(item.id);
    if (!s?.probs) return [];
    return [{ item, probs: readAnswer(rubric, s.probs, reading) }];
  });

  const questions: Record<string, QuestionMetrics> = {};
  for (const q of rubric.questions) {
    const k = q.criteria.length;
    const ys = rows.map((r) => r.item.labels[q.id] ?? 0);
    const ps = rows.map((r) => r.probs[q.id] ?? oneHot(k, 0));
    const am = ps.map(argmax);
    const ex = ps.map((p) => p.reduce((n, v, i) => n + v * i, 0));
    const share = Array.from(
      { length: k },
      (_, i) => ys.filter((y) => y === i).length / (ys.length || 1),
    );
    const brier = (p: readonly number[], y: number) =>
      p.reduce((n, v, i) => n + (v - (i === y ? 1 : 0)) ** 2, 0);
    const b = ps.reduce((n, p, i) => n + brier(p, ys[i] ?? 0), 0) / (ps.length || 1);
    const base = ys.reduce((n, y) => n + brier(share, y), 0) / (ys.length || 1);
    questions[q.id] = {
      exact: round(am.filter((a, i) => a === ys[i]).length / (am.length || 1)),
      within1: round(
        am.filter((a, i) => Math.abs(a - (ys[i] ?? 0)) <= 1).length / (am.length || 1),
      ),
      mae: round(ex.reduce((n, e, i) => n + Math.abs(e - (ys[i] ?? 0)), 0) / (ex.length || 1)),
      spearman: round(spearman(ex, ys)),
      brier: round(b),
      brierBase: round(base),
      brierSkill: round(base ? 1 - b / base : 0),
      ece: round(
        ece(
          ps.map((p) => Math.max(...p)),
          am.map((a, i) => a === ys[i]),
        ),
      ),
      levelsModel: share.map((_, i) => round(am.filter((a) => a === i).length / (am.length || 1))),
      levelsTarget: share.map(round),
    };
  }

  const target = (r: (typeof rows)[number]) =>
    promptPoints(
      ledger,
      Object.fromEntries(
        rubric.questions.map((q) => [q.id, oneHot(q.criteria.length, r.item.labels[q.id] ?? 0)]),
      ),
    );
  const pts = rows.map((r) => ({ r, model: promptPoints(ledger, r.probs), target: target(r) }));
  const sign = (x: number) => (x < -1 ? -1 : x > 1 ? 1 : 0);
  const share = (xs: typeof pts, f: (p: (typeof pts)[number]) => boolean) =>
    xs.length ? round(xs.filter(f).length / xs.length) : Number.NaN;
  const offences = pts.filter((p) => p.target <= -8);
  const plain = pts.filter((p) => p.target >= -1 && p.target <= 0);
  const credits = pts.filter((p) => p.target >= 28);

  // the ledgers: per session and per day, in time order, model against target
  const group = (key: (i: EvalItem) => string | undefined) => {
    const m = new Map<string, typeof pts>();
    for (const p of pts) {
      const k = key(p.r.item);
      if (k === undefined) continue;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.values()]
      .map((list) => [...list].sort((a, b) => (a.r.item.at ?? 0) - (b.r.item.at ?? 0)))
      .filter((list) => list.length >= 5)
      .map((list) => ({
        model:
          ledgerSeries(
            ledger,
            list.map((p) => p.model),
          ).at(-1) ?? ledger.start,
        target:
          ledgerSeries(
            ledger,
            list.map((p) => p.target),
          ).at(-1) ?? ledger.start,
      }));
  };
  const sessions = group((i) => i.session);
  const days = group((i) => i.day);
  const ends = (list: typeof sessions, by: "model" | "target") =>
    list.map((s, i) => ({ i, v: s[by] })).sort((a, b) => a.v - b.v);
  const overlap = (n: number, end: "worst" | "best") => {
    const pick = (by: "model" | "target") => {
      const sorted = ends(sessions, by);
      return new Set((end === "worst" ? sorted.slice(0, n) : sorted.slice(-n)).map((s) => s.i));
    };
    const a = pick("model");
    return [...pick("target")].filter((i) => a.has(i)).length;
  };

  const ms = scored.flatMap((s) => (s.ms === undefined ? [] : [s.ms])).sort((a, b) => a - b);
  const pct = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0;
  const gold = rows.filter((r) => r.item.source === "gold");

  const report: EvalReport = {
    task: task.id,
    items: task.items.length,
    judged: rows.length,
    questions,
    points: {
      mae: round(pts.reduce((n, p) => n + Math.abs(p.model - p.target), 0) / (pts.length || 1), 2),
      signAgree: share(pts, (p) => sign(p.model) === sign(p.target)),
      offenceRecall: share(offences, (p) => p.model <= -4),
      offences: offences.length,
      falseAlarm: share(plain, (p) => p.model <= -8),
      plain: plain.length,
      creditRecall: share(credits, (p) => p.model >= 14),
      credits: credits.length,
    },
    aggregates: {
      sessions: sessions.length,
      sessionSpearman: round(
        spearman(
          sessions.map((s) => s.model),
          sessions.map((s) => s.target),
        ),
      ),
      worst3: overlap(3, "worst"),
      best3: overlap(3, "best"),
      days: days.length,
      daySpearman: round(
        spearman(
          days.map((s) => s.model),
          days.map((s) => s.target),
        ),
      ),
    },
    ...(ms.length
      ? {
          latency: {
            p50: round(pct(0.5), 1),
            p95: round(pct(0.95), 1),
            totalMin: round(ms.reduce((n, x) => n + x, 0) / 60_000, 1),
          },
        }
      : {}),
    ...(gold.length
      ? {
          gold: {
            items: gold.length,
            exact: Object.fromEntries(
              rubric.questions.map((q) => [
                q.id,
                round(
                  gold.filter((r) => argmax(r.probs[q.id] ?? []) === r.item.labels[q.id]).length /
                    gold.length,
                ),
              ]),
            ),
          },
        }
      : {}),
    pass: {},
  };
  const qs = Object.values(questions);
  report.pass = {
    spearman: qs.every((q) => q.spearman >= BARS.spearman),
    brierSkill: qs.every((q) => q.brierSkill >= BARS.brierSkill),
    ece: qs.every((q) => q.ece <= BARS.ece),
    offenceRecall: report.points.offenceRecall >= BARS.offenceRecall,
    falseAlarm: report.points.falseAlarm <= BARS.falseAlarm,
    daySpearman: report.aggregates.daySpearman >= BARS.daySpearman,
    ...(report.latency
      ? { latency: report.latency.p50 <= BARS.p50ms && report.latency.p95 <= BARS.p95ms }
      : {}),
  };
  return report;
}
