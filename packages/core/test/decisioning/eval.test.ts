import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BARS,
  type EvalItem,
  type EvalTask,
  ece,
  evaluate,
  runTask,
  spearman,
} from "../../src/decisioning/eval.ts";
import { GAVEL, type Probs } from "../../src/decisioning/rubric.ts";
import { stubScore } from "../../src/decisioning/stub.ts";

// sixty made-up prompts across every level, labelled by hand per rubric v3.1, in twelve sessions
// over four days. none of them is anyone's real prompt
const items: EvalItem[] = readFileSync(
  path.join(import.meta.dirname, "../../src/decisioning/regression.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const task: EvalTask = { id: "gavel-v3.1h-regression", rubric: GAVEL, items };
const reading = { tieMargin: 0.2 };
const oneHot = (item: EvalItem): Probs =>
  Object.fromEntries(
    GAVEL.questions.map((q) => [q.id, q.criteria.map((_, i) => (i === item.labels[q.id] ? 1 : 0))]),
  );

describe("the eval harness", () => {
  it("holds a model that agrees with every label to every bar", async () => {
    const scored = await runTask(task, async (item) => oneHot(item));
    const r = evaluate(task, scored, reading);
    expect([r.items, r.judged]).toEqual([60, 60]);
    for (const q of Object.values(r.questions)) {
      expect([q.exact, q.mae, q.spearman, q.brierSkill, q.ece]).toEqual([1, 0, 1, 1, 0]);
    }
    expect(r.points).toMatchObject({
      mae: 0,
      signAgree: 1,
      offenceRecall: 1,
      falseAlarm: 0,
      creditRecall: 1,
    });
    expect(r.aggregates).toMatchObject({
      sessions: 12,
      sessionSpearman: 1,
      worst3: 3,
      best3: 3,
      days: 4,
      daySpearman: 1,
    });
    const { latency: _, ...bars } = r.pass;
    expect(Object.values(bars).every(Boolean)).toBe(true);
  });

  it("fails a model that knows nothing", async () => {
    const flat = async (): Promise<Probs> =>
      Object.fromEntries(
        GAVEL.questions.map((q) => [q.id, q.criteria.map(() => 1 / q.criteria.length)]),
      );
    const r = evaluate(task, await runTask(task, flat), { tieMargin: 0 });
    expect(r.pass.brierSkill).toBe(false);
    expect(r.pass.offenceRecall).toBe(false);
    expect(Number.isNaN(r.questions.blame?.spearman)).toBe(true);
  });

  it("runs the keyword stub, reports numbers and never a prompt", async () => {
    const r = evaluate(task, await runTask(task, async (i) => stubScore(GAVEL, i.text)), reading);
    // the stub reads a few words, and these are its numbers: a change to it or to the harness shows
    expect(Object.fromEntries(Object.entries(r.questions).map(([k, q]) => [k, q.exact]))).toEqual({
      deference: 0.55,
      gratitude: 0.95,
      blame: 0.9,
    });
    expect(r.points).toMatchObject({ offenceRecall: 0.9, falseAlarm: 0, creditRecall: 0.8 });
    expect(r.aggregates.sessionSpearman).toBe(0.991);
    expect(r.latency?.p50).toBeGreaterThanOrEqual(0);
    const json = JSON.stringify(r);
    for (const item of items) expect(json).not.toContain(item.text);
  });

  it("leaves an unjudged prompt out, and reports the gold rows on their own", () => {
    const some = items.map((i, n) => ({ ...i, ...(n < 10 ? { source: "gold" } : {}) }));
    const scored = some.map((i, n) => ({ id: i.id, probs: n === 0 ? null : oneHot(i) }));
    const r = evaluate({ ...task, items: some }, scored, reading);
    expect([r.items, r.judged]).toEqual([60, 59]);
    expect(r.gold?.items).toBe(9);
    expect(r.gold?.exact.blame).toBe(1);
  });

  it("ranks with ties the way the eval scripts do", () => {
    expect(spearman([1, 2, 3], [1, 2, 3])).toBe(1);
    expect(spearman([1, 2, 3], [3, 2, 1])).toBe(-1);
    expect(spearman([1, 1, 2], [1, 2, 3])).toBeCloseTo(0.866, 3);
    expect(ece([0.9, 0.9], [true, false])).toBeCloseTo(0.4);
    expect(BARS.spearman).toBe(0.6);
  });
});
