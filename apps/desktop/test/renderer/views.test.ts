import { describe, expect, it } from "vitest";
import {
  CLOSED,
  filterSessions,
  groupSessions,
  type ListInput,
  needsYouCount,
  PAGE,
  projectHues,
  runningFor,
  sessionOrder,
  startBlocked,
  workLine,
} from "../../src/renderer/logic/views.ts";
import type { InboxRowView, InboxView, ProjectView, SessionHit } from "../../src/shared/ipc.ts";

// local time, like the days a list is cut into
const NOW = new Date(2026, 9, 2, 15, 0).getTime();
const HOUR = 3_600_000;

const hit = (id: string, o: Partial<SessionHit> = {}): SessionHit => ({
  key: `/p/${id}.jsonl`,
  sessionId: id,
  title: id,
  project: "auth",
  where: "auth",
  activityMs: NOW,
  runtime: "closed",
  open: {},
  ...o,
});

const row = (id: string, o: Partial<InboxRowView> = {}): InboxRowView => ({
  key: `/p/${id}.jsonl`,
  sessionId: id,
  title: id,
  where: "auth",
  runtime: "vscode",
  open: {},
  project: "auth",
  kind: "turn",
  at: NOW,
  summary: "",
  reviewKeys: [`seen:${id}`],
  ...o,
});

const project = (partial: Partial<ProjectView>): ProjectView => ({
  id: "auth",
  name: "auth",
  root: "/w/auth",
  goal: "ship sso",
  workspaceFile: "/w/auth/auth.code-workspace",
  longWork: "foreground",
  folders: [],
  status: "known",
  rootExists: true,
  ...partial,
});

describe("the sidebar", () => {
  it("counts each project's own rows, of every kind", () => {
    const inbox: InboxView = {
      rows: [
        row("a"),
        row("b", { kind: "stopped" }),
        row("c", { kind: "permission", project: "billing" }),
      ],
    };
    expect(needsYouCount(inbox, "auth")).toBe(2);
    expect(needsYouCount(inbox, "billing")).toBe(1);
    expect(needsYouCount(inbox, "none")).toBe(0);
  });

  it("gives each project its own colour of nine, and the same one while the list keeps its order", () => {
    const list = (...ids: string[]) => ids.map((id) => ({ id }));
    const seven = list(
      "auth-sso",
      "billing-export",
      "chat-features",
      "data-objects",
      "ops",
      "a",
      "",
    );
    const hues = projectHues(seven);
    expect(new Set(hues.values()).size).toBe(7);
    for (const hue of hues.values()) expect(hue >= 1 && hue <= 9).toBe(true);
    // a project added at the end moves no other, and a rename changes no id
    const eight = projectHues([...seven, { id: "zeta" }]);
    for (const [id, hue] of hues) expect(eight.get(id), id).toBe(hue);
    // alone, a project has the colour its id hashes to, wherever the others put it
    const alone = projectHues(list("chat-features")).get("chat-features");
    expect(projectHues(list("chat-features", "auth-sso")).get("chat-features")).toBe(alone);
    // past nine they are shared, evenly
    const twenty = projectHues(list(...Array.from({ length: 20 }, (_, i) => `p${i}`)));
    const used = [...twenty.values()];
    expect(new Set(used.slice(0, 9)).size).toBe(9);
    expect(new Set(used.slice(9, 18)).size).toBe(9);
  });
});

