import { describe, expect, it } from "vitest";
import {
  axisTicks,
  formatChange,
  formatCost,
  formatShare,
  formatTime,
  formatValue,
  usageModel,
} from "../../src/renderer/logic/usage.ts";
import type { ProjectId, UsageCell, UsageDay, UsageView } from "../../src/shared/ipc.ts";

/** a friday, at noon */
const NOW = new Date(2026, 9, 9, 12).getTime();
const projects = [
  { id: "auth", name: "Auth SSO" },
  { id: "billing", name: "Billing" },
];

const cell = (cost: number, ms = 0, tokens: UsageCell["tokens"] = [0, 0, 0, 0, 0]): UsageCell => ({
  cost,
  ms,
  tokens,
});
/** a day `back` days ago */
const dayOf = (back: number): string => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - back);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};
function day(
  back: number,
  by: Array<[ProjectId | null, UsageCell]>,
  rest: Partial<UsageDay> = {},
): UsageDay {
  return {
    day: dayOf(back),
    projects: by.map(([project, c]) => ({ project, ...c })),
    models: [{ model: "claude-opus-5-5", ...cell(0) }],
    sessions: [back],
    subagents: 0,
    peak: 0,
    longest: 0,
    unpriced: 0,
    ...rest,
  };
}
const view = (days: UsageDay[]): UsageView => ({
  days: [...days].sort((a, b) => a.day.localeCompare(b.day)),
  counted: 1,
  total: 1,
});
const model = (v: UsageView, range: "1W" | "1M" | "1Y" = "1W", metric = "cost" as const) =>
  usageModel(v, range, metric, projects, NOW);

