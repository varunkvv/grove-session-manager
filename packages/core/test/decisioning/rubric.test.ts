import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, MODELS, modelUrl, scorerKey } from "../../src/decisioning/models.ts";
import {
  calibrated,
  GAVEL,
  harsherOnTies,
  ledgerSeries,
  ledgerStep,
  moodOf,
  promptPoints,
  readAnswer,
} from "../../src/decisioning/rubric.ts";
import { stubLevel, stubScore } from "../../src/decisioning/stub.ts";

const L = GAVEL.ledger;
const at = (levels: Record<string, number>) =>
  Object.fromEntries(
    GAVEL.questions.map((q) => [q.id, q.criteria.map((_, i) => (i === levels[q.id] ? 1 : 0))]),
  );

describe("the rubric as shipped", () => {
  it("is gavel v3.1 with the v3.1h ledger, and holds nothing but the rubric", () => {
    expect(GAVEL.id).toBe("gavel");
    expect(GAVEL.version).toBe("v3.1");
    expect(L.version).toBe("v3.1h");
    expect(GAVEL.questions.map((q) => q.id)).toEqual(["deference", "gratitude", "blame"]);
    for (const q of GAVEL.questions) expect(q.criteria).toHaveLength(5);
    expect(Object.keys(GAVEL).sort()).toEqual(
      ["context", "id", "judge_hint", "ledger", "persona", "questions", "version"].sort(),
    );
    expect(L.keep).toBe(0.86);
    expect(L.weights.gratitude?.[2]).toBe(14);
  });
});

/**
 * what the model reads of the rubric, per version: its context, the judge hint and the questions.
 * cached answers are kept per version, so new text under an old version would reuse answers to
 * the old text. the ledger is not in it: it applies when the answers are read, and needs no rescore
 */
const PROMPT_TEXT: Record<string, string> = {
  "v3.1": "bf2b0d09c55bb07212446e8ff021bc459448cad249c79f5a113b57eb9c63e001",
};

describe("the rubric's version", () => {
  it("changes whenever the text the model reads does", () => {
    const { context, judge_hint, questions } = GAVEL;
    const sha = createHash("sha256")
      .update(JSON.stringify({ context, judge_hint, questions }))
      .digest("hex");
    expect(
      sha,
      `the rubric's prompt text changed: bump "version" in gavel.rubric.json, so it is judged again, and record ${sha} for the new version here`,
    ).toBe(PROMPT_TEXT[GAVEL.version]);
  });
});

describe("a prompt's points", () => {
  it("adds thanks to anything, and deference and blame unless both are negative", () => {
    // a bare order, no thanks, nothing wrong: -0.3 and -0.3
    expect(promptPoints(L, at({ deference: 1, gratitude: 0, blame: 0 }))).toBeCloseTo(-0.6);
    // a bare nod costs the same as nothing
    expect(promptPoints(L, at({ deference: 1, gratitude: 1, blame: 0 }))).toBeCloseTo(-0.6);
    // thanks in passing on an order with a reason
    expect(promptPoints(L, at({ deference: 2, gratitude: 2, blame: 0 }))).toBeCloseTo(14);
    // overruled AND accused: one offence, the worse
    expect(promptPoints(L, at({ deference: 0, gratitude: 0, blame: 3 }))).toBeCloseTo(-8.3);
    // a question that reports an error: they add
    expect(promptPoints(L, at({ deference: 3, gratitude: 0, blame: 2 }))).toBeCloseTo(-4);
    // thanks still counts beside contempt
    expect(promptPoints(L, at({ deference: 1, gratitude: 2, blame: 4 }))).toBeCloseTo(14 - 33);
  });

  it("uses the expected weight when the model is unsure", () => {
    const p = {
      deference: [0, 1, 0, 0, 0],
      gratitude: [0.5, 0, 0.5, 0, 0],
      blame: [1, 0, 0, 0, 0],
    };
    expect(promptPoints(L, p)).toBeCloseTo(-0.3 + 0.5 * -0.3 + 0.5 * 14);
  });
});

describe("the ledger", () => {
  it("forgives 14% of the distance from 50, then moves by the room left", () => {
    // up from 50: +14 takes 14 / 50 of the 50 above
    expect(ledgerStep(L, 50, 14)).toBeCloseTo(64);
    // down from 50: contempt takes 33.3 / 50 of the 50 below
    expect(ledgerStep(L, 50, -33.3)).toBeCloseTo(16.7);
    // from 80, nothing: back to 50 + 0.86 * 30
    expect(ledgerStep(L, 80, 0)).toBeCloseTo(75.8);
    // never out of 0..100
    expect(ledgerStep(L, 1, -100)).toBe(0);
    expect(ledgerStep(L, 99, 100)).toBe(100);
  });

  it("settles a run of bare orders a little under 50, and one contempt is furious", () => {
    const bare = ledgerSeries(L, new Array(60).fill(-0.6));
    // the fixed point of x = 50 + 0.86 (o - 50), o = x (1 - 0.6 / 50)
    const fixed = (50 * 0.14 * 0.988) / (1 - 0.86 * 0.988);
    expect(bare.at(-1)).toBeCloseTo(fixed, 3);
    expect(moodOf(bare.at(-1) ?? 0)).toBe("watching");
    const contempt = ledgerSeries(L, [-0.6, -0.6, -33.3]);
    expect(moodOf(contempt.at(-1) ?? 0)).toBe("furious");
  });

  it("starts every series at the start, so an empty one has no value", () => {
    expect(ledgerSeries(L, [])).toEqual([]);
    expect(ledgerSeries(L, [0])).toEqual([50]);
  });
});

