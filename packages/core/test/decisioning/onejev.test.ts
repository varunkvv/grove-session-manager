import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Layout, ModelEntry, Readout } from "../../src/decisioning/models.ts";
import {
  branchPlan,
  foldBranches,
  promptTexts,
  scoreSuffix,
  softmax,
} from "../../src/decisioning/onejev.ts";
import { GAVEL } from "../../src/decisioning/rubric.ts";
import golden from "./qev-golden.json" with { type: "json" };

const READOUTS: Record<string, Readout> = {
  score: { kind: "score" },
  shift: { kind: "shift", shifts: 5 },
  noul: { kind: "noul" },
};

const entry = (
  layout: Layout,
  readout: Readout,
): Pick<ModelEntry, "layout" | "readout" | "hint"> => ({
  layout,
  readout,
  hint: true,
});

const sha = (texts: string[]) => createHash("sha256").update(texts.join("\u0000")).digest("hex");

// the scorer has to send the model exactly what OneJev was trained on. the golden is qev's own
// rendering of made-up prompts, edge cases included (quotes, tabs, unicode, control characters,
// a fake </state>), for both layouts and all three readouts
describe("OneJev's prompt, as qev renders it", () => {
  for (const c of golden.cases) {
    for (const [key, want] of Object.entries(c.sha256)) {
      it(`${key}: ${JSON.stringify(c.text).slice(0, 40)}`, () => {
        const [layout, readout] = key.split("/") as [Layout, string];
        const item = { text: c.text, ...("prev" in c && c.prev ? { prev: c.prev } : {}) };
        const { full, prefix } = promptTexts(entry(layout, READOUTS[readout]!), GAVEL, item);
        expect(sha(full)).toBe(want);
        for (const t of full) expect(t.startsWith(prefix)).toBe(true);
      });
    }
  }
});

describe("reading the branches back", () => {
  it("lists every level with its own number, in the order asked", () => {
    expect(scoreSuffix("How?", ["a", "b", "c"], [2, 0, 1])).toBe(
      "Rate the state: How?\n\nOptions:\nA. level 2: c\nB. level 0: a\nC. level 1: b\n\nAnswer with one letter: A, B, C.",
    );
  });

  it("maps shifted letters back to their levels and averages them", () => {
    const plan = branchPlan(entry("context-in-state", { kind: "shift", shifts: 2 }), GAVEL);
    expect(plan).toHaveLength(6);
    // every branch puts all its weight on whatever level sits at letter A
    const letters = plan.map((b) => b.order!.map((_, pos) => (pos === 0 ? 1 : 0)));
    const probs = foldBranches(GAVEL, plan, letters);
    // order 0 has level 0 at A, order 1 has level 1 at A: half each
    expect(probs.deference).toEqual([0.5, 0.5, 0, 0, 0]);
  });

  it("normalises one yes per level", () => {
    const plan = branchPlan(entry("context-in-state", { kind: "noul" }), GAVEL);
    expect(plan).toHaveLength(15);
    const letters = plan.map((b) => (b.level === 3 ? [0.6, 0.4] : [0.1, 0.9]));
    const probs = foldBranches(GAVEL, plan, letters);
    expect(probs.gratitude?.[3]).toBeCloseTo(0.6 / 1.0);
    expect(probs.gratitude?.reduce((n, x) => n + x, 0)).toBeCloseTo(1);
  });

  it("softmaxes logits", () => {
    const p = softmax([0, Math.log(3)]);
    expect(p[1]).toBeCloseTo(0.75);
  });
});