describe("a list of sessions", () => {
  const DAY = 24 * HOUR;
  // newest first, as main sends them. NOW is a friday, three in the afternoon
  const hits = [
    hit("working", { live: "running", activityMs: NOW - 1000 }),
    hit("today", { title: "sketch the login page", activityMs: NOW - 2 * HOUR }),
    hit("asks", { live: "waiting", branch: "fix/login", activityMs: NOW - 3 * HOUR }),
    hit("seen", { live: "waiting", activityMs: NOW - 4 * HOUR }),
    hit("yesterday", { prompt: "rotate the LOGIN keys", activityMs: NOW - 20 * HOUR }),
    hit("cut", { activityMs: NOW - 30 * HOUR }),
    hit("wednesday", { activityMs: NOW - 2 * DAY }),
    // the first minute of the day three days ago is the last that is not Older
    hit("tuesday", { activityMs: new Date(2026, 8, 29, 0, 0).getTime() }),
    hit("monday-night", { activityMs: new Date(2026, 8, 28, 23, 59).getTime() }),
    hit("last-week", { activityMs: NOW - 8 * DAY }),
    hit("old", { activityMs: NOW - 90 * DAY }),
  ];
  // the inbox's order, newest first: the stop is the later of the two
  const inbox: InboxView = { rows: [row("cut", { kind: "stopped" }), row("asks")] };
  const input = (o: Partial<ListInput> = {}): ListInput => ({
    scope: "auth",
    hits,
    inbox,
    query: "",
    now: NOW,
    older: CLOSED,
    peek: null,
    ...o,
  });
  const drawn = (o: Partial<ListInput> = {}) =>
    groupSessions(input(o)).map((g) => [
      g.label,
      g.items.map((i) => [i.hit.sessionId, i.state].filter(Boolean).join(" ")),
    ]);
  const older = (o: Partial<ListInput> = {}) => groupSessions(input(o)).at(-1);

  it("the ones that need him in the inbox's order, the working, then the days, and Older closed", () => {
    expect(drawn()).toEqual([
      ["Needs you", ["cut stopped", "asks turn"]],
      ["Working", ["working working"]],
      ["Today", ["today", "seen"]],
      ["Yesterday", ["yesterday"]],
      ["Wednesday", ["wednesday"]],
      ["Tuesday", ["tuesday"]],
      ["Older", []],
    ]);
    expect(groupSessions(input()).map((g) => g.key)).toEqual([
      "needs",
      "working",
      "today",
      "yesterday",
      "day-2",
      "day-3",
      "older",
    ]);
    // it says how many it holds while it draws none of them
    expect(older()).toMatchObject({ key: "older", count: 3, open: false });
    const needs = groupSessions(input())[0];
    // what Dismiss clears comes with the row
    expect(needs?.items[0]?.row?.reviewKeys).toEqual(["seen:cut"]);
    // the keyboard is given the rows that are drawn, and no other
    expect(sessionOrder(input())).toEqual(
      drawn()
        .flatMap(([, ids]) => ids)
        .map((x) => String(x).split(" ")[0]),
    );
    expect(sessionOrder(input())).not.toContain("old");
  });

  it("Older draws a page when it opens, and as many more as it is told to", () => {
    const many = Array.from({ length: 120 }, (_, n) =>
      hit(`old-${n}`, { activityMs: NOW - (10 + n) * DAY }),
    );
    const open = (drawn: number, o: Partial<ListInput> = {}) =>
      older({ hits: many, inbox: { rows: [] }, older: { open: true, drawn }, ...o });
    expect(older({ hits: many, inbox: { rows: [] } })).toMatchObject({ count: 120, items: [] });
    expect(open(PAGE)?.items).toHaveLength(50);
    expect(open(PAGE)).toMatchObject({ count: 120, open: true });
    expect(open(100)?.items.at(-1)?.hit.sessionId).toBe("old-99");
    expect(open(150)?.items).toHaveLength(120);
    expect(sessionOrder(input({ hits: many, older: { open: true, drawn: PAGE } }))).toHaveLength(
      50 + 2,
    );
  });

  it("the session in the panel is drawn wherever it is: Older shows as far as its row", () => {
    // a landing on an old session, or a Dismiss that sent a stop of last week down there
    expect(older({ peek: "last-week" })).toMatchObject({ open: true, count: 3 });
    expect(sessionOrder(input({ peek: "old" }))).toContain("old");
    const many = Array.from({ length: 120 }, (_, n) =>
      hit(`old-${n}`, { activityMs: NOW - (10 + n) * DAY }),
    );
    const far = older({ hits: many, inbox: { rows: [] }, peek: "old-70" });
    expect(far?.items).toHaveLength(71);
    // one that is not in Older opens nothing
    expect(older({ peek: "today" })).toMatchObject({ open: false, items: [] });
  });

  it("the filter narrows by title, prompt and branch, every word, and leaves empty groups out", () => {
    expect(drawn({ query: "login" })).toEqual([
      ["Needs you", ["asks turn"]],
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
    ]);
    expect(drawn({ query: "LOGIN keys" })).toEqual([["Yesterday", ["yesterday"]]]);
    expect(drawn({ query: "nothing like it" })).toEqual([]);
    expect(filterSessions(hits, "  ")).toHaveLength(hits.length);
    expect(sessionOrder(input({ query: "login" }))).toEqual(["asks", "today", "yesterday"]);
  });

  it("main's answer is joined in by session id: what it found in what was said, with the words around it", () => {
    // `old` and `cut` hold the word in their conversation, `yesterday` in a prompt its title does not show
    const found = [
      hit("yesterday", { snippet: "rotate the LOGIN keys" }),
      hit("old", { snippet: "…the login redirect loops…" }),
      hit("cut", { snippet: "a login that never ends" }),
      hit("today"),
      // main lists a session the page has not been given yet: it joins nothing
      hit("unlisted", { snippet: "login" }),
    ];
    const shown = (o: Partial<ListInput>) =>
      groupSessions(input({ query: "login", ...o })).map((g) => [
        g.label,
        g.items.map((i) => [i.hit.sessionId, i.snippet].filter(Boolean).join(": ")),
      ]);
    // before the answer: what the page finds by itself, at once
    expect(shown({})).toEqual([
      ["Needs you", ["asks"]],
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
    ]);
    expect(shown({ found })).toEqual([
      ["Needs you", ["cut: a login that never ends", "asks"]],
      ["Today", ["today"]],
      ["Yesterday", ["yesterday: rotate the LOGIN keys"]],
      // Older is not folded while something is typed: nothing is hidden without saying so
      ["Older", ["old: …the login redirect loops…"]],
    ]);
    expect(older({ query: "login", found })).toMatchObject({ open: true, count: 1 });
    // with nothing typed an answer left over from before joins nothing
    expect(drawn({ found })).toEqual(drawn());
  });

  it("a search pages Older the same way, and looks at the project's name on the home screen alone", () => {
    const many = Array.from({ length: 120 }, (_, n) =>
      hit(`old-${n}`, { title: `login ${n}`, activityMs: NOW - (10 + n) * DAY }),
    );
    const typed = { hits: many, inbox: { rows: [] }, query: "login" };
    expect(older(typed)).toMatchObject({ open: true, count: 120 });
    expect(older(typed)?.items).toHaveLength(PAGE);
    expect(older({ ...typed, older: { open: false, drawn: 100 } })?.items).toHaveLength(100);
    // every row of a project's screen is in the project: its name finds nothing there
    expect(drawn({ query: "auth" })).toEqual([]);
    expect(sessionOrder(input({ scope: null, query: "auth" }))).toHaveLength(hits.length);
    expect(sessionOrder(input({ scope: null, query: "AUTH login" }))).toEqual([
      "asks",
      "today",
      "yesterday",
    ]);
  });

  it("a project's list holds its own rows of the inbox. the home screen's holds every project's", () => {
    const both: InboxView = {
      rows: [row("elsewhere", { project: "billing", at: NOW - HOUR }), row("asks")],
    };
    expect(drawn({ hits: [hit("today")], inbox: both })).toEqual([
      // main has not listed it yet: it is drawn from its inbox row all the same
      ["Needs you", ["asks turn"]],
      ["Today", ["today"]],
    ]);
    expect(drawn({ scope: null, hits: [hit("today")], inbox: both })).toEqual([
      ["Needs you", ["elsewhere turn", "asks turn"]],
      ["Today", ["today"]],
    ]);
    // before main has answered at all, the ones that need him are there
    expect(drawn({ scope: null, hits: null, inbox: both })).toEqual([
      ["Needs you", ["elsewhere turn", "asks turn"]],
    ]);
    expect(drawn({ scope: null, hits: null, inbox: { rows: [] } })).toEqual([]);
  });

  it("says how long a working session's turn has run, in whole minutes and then hours", () => {
    const MIN = 60_000;
    expect(runningFor(NOW - 20_000, NOW)).toBe("now");
    expect(runningFor(NOW - 12 * MIN - 59_000, NOW)).toBe("for 12m");
    expect(runningFor(NOW - 59 * MIN, NOW)).toBe("for 59m");
    expect(runningFor(NOW - 150 * MIN, NOW)).toBe("for 2h");
    // a clock a second ahead of main's
    expect(runningFor(NOW + 1000, NOW)).toBe("now");
  });
});

describe("startBlocked", () => {
  it("a missing root", () => {
    const p = project({ rootExists: false });
    expect(startBlocked(p)).toEqual({
      case: "root",
      line: "The project folder is missing: /w/auth",
    });
  });
  it("a project with no goal starts like any other: a session starts from an ask", () => {
    expect(startBlocked(project({ goal: undefined }))).toBeNull();
    expect(startBlocked(project({}))).toBeNull();
  });
});

describe("a turn's work, in one line", () => {
  const work = (o: Partial<Parameters<typeof workLine>[0]>) =>
    workLine({ tools: 0, files: 0, agents: 0, ...o });
  it("counts the steps, the files edited and the agents, then says how long", () => {
    expect(work({ tools: 12, files: 3, ms: 240_000 })).toBe("12 steps · 3 files edited · 4m");
    expect(work({ tools: 1, files: 1, agents: 1, ms: 45_000 })).toBe(
      "1 step · 1 file edited · 1 agent · 45s",
    );
    expect(work({ tools: 48, agents: 2 })).toBe("48 steps · 2 agents");
  });
  it("says nothing of a turn that only talked", () => {
    expect(work({ ms: 9000 })).toBe("");
  });
});
