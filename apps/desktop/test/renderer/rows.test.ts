import { describe, expect, it } from "vitest";
import { buildList, nextActiveKey } from "../../src/renderer/logic/rows.ts";
import { usageChip, usageTooltip } from "../../src/renderer/logic/usage.ts";
import type { SessionRow } from "../../src/shared/ipc.ts";

const NOW = Date.parse("2026-09-20T15:00:00");
const H = 3_600_000;

function row(key: string, partial: Partial<SessionRow>): SessionRow {
  return {
    key,
    sessionId: key,
    projectLabel: "proj",
    activityMs: NOW - H,
    parsed: true,
    ...partial,
  };
}

const rows: SessionRow[] = [
  row("a", {
    title: "ENG-412 testing gap analysis",
    comboName: "prod-debug",
    gitBranch: "dev/eng-412",
    activityMs: NOW - H,
  }),
  row("b", {
    title: "Fix flaky invoice sync",
    firstPrompt: "the queue scheduler drops callbacks on retry",
    cwdBase: "queue",
    activityMs: NOW - 26 * H,
  }),
  row("c", {
    title: "Helm chart bump",
    prNumber: 1042,
    comboName: "infra",
    activityMs: NOW - 9 * 24 * H,
  }),
  row("d", { firstPrompt: undefined, title: undefined, activityMs: NOW - 40 * 24 * H }),
];

describe("buildList", () => {
  it("groups by day, newest first, and keeps every row when there is no query", () => {
    const m = buildList(rows, { scope: "all", combo: null, query: "", now: NOW });
    expect(m.items.map((i) => (i.type === "header" ? `# ${i.label}` : i.id))).toEqual([
      "# Today",
      "a",
      "# Yesterday",
      "b",
      "# Last week",
      "c",
      "# Older",
      "d",
    ]);
    expect(m.keys).toEqual(["a", "b", "c", "d"]);
  });

  it("combo scope only shows that combo", () => {
    const m = buildList(rows, { scope: "combo", combo: "infra", query: "", now: NOW });
    expect(m.keys).toEqual(["c"]);
    expect(m.scoped).toBe(true);
  });

  it("a scoped search counts what it is hiding, so a result is never silently lost", () => {
    const m = buildList(rows, { scope: "combo", combo: "infra", query: "queue", now: NOW });
    expect(m.keys).toEqual([]);
    expect(m.elsewhere).toBe(1);
  });

  it("searches title, prompts, combo, branch, folder and PR number. tokens are ANDed", () => {
    const find = (query: string) =>
      buildList(rows, { scope: "all", combo: null, query, now: NOW }).keys;
    expect(find("gap eng")).toEqual(["a"]);
    expect(find("prod-debug")).toEqual(["a"]);
    expect(find("dev/eng")).toEqual(["a"]);
    expect(find("scheduler")).toEqual(["b"]);
    expect(find("queue")).toEqual(["b"]);
    expect(find("#1042")).toEqual(["c"]);
    expect(find("queue helm")).toEqual([]);
  });

  it("when the title does not explain the match, the second line shows the part that does", () => {
    const m = buildList(rows, { scope: "all", combo: null, query: "callbacks", now: NOW });
    const item = m.items.find((i) => i.type === "row");
    expect(item).toMatchObject({ secondaryIsMatch: true });
    expect(item?.type === "row" && item.secondary).toContain("callbacks");
  });

  it("with no query the second line is what the session was about", () => {
    const m = buildList(rows, { scope: "all", combo: null, query: "", now: NOW });
    const b = m.items.find((i) => i.type === "row" && i.id === "b");
    expect(b?.type === "row" && b.secondary).toBe("the queue scheduler drops callbacks on retry");
  });
});

describe("nextActiveKey", () => {
  it("a new query starts from the top", () => {
    expect(nextActiveKey(["a", "b"], ["b", "c"], "b", true)).toBe("b");
    expect(nextActiveKey(["a", "b", "c"], ["c"], "a", true)).toBe("c");
  });
  it("live inserts never move the active row", () => {
    expect(nextActiveKey(["a", "b"], ["new", "a", "b"], "b", false)).toBe("b");
  });
  it("when the active row disappears, the row that took its place becomes active", () => {
    expect(nextActiveKey(["a", "b", "c"], ["a", "c"], "b", false)).toBe("c");
    expect(nextActiveKey(["a", "b"], ["a"], "b", false)).toBe("a");
    expect(nextActiveKey(["a"], [], "a", false)).toBeNull();
  });
});

describe("token usage on a row", () => {
  const u = (model: string, output: number) => ({
    model,
    input: 0,
    output,
    cacheRead: output * 10,
    cacheWrite: 0,
    messages: 1,
  });
  const usage = [
    u("claude-opus-5", 300_000),
    u("claude-sonnet-5", 20_000),
    u("claude-haiku-4-5-20251001", 900),
  ];

  it("shows the two biggest models and counts the rest", () => {
    expect(usageChip(usage)).toBe("opus 5 3.3M · sonnet 5 220k +1");
    expect(usageChip(usage.slice(0, 1))).toBe("opus 5 3.3M");
    expect(usageTooltip(usage).split("\n")).toHaveLength(3);
  });

  it("a model name finds the sessions that used it", () => {
    const list = buildList([row("x", { title: "one", usage }), row("y", { title: "two" })], {
      scope: "all",
      combo: null,
      query: "haiku",
      now: NOW,
    });
    expect(list.keys).toEqual(["x"]);
  });
});
