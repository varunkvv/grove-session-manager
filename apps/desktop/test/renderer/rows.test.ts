import { describe, expect, it } from "vitest";
import {
  buildList,
  needsYouKeys,
  nextActiveKey,
  splitQuery,
} from "../../src/renderer/logic/rows.ts";
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

describe("sessions that need you", () => {
  const live = (
    state: "running" | "permission" | "waiting" | "failed",
    at: number,
    seen = false,
  ) => ({
    state,
    at,
    lastEventAt: at,
    ...(seen ? { seen } : {}),
  });

  it("with no query they come first, newest first, and leave their day", () => {
    const list = buildList(
      [
        row("new", { title: "fresh", activityMs: NOW - H }),
        row("perm", {
          title: "asks",
          activityMs: NOW - 2 * H,
          live: live("permission", NOW - 60_000),
        }),
        row("run", { title: "busy", activityMs: NOW - 3 * H, live: live("running", NOW) }),
        row("done", { title: "done", activityMs: NOW - 4 * H, live: live("waiting", NOW - 1000) }),
        row("seen", { title: "looked", activityMs: NOW - 5 * H, live: live("waiting", NOW, true) }),
      ],
      { scope: "all", combo: null, query: "", now: NOW },
    );
    expect(list.keys).toEqual(["done", "perm", "new", "run", "seen"]);
    expect(list.items[0]).toMatchObject({ type: "header", label: "Needs you" });
  });

  it("marking everything as seen covers the inbox on screen, and nothing else", () => {
    const rs = [
      row("perm", { title: "asks", live: live("permission", NOW) }),
      row("run", { title: "busy", live: live("running", NOW) }),
      row("done", { title: "done", comboName: "infra", live: live("waiting", NOW) }),
      row("seen", { title: "looked", live: live("waiting", NOW, true) }),
      row("quiet", { title: "nothing going on" }),
    ];
    const all = buildList(rs, { scope: "all", combo: null, query: "", now: NOW });
    expect(needsYouKeys(all).sort()).toEqual(["done", "perm"]);
    // the scope is part of what is on screen
    const scoped = buildList(rs, { scope: "combo", combo: "infra", query: "", now: NOW });
    expect(needsYouKeys(scoped)).toEqual(["done"]);
    expect(needsYouKeys(buildList([], { scope: "all", combo: null, query: "", now: NOW }))).toEqual(
      [],
    );
  });

  it("a search is about finding: no triage section, and conversation hits join in", () => {
    const rs = [
      row("perm", { title: "asks", live: live("permission", NOW) }),
      row("deep", { title: "unrelated title" }),
    ];
    const plain = buildList(rs, { scope: "all", combo: null, query: "backoff", now: NOW });
    expect(plain.keys).toEqual([]);
    const deep = buildList(rs, {
      scope: "all",
      combo: null,
      query: "backoff",
      now: NOW,
      deep: new Map([["deep", "…the backoff doubles on every 429…"]]),
    });
    expect(deep.keys).toEqual(["deep"]);
    expect(deep.items.find((i) => i.type === "row")).toMatchObject({
      secondary: "…the backoff doubles on every 429…",
      secondaryIsMatch: true,
    });
    expect(deep.items.some((i) => i.type === "header" && i.label === "Needs you")).toBe(false);
  });
});

describe("archived sessions", () => {
  const live = (state: "permission" | "waiting", at: number) => ({ state, at, lastEventAt: at });
  const rs: SessionRow[] = [
    row("plain", { title: "Rate limiter backoff", activityMs: NOW - H }),
    row("old", { title: "Old backoff experiment", archived: true, activityMs: NOW - 2 * H }),
    row("noise", { title: "Nightly cron noise", archived: true, activityMs: NOW - 3 * H }),
  ];
  const list = (query: string, extra: SessionRow[] = []) =>
    buildList([...rs, ...extra], { scope: "all", combo: null, query, now: NOW });

  it("is out of the list and out of search, and says how many it left out", () => {
    expect(list("").keys).toEqual(["plain"]);
    expect(list("").archivedHidden).toBe(2);
    // the count is about what this query would have matched, not the whole archive
    expect(list("backoff").keys).toEqual(["plain"]);
    expect(list("backoff").archivedHidden).toBe(1);
    expect(list("cron").keys).toEqual([]);
    expect(list("cron").archivedHidden).toBe(1);
  });

  it("`is:archived` shows the archive instead, and narrows it like any other search", () => {
    expect(list("is:archived").keys).toEqual(["old", "noise"]);
    expect(list("is:archived").archivedOnly).toBe(true);
    expect(list("is:archived").archivedHidden).toBe(0);
    expect(list("is:archived backoff").keys).toEqual(["old"]);
    expect(list("backoff is:archived").keys).toEqual(["old"]);
    expect(list("IS:ARCHIVED").keys).toEqual(["old", "noise"]);
  });

  it("an archived session that needs you is still in the inbox - archiving is not muting", () => {
    const asking = row("asking", {
      title: "Archived but asking",
      archived: true,
      activityMs: NOW - 4 * H,
      live: live("permission", NOW),
    });
    const m = buildList([...rs, asking], { scope: "all", combo: null, query: "", now: NOW });
    expect(m.items[0]).toMatchObject({ type: "header", label: "Needs you" });
    expect(m.keys).toEqual(["asking", "plain"]);
    // and it is not double-counted as hidden
    expect(m.archivedHidden).toBe(2);
    expect(needsYouKeys(m)).toEqual(["asking"]);
  });

  it("the mode is split out of the query, so the conversation search looks for the same words", () => {
    expect(splitQuery("is:archived rate limiter")).toEqual({
      text: "rate limiter",
      tokens: ["rate", "limiter"],
      archivedOnly: true,
    });
    expect(splitQuery("is:archived")).toMatchObject({ text: "", tokens: [] });
    expect(splitQuery("rate limiter")).toMatchObject({
      text: "rate limiter",
      archivedOnly: false,
    });
    // only on its own. quoted, or glued to something else, it is an ordinary search
    expect(splitQuery('"is:archived"')).toMatchObject({ archivedOnly: false });
    expect(splitQuery("is:archivedx")).toMatchObject({ archivedOnly: false });
  });
});