describe("the usage screen's numbers", () => {
  it("a range ends today: 7 daily bars, 30 daily bars, 52 weekly ones", () => {
    const v = view([
      day(0, [["auth", cell(5)]]),
      day(6, [["auth", cell(2)]]),
      day(7, [["auth", cell(100)]]),
      day(29, [["billing", cell(10)]]),
      day(30, [["billing", cell(1000)]]),
      day(363, [["auth", cell(40)]]),
      day(364, [["auth", cell(5000)]]),
    ]);
    const week = model(v, "1W");
    expect(week.bars).toHaveLength(7);
    expect(week.bars.map((b) => b.total)).toEqual([2, 0, 0, 0, 0, 0, 5]);
    expect(week.bars.map((b) => b.tick)).toEqual(["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]);
    expect(week.bars.at(-1)?.label).toBe("Fri, Oct 9");
    expect(week.tiles.cost.total).toBe(7);

    const month = model(v, "1M");
    expect(month.bars).toHaveLength(30);
    expect(month.tiles.cost.total).toBe(117);
    // a date a week, and today's is one of them
    expect(month.bars.flatMap((b) => b.tick ?? [])).toEqual([
      "Sep 11",
      "Sep 18",
      "Sep 25",
      "Oct 2",
      "Oct 9",
    ]);

    const year = model(v, "1Y");
    expect(year.bars).toHaveLength(52);
    expect(year.tiles.cost.total).toBe(1157);
    // the last week is the seven days ending today
    expect(year.bars.at(-1)).toMatchObject({ label: "Oct 3 - Oct 9", total: 7 });
    expect(year.bars[0]?.total).toBe(40);
    // a month is named on the week that holds its first day
    expect(year.bars.flatMap((b) => b.tick ?? [])).toEqual([
      "Nov",
      "Dec",
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
    ]);
  });

  it("the change is against the range before, and is left out when that range has nothing", () => {
    const v = view([
      day(0, [["auth", cell(118, 60_000)]]),
      day(8, [["auth", cell(100)]]),
      day(40, [["auth", cell(436)]]),
    ]);
    expect(model(v, "1W").tiles.cost.change).toBeCloseTo(0.18);
    expect(model(v, "1W").before).toBe("the week before");
    // nothing counted as time the week before: no line, not +Infinity%
    expect(model(v, "1W").tiles.time).toEqual({ total: 60_000 });
    expect(model(v, "1M").tiles.cost.change).toBeCloseTo(-0.5);
    expect(model(v, "1Y").tiles.cost.change).toBeUndefined();
  });

  it("a bar stacks its projects in the sidebar's order, then the ones in no project", () => {
    const v = view([
      day(0, [
        [null, cell(1)],
        ["billing", cell(3)],
        ["auth", cell(2)],
      ]),
      day(1, [["billing", cell(4)]]),
    ]);
    const m = model(v);
    expect(m.bars.at(-1)?.segments.map((s) => [s.key, s.value])).toEqual([
      ["p:auth", 2],
      ["p:billing", 3],
      ["none", 1],
    ]);
    expect(m.bars.at(-2)?.segments.map((s) => s.key)).toEqual(["p:billing"]);
    expect(m.stack.map((s) => s.key)).toEqual(["p:auth", "p:billing", "none"]);
    // the list is biggest first, and its bars are against the biggest
    expect(m.byProject.map((r) => [r.name, r.value, r.share])).toEqual([
      ["Billing", 7, 1],
      ["Auth SSO", 2, 2 / 7],
      ["No project", 1, 1 / 7],
    ]);
  });

  it("past six rows a list folds the smallest into Other, and so do the bars", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` }));
    const v = view([
      day(
        0,
        many.map((p, i): [ProjectId, UsageCell] => [p.id, cell(10 - i)]),
      ),
    ]);
    const m = usageModel(v, "1W", "cost", many, NOW);
    expect(m.byProject.map((r) => r.name)).toEqual([
      "Project 0",
      "Project 1",
      "Project 2",
      "Project 3",
      "Project 4",
      "Other (3)",
    ]);
    expect(m.byProject.at(-1)).toMatchObject({ key: "other", value: 5 + 4 + 3 });
    expect(m.bars.at(-1)?.segments.map((s) => s.key)).toEqual([
      "p:p0",
      "p:p1",
      "p:p2",
      "p:p3",
      "p:p4",
      "other",
    ]);
    expect(m.bars.at(-1)?.total).toBe(52);
  });

  it("a project that has left the list is still counted, by its folder's name", () => {
    const m = model(view([day(0, [["gone", cell(3)]])]));
    expect(m.byProject).toMatchObject([{ name: "gone", value: 3 }]);
    expect(m.bars.at(-1)?.segments).toMatchObject([{ slice: { project: "gone" }, value: 3 }]);
  });

  it("the metric picks what a bar, a tile and a list measure", () => {
    const v = view([
      day(
        0,
        [
          ["auth", cell(2, 3_600_000, [10, 20, 30, 40, 0])],
          ["billing", cell(9, 60_000, [1, 1, 1, 1, 1])],
        ],
        {
          models: [
            { model: "claude-opus-5-5", ...cell(10, 3_000_000, [11, 21, 31, 41, 1]) },
            { model: "claude-haiku-4-5-20251001", ...cell(1, 660_000) },
          ],
        },
      ),
    ]);
    expect(usageModel(v, "1W", "time", projects, NOW).bars.at(-1)?.total).toBe(3_660_000);
    expect(usageModel(v, "1W", "tokens", projects, NOW).bars.at(-1)?.total).toBe(105);
    expect(usageModel(v, "1W", "cost", projects, NOW).tiles).toMatchObject({
      cost: { total: 11 },
      time: { total: 3_660_000 },
      tokens: { total: 105 },
    });
    expect(usageModel(v, "1W", "time", projects, NOW).byModel.map((r) => r.name)).toEqual([
      "opus 5.5",
      "haiku 4.5",
    ]);
    expect(usageModel(v, "1W", "tokens", projects, NOW).byProject[0]?.name).toBe("Auth SSO");
  });

  it("the extras: a session counts once, the peak and the longest run are the largest day's", () => {
    const tokens: UsageCell["tokens"] = [100, 50, 800, 60, 40];
    const v = view([
      day(0, [["auth", cell(1)]], {
        sessions: [3, 4],
        subagents: 2,
        peak: 4,
        longest: 600_000,
        unpriced: 7,
        models: [{ model: "claude-opus-5-5", ...cell(1, 0, tokens) }],
      }),
      day(2, [["auth", cell(1)]], { sessions: [4, 5], subagents: 1, peak: 9, longest: 60_000 }),
      // outside the week
      day(9, [["auth", cell(1)]], { sessions: [6], subagents: 5, peak: 30, longest: 9_000_000 }),
    ]);
    const m = model(v);
    expect(m.extras).toEqual({
      sessions: 3,
      subagents: 3,
      // cache read over input + cache read + both cache writes
      cacheHit: 0.8,
      peak: 9,
      peakDay: "Wednesday, October 7",
      longest: 600_000,
    });
    expect(m.unpriced).toBe(7);
    expect(model(v, "1M").extras).toMatchObject({ sessions: 4, peak: 30, longest: 9_000_000 });
  });

  it("a range with nothing in it says so, and still has its bars to stand on", () => {
    const m = model(view([day(40, [["auth", cell(1)]])]));
    expect(m.empty).toBe(true);
    expect(m.bars).toHaveLength(7);
    expect(m.ticks).toEqual([{ value: 0, label: "$0" }]);
    expect(m.extras).toMatchObject({ sessions: 0, cacheHit: null, peak: 0 });
    expect(model(view([day(40, [["auth", cell(1)]])]), "1Y").empty).toBe(false);
  });

  it("the axis has at most four round steps, and the top one holds the largest bar", () => {
    const values = (max: number, metric: "cost" | "tokens" | "time") =>
      axisTicks(max, metric).map((t) => t.value);
    const labels = (max: number, metric: "cost" | "tokens" | "time") =>
      axisTicks(max, metric).map((t) => t.label);
    expect(labels(0, "cost")).toEqual(["$0"]);
    expect(values(7, "cost")).toEqual([0, 2, 4, 6, 8]);
    expect(labels(118, "cost")).toEqual(["$0", "$50", "$100", "$150"]);
    expect(labels(1284, "cost")).toEqual(["$0", "$500", "$1,000", "$1,500"]);
    expect(labels(9, "cost")).toEqual(["$0", "$2.50", "$5", "$7.50", "$10"]);
    expect(values(3, "tokens")).toEqual([0, 1, 2, 3]);
    expect(labels(950_000, "tokens")).toEqual(["0", "250k", "500k", "750k", "1M"]);
  });

  it("a time axis is in one unit, the largest the tallest bar holds one of", () => {
    const MIN = 60_000;
    const H = 60 * MIN;
    const D = 24 * H;
    const labels = (max: number) => axisTicks(max, "time").map((t) => t.label);
    expect(labels(0)).toEqual(["0m"]);
    expect(labels(18 * MIN)).toEqual(["0", "5m", "10m", "15m", "20m"]);
    expect(labels(50 * MIN)).toEqual(["0", "15m", "30m", "45m", "60m"]);
    // an hour or more is in hours: `120m` is not a small number
    expect(labels(59 * MIN)).toEqual(["0", "15m", "30m", "45m", "60m"]);
    expect(labels(60 * MIN)).toEqual(["0", "1h"]);
    expect(labels(100 * MIN)).toEqual(["0", "1h", "2h"]);
    expect(labels(5.5 * H)).toEqual(["0", "2h", "4h", "6h"]);
    expect(labels(11 * H)).toEqual(["0", "3h", "6h", "9h", "12h"]);
    expect(labels(23 * H)).toEqual(["0", "6h", "12h", "18h", "24h"]);
    expect(labels(41 * H)).toEqual(["0", "1d", "2d"]);
    expect(labels(2.5 * D)).toEqual(["0", "1d", "2d", "3d"]);
    expect(labels(6.5 * D)).toEqual(["0", "2d", "4d", "6d", "8d"]);
    expect(labels(12 * D)).toEqual(["0", "1w", "2w"]);
    expect(labels(300 * D)).toEqual(["0", "13w", "26w", "39w", "52w"]);
    expect(labels(15 * D)).toEqual(["0", "1w", "2w", "3w"]);
    expect(labels(1000 * H)).toEqual(["0", "2w", "4w", "6w"]);
    expect(labels(800 * D)).toEqual(["0", "1y", "2y", "3y"]);
    // every tick is a whole number of the unit, and the top holds the bar
    for (const max of [7 * MIN, 95 * MIN, 3 * H, 30 * H, 9 * D, 40 * D, 300 * D, 5000 * D]) {
      const ticks = axisTicks(max, "time");
      expect(ticks.at(-1)?.value).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeLessThanOrEqual(5);
      expect(new Set(ticks.slice(1).map((t) => t.label.replace(/[\d]/g, ""))).size).toBe(1);
    }
  });

  it("a duration is written in the unit that fits it, its two largest, rounded down", () => {
    const MIN = 60_000;
    const H = 60 * MIN;
    const D = 24 * H;
    expect(formatTime(0)).toBe("0m");
    expect(formatTime(59_000)).toBe("<1m");
    expect(formatTime(MIN)).toBe("1m");
    expect(formatTime(52 * MIN + 59_000)).toBe("52m");
    expect(formatTime(59 * MIN)).toBe("59m");
    expect(formatTime(60 * MIN)).toBe("1h");
    expect(formatTime(7 * H + 12 * MIN)).toBe("7h 12m");
    expect(formatTime(2 * H)).toBe("2h");
    expect(formatTime(23 * H + 59 * MIN)).toBe("23h 59m");
    expect(formatTime(24 * H)).toBe("1d");
    expect(formatTime(3 * D + 4 * H + 50 * MIN)).toBe("3d 4h");
    expect(formatTime(6 * D + 23 * H)).toBe("6d 23h");
    expect(formatTime(7 * D)).toBe("1w");
    expect(formatTime(3 * 7 * D + 5 * H)).toBe("3w");
    expect(formatTime(41 * D)).toBe("5w 6d");
    expect(formatTime(1000 * H)).toBe("5w 6d");
    expect(formatTime(364 * D)).toBe("52w");
    expect(formatTime(365 * D)).toBe("1y");
    expect(formatTime(365 * D + 12 * 7 * D + 3 * D)).toBe("1y 12w");
    // a day is 24 hours and a year 365 days: no months, and no calendar
    expect(formatTime(30 * D)).toBe("4w 2d");
  });

  it("the words", () => {
    expect(formatCost(1284.4)).toBe("$1,284");
    expect(formatCost(4.2)).toBe("$4.20");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatValue(41 * 3_600_000 + 12 * 60_000, "time")).toBe("1d 17h");
    expect(formatValue(52 * 60_000, "time")).toBe("52m");
    expect(formatValue(3_450_000, "tokens")).toBe("3.5M");
    expect(formatChange(0.18)).toBe("+18%");
    expect(formatChange(-0.04)).toBe("-4%");
    expect(formatChange(0)).toBe("0%");
    expect(formatChange(11)).toBe("12x");
    expect(formatShare(0.943)).toBe("94%");
    expect(formatShare(0.052)).toBe("5.2%");
  });
});
