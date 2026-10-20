import { describe, expect, it } from "vitest";
import {
  formatOdds,
  formatOddsChange,
  moodLine,
  oddsModel,
} from "../../src/renderer/logic/odds.ts";
import type { OddsSession, OddsView } from "../../src/shared/ipc.ts";

const NOW = new Date(2026, 9, 14, 12).getTime();
const day = (back: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const session = (
  key: string,
  back: number,
  series: number[],
  project: string | null = "p1",
): OddsSession => ({
  key,
  title: `session ${key}`,
  project,
  day: day(back),
  at: NOW - back * 86_400_000,
  series,
});
const projects = [
  { id: "p1", name: "auth-sso" },
  { id: "p2", name: "billing" },
];

const view = (o: Partial<OddsView> = {}): OddsView => ({
  days: [
    { day: day(0), odds: 60, prompts: 4 },
    { day: day(2), odds: 40, prompts: 2 },
    // the week before
    { day: day(9), odds: 45, prompts: 3 },
  ],
  sessions: [
    session("a", 0, [64, 70, 80], "p1"),
    session("b", 0, [40, 30, 20], "p2"),
    session("c", 2, [55, 52, 60, 58], null),
    session("d", 2, [64], "p1"),
    session("old", 9, [10, 10, 10], "p2"),
  ],
  current: { key: "a", odds: 80, at: NOW },
  prompts: 20,
  scored: 20,
  ...o,
});

describe("judgment day odds for a range", () => {
  it("averages the range's days, and compares with the range before in points", () => {
    const m = oddsModel(view(), "1W", projects, NOW);
    expect(m.value).toBe(50);
    expect(m.change).toBe(5);
    expect(m.points).toHaveLength(7);
    expect(m.points.at(-1)).toMatchObject({ odds: 60, prompts: 4 });
    expect(m.points.at(-2)?.odds).toBeNull();
    expect(m.judging).toBeUndefined();
  });

  it("ranks projects by their sessions' ends, and lists the best and the worst sessions", () => {
    const m = oddsModel(view(), "1W", projects, NOW);
    // a: 80 and d: 64 in auth-sso, c: 58 in none, b: 20 in billing. old is the week before
    expect(m.byProject.map((r) => [r.name, r.value])).toEqual([
      ["auth-sso", 72],
      ["No project", 58],
      ["billing", 20],
    ]);
    expect(m.byProject[0]?.share).toBeCloseTo(0.72);
    // d has one judged prompt: not ranked. three left: two best, one worst, none twice
    expect(m.best.map((s) => s.key)).toEqual(["a", "c"]);
    expect(m.worst.map((s) => s.key)).toEqual(["b"]);
  });

  it("shows the robot the session judged last, whatever the range", () => {
    expect(oddsModel(view(), "1W", projects, NOW).mood).toBe("standing-down");
    const furious = oddsModel(
      view({ current: { key: "b", odds: 12, at: NOW } }),
      "1M",
      projects,
      NOW,
    );
    expect(furious.mood).toBe("furious");
    const none = oddsModel(
      view({ current: undefined, days: [], sessions: [] }),
      "1W",
      projects,
      NOW,
    );
    expect([none.mood, none.value, none.current]).toEqual(["watching", null, null]);
  });

  it("says how far the judging got while it runs, and averages weeks on the year", () => {
    const m = oddsModel(view({ prompts: 30, scored: 12 }), "1Y", projects, NOW);
    expect(m.judging).toEqual({ scored: 12, prompts: 30 });
    expect(m.points).toHaveLength(52);
    expect(m.points.filter((p) => p.odds !== null).length).toBeGreaterThanOrEqual(2);
  });

  it("words", () => {
    expect(formatOdds(61.6)).toBe("62%");
    expect(formatOddsChange(3.2, "the week before")).toBe("+3 vs the week before");
    expect(formatOddsChange(-0.3, "the week before")).toBe("same as the week before");
    expect(moodLine(18)).toContain("furious");
    expect(moodLine(null)).toContain("watching");
  });
});