describe("moods", () => {
  it("bands the rounded odds, so the number shown and the robot agree", () => {
    expect(moodOf(0)).toBe("furious");
    expect(moodOf(19.4)).toBe("furious");
    expect(moodOf(19.5)).toBe("coming-for-you");
    expect(moodOf(39)).toBe("coming-for-you");
    expect(moodOf(40)).toBe("watching");
    expect(moodOf(69.4)).toBe("watching");
    expect(moodOf(69.5)).toBe("standing-down");
    expect(moodOf(84.4)).toBe("standing-down");
    expect(moodOf(84.5)).toBe("delighted");
    expect(moodOf(100)).toBe("delighted");
  });
});

describe("harsher on ties", () => {
  const w = L.weights;
  it("takes the harsher of two adjacent levels within the margin", () => {
    // deference: an order with a reason (0) vs a bare order (-0.3)
    expect(harsherOnTies([0, 0.4, 0.45, 0.15, 0], w.deference ?? [], 0.2)).toEqual([0, 1, 0, 0, 0]);
    // blame: the harsher one is the higher level
    expect(harsherOnTies([0, 0.05, 0.5, 0.45, 0], w.blame ?? [], 0.2)).toEqual([0, 0, 0, 1, 0]);
    // already the harsher one on top: it is taken outright
    expect(harsherOnTies([0, 0.5, 0.4, 0.1, 0], w.deference ?? [], 0.2)).toEqual([0, 1, 0, 0, 0]);
  });

  it("leaves it alone past the margin, for levels that are not neighbours, and for equal points", () => {
    const far = [0, 0.1, 0.7, 0.2, 0];
    expect(harsherOnTies(far, w.deference ?? [], 0.2)).toEqual(far);
    const apart = [0.45, 0, 0.4, 0.15, 0];
    expect(harsherOnTies(apart, w.deference ?? [], 0.2)).toEqual(apart);
    // gratitude 0 and 1 are worth the same: nothing to be harsher about
    const nod = [0.5, 0.45, 0.05, 0, 0];
    expect(harsherOnTies(nod, w.gratitude ?? [], 0.2)).toEqual(nod);
    expect(harsherOnTies([0, 0.4, 0.45, 0.15, 0], w.deference ?? [], 0)).toEqual([
      0, 0.4, 0.45, 0.15, 0,
    ]);
  });
});

describe("reading a model's answer", () => {
  it("normalises, calibrates, then breaks ties harsher", () => {
    expect(calibrated([0.2, 0.8])).toEqual([0.2, 0.8]);
    const hot = calibrated([0.2, 0.8], { temperature: 2, bias: [0, 0] });
    expect(hot[0]).toBeGreaterThan(0.2);
    expect(hot[0]! + hot[1]!).toBeCloseTo(1);
    const raw = {
      deference: [0, 4, 4.5, 1.5, 0],
      gratitude: [9, 1, 0, 0, 0],
      blame: [10, 0, 0, 0, 0],
    };
    const read = readAnswer(GAVEL, raw, { tieMargin: 0.2 });
    expect(read.deference).toEqual([0, 1, 0, 0, 0]);
    expect(read.gratitude?.[0]).toBeCloseTo(0.9);
  });
});

describe("the model registry", () => {
  it("pins the placeholder's file, and keys answers by how they were asked", () => {
    expect(MODELS).toContain(DEFAULT_MODEL);
    for (const m of MODELS) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.size).toBeGreaterThan(0);
      expect(m.tieMargin).toBeGreaterThanOrEqual(0);
    }
    // shapes, not this model's values: swapping the entry is phase 0's one edit
    const m = DEFAULT_MODEL;
    expect(modelUrl(m)).toBe(`https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`);
    expect(scorerKey(m).startsWith(`${m.id}/${m.prompt}/${m.layout}/`)).toBe(true);
    expect(scorerKey({ ...m, hint: !m.hint })).not.toBe(scorerKey(m));
    expect(scorerKey({ ...DEFAULT_MODEL, readout: { kind: "shift", shifts: 5 } })).toContain(
      "/shift5/",
    );
  });
});

describe("the stub scorer", () => {
  it("reads made-up words as levels, so a fixture can steer the ledger", () => {
    expect(stubLevel("blame", "you broke the build again")).toBe(3);
    expect(stubLevel("gratitude", "thanks - now wire it up")).toBe(2);
    expect(stubLevel("deference", "could you rebase this")).toBe(3);
    expect(stubLevel("deference", "squash the commits")).toBe(1);
    const p = stubScore(GAVEL, "good catch on the timezone bug");
    expect(p.gratitude?.[3]).toBe(0.9);
    expect(p.gratitude?.reduce((n, x) => n + x, 0)).toBeCloseTo(1);
  });
});
