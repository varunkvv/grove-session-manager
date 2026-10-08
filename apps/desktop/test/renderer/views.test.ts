import { describe, expect, it } from "vitest";
import {
  filterSessions,
  groupSessions,
  needsYouCount,
  projectHues,
  sessionOrder,
  startBlocked,
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
  prefix: "AUTH",
  workspaceFile: "/w/auth/auth.code-workspace",
  longWork: "foreground",
  folders: [],
  status: "known",
  rootExists: true,
  server: { state: "ok", checkedAt: NOW, ms: 40, tools: 14 },
  shadowed: [],
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

describe("a project's sessions", () => {
  // newest first, as main sends them
  const hits = [
    hit("working", { live: "running", activityMs: NOW - 1000 }),
    hit("today", { title: "sketch the login page", activityMs: NOW - 2 * HOUR }),
    hit("asks", { live: "waiting", branch: "fix/login", activityMs: NOW - 3 * HOUR }),
    hit("seen", { live: "waiting", activityMs: NOW - 4 * HOUR }),
    hit("yesterday", { prompt: "rotate the LOGIN keys", activityMs: NOW - 20 * HOUR }),
    hit("cut", { activityMs: NOW - 30 * HOUR }),
    hit("last-week", { activityMs: NOW - 8 * 24 * HOUR }),
    hit("old", { activityMs: NOW - 90 * 24 * HOUR }),
  ];
  // the inbox's order, newest first: the stop is the later of the two
  const inbox: InboxView = { rows: [row("cut", { kind: "stopped" }), row("asks")] };
  const drawn = (query = "") =>
    groupSessions(hits, inbox, query, NOW).map((g) => [
      g.label,
      g.items.map((i) => [i.hit.sessionId, i.state].filter(Boolean).join(" ")),
    ]);

  it("the ones that need him in the inbox's order, the working, then the rest by day", () => {
    expect(drawn()).toEqual([
      ["Needs you", ["cut stopped", "asks turn"]],
      ["Working", ["working working"]],
      ["Today", ["today", "seen"]],
      ["Yesterday", ["yesterday"]],
      ["Earlier", ["last-week", "old"]],
    ]);
    const needs = groupSessions(hits, inbox, "", NOW)[0];
    // what Dismiss clears comes with the row
    expect(needs?.items[0]?.row?.reviewKeys).toEqual(["seen:cut"]);
    expect(sessionOrder(hits, inbox, "")).toEqual(
      drawn()
        .flatMap(([, ids]) => ids)
        .map((x) => String(x).split(" ")[0]),
    );
  });

  it("the filter narrows by title, prompt and branch, every word, and leaves empty groups out", () => {
    expect(drawn("login")).toEqual([
      ["Needs you", ["asks turn"]],
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
    ]);
    expect(drawn("LOGIN keys")).toEqual([["Yesterday", ["yesterday"]]]);
    expect(drawn("nothing like it")).toEqual([]);
    expect(filterSessions(hits, "  ")).toHaveLength(hits.length);
    expect(sessionOrder(hits, inbox, "login")).toEqual(["asks", "today", "yesterday"]);
  });

  it("an inbox row of another project's session changes nothing here", () => {
    const other: InboxView = { rows: [row("elsewhere", { project: "billing" })] };
    expect(groupSessions([hit("today")], other, "", NOW)).toMatchObject([
      { key: "today", items: [{ hit: { sessionId: "today" } }] },
    ]);
  });
});

describe("startBlocked", () => {
  it("a missing root first", () => {
    const p = project({ rootExists: false, goal: undefined });
    expect(startBlocked(p)).toEqual({
      case: "root",
      line: "The project folder is missing: /w/auth",
    });
  });
  it("a failed server", () => {
    const p = project({
      server: { state: "failed", checkedAt: NOW, stage: "spawn", message: "no" },
    });
    expect(startBlocked(p)?.case).toBe("server");
  });
  it("no goal", () => {
    expect(startBlocked(project({ goal: undefined }))).toEqual({
      case: "goal",
      line: "Add a goal so agents know what to work toward.",
    });
  });
  it("none", () => {
    expect(startBlocked(project({}))).toBeNull();
  });
});
