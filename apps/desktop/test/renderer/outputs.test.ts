import { describe, expect, it } from "vitest";
import { ordered, prsKey, prTooltip, rollup } from "../../src/renderer/logic/prs.ts";
import type { PrView } from "../../src/shared/ipc.ts";

const pr = (number: number, state?: PrView["state"], o: Partial<PrView> = {}): PrView => ({
  url: `https://github.com/o/r/pull/${number}`,
  repo: "o/r",
  number,
  ...(state ? { state } : {}),
  ...o,
});

describe("a row's PRs", () => {
  it("one open PR is itself, its number and its colour", () => {
    const r = rollup([pr(1, "merged"), pr(2, "failing")]);
    expect(r.label).toBe("#2");
    expect(r.single?.number).toBe(2);
    expect(r.look).toMatchObject({ glyph: "open", tone: "red" });
  });

  it("a stack counts its open ones and shows the worst of them", () => {
    const r = rollup([pr(1, "ready"), pr(2, "pending"), pr(3, "ready"), pr(4, "merged")]);
    expect(r.label).toBe("3 PRs");
    expect(r.single).toBeUndefined();
    expect(r.look.tone).toBe("faint");
    expect(rollup([pr(1, "ready"), pr(2, "failing")]).look.tone).toBe("red");
    expect(rollup([pr(1, "ready"), pr(2, "ready")]).look.tone).toBe("green");
  });

  it("all done: one is itself, several count, merged wins the glyph", () => {
    expect(rollup([pr(1, "merged")]).label).toBe("#1");
    const r = rollup([pr(1, "closed"), pr(2, "merged")]);
    expect(r.label).toBe("2 PRs");
    expect(r.look).toMatchObject({ glyph: "merged", done: true });
  });

  it("no answer from gh yet is an open PR with nothing known", () => {
    expect(rollup([pr(5)]).look).toMatchObject({ glyph: "open", tone: "faint", done: false });
  });

  it("menus and the panel: open ones newest first, then merged and closed", () => {
    const { open, done } = ordered([
      pr(1, "merged"),
      pr(2, "ready"),
      pr(3, "closed"),
      pr(4, "draft"),
    ]);
    expect(open.map((p) => p.number)).toEqual([4, 2]);
    expect(done.map((p) => p.number)).toEqual([3, 1]);
  });

  it("the tooltip says each one, a done one without its review", () => {
    expect(
      prTooltip([
        pr(1, "merged", { review: "approved", title: "a" }),
        pr(2, "failing", { review: "changes", title: "b" }),
      ]),
    ).toBe("o/r #2 · failing · changes requested · b\no/r #1 · merged · a");
  });

  it("the chat header redraws when a PR's look moves, not otherwise", () => {
    expect(prsKey([pr(1, "ready")])).toBe(prsKey([pr(1, "ready", { checkedAt: 9 })]));
    expect(prsKey([pr(1, "ready")])).not.toBe(prsKey([pr(1, "failing")]));
  });
});
