import { describe, expect, it } from "vitest";
import {
  artifactName,
  cardOrder,
  cardPrimary,
  cardRole,
  cardTitle,
  decidedLine,
  doneOf,
  filterConclusions,
  groupCards,
  linkWord,
  needsYouCount,
  pendingFor,
  problemsFor,
  projectRows,
  prUrl,
  revealConclusion,
  sourceArtifact,
  startBlocked,
  stateLine,
  threadItems,
} from "../../src/renderer/logic/views.ts";
import type {
  AgentPanel,
  CardHead,
  CardView,
  ConclusionView,
  InboxRowView,
  InboxView,
  ProjectView,
} from "../../src/shared/ipc.ts";

const NOW = Date.parse("2026-10-02T15:00:00Z");
const MIN = 60_000;
const ME = { sessionId: "s1", name: "idp config" };

function row(id: string, partial: Partial<InboxRowView>): InboxRowView {
  return {
    id,
    project: "auth",
    projectName: "auth",
    kind: "decided",
    at: NOW,
    title: "t",
    summary: "",
    reviewKeys: [id],
    ...partial,
  };
}

function head(id: string, partial: Partial<CardHead>): CardHead {
  return {
    id,
    title: id,
    status: "todo",
    at: NOW,
    lastActivity: NOW,
    version: "1",
    problems: 0,
    ...partial,
  };
}

function agent(partial: Partial<AgentPanel>): AgentPanel {
  return {
    ref: ME,
    sessionKey: "k1",
    runtime: "vscode",
    state: "working",
    subagents: [],
    open: {},
    holding: true,
    ...partial,
  };
}

function card(partial: Partial<CardView>): CardView {
  return {
    project: "auth",
    id: "AUTH-1",
    title: "Sign in with SSO",
    body: "",
    status: "todo",
    recordStatus: "todo",
    thread: [],
    artifacts: [],
    needs: [],
    conclusions: [],
    problems: [],
    version: "1",
    ...partial,
  };
}

function conclusion(id: string, partial: Partial<ConclusionView>): ConclusionView {
  return {
    id,
    kind: "decision",
    what: "w",
    why: "",
    by: "agent",
    who: ME,
    replacedBy: [],
    superseded: false,
    related: [],
    changesPlan: false,
    sources: [],
    at: NOW,
    needsReview: true,
    reviewed: false,
    problems: 0,
    ...partial,
  };
}

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
  starting: [],
  ...partial,
});

describe("inbox", () => {
  const inbox: InboxView = {
    rows: [
      row("asked:AUTH-2", { kind: "asked", card: { id: "AUTH-2", title: "" } }),
      row("stopped:s9", { kind: "stopped", project: "data" }),
      row("decided:D-3", { card: { id: "AUTH-2", title: "" }, at: NOW - MIN }),
      row("new:AUTH-4", { kind: "new", card: { id: "AUTH-4", title: "" }, at: NOW - 2 * MIN }),
      row("stopped:s8", { kind: "stopped", at: NOW - 3 * MIN }),
    ],
    tray: 3,
  };

  it("projectRows keeps one project in main's order", () => {
    expect(projectRows(inbox, "auth").map((r) => r.id)).toEqual([
      "asked:AUTH-2",
      "decided:D-3",
      "new:AUTH-4",
      "stopped:s8",
    ]);
    expect(projectRows(inbox, null)).toEqual([]);
  });

  it("pendingFor counts one project's rows naming the card", () => {
    expect(pendingFor(inbox, "auth", "AUTH-2")).toBe(2);
    expect(pendingFor(inbox, "data", "AUTH-2")).toBe(0);
    expect(pendingFor(inbox, "auth", "AUTH-9")).toBe(0);
  });

  it("needsYouCount counts one project's Asked and Stopped rows", () => {
    expect(needsYouCount(inbox, "auth")).toBe(2);
    expect(needsYouCount(inbox, "data")).toBe(1);
  });
});

describe("cards", () => {
  const cards = [
    head("AUTH-10", { status: "todo" }),
    head("AUTH-2", { status: "todo" }),
    head("AUTH-3", { status: "in_progress", lastActivity: NOW - 5 * MIN }),
    head("AUTH-4", { status: "in_progress", lastActivity: NOW - MIN }),
    head("AUTH-5", { status: "stopped", lastActivity: NOW - 9 * MIN }),
    head("AUTH-6", { status: "waiting", lastActivity: NOW - 2 * MIN }),
    head("AUTH-7", { status: "done", lastActivity: NOW - 3 * MIN }),
    head("AUTH-8", { status: "canceled" }),
  ];

  it("groupCards draws the five groups in order, stopped with waiting", () => {
    const groups = groupCards(cards);
    expect(groups.map((g) => [g.key, g.label, g.cards.map((c) => c.id)])).toEqual([
      ["waiting", "Waiting on you", ["AUTH-6", "AUTH-5"]],
      ["in_progress", "In progress", ["AUTH-4", "AUTH-3"]],
      ["todo", "Todo", ["AUTH-2", "AUTH-10"]],
      ["done", "Done", ["AUTH-7"]],
      ["canceled", "Canceled", ["AUTH-8"]],
    ]);
  });

  it("groupCards leaves empty groups out", () => {
    expect(groupCards([head("AUTH-1", {})]).map((g) => g.key)).toEqual(["todo"]);
    expect(groupCards([])).toEqual([]);
  });

  it("cardOrder is the drawn order", () => {
    expect(cardOrder(cards)).toEqual([
      "AUTH-6",
      "AUTH-5",
      "AUTH-4",
      "AUTH-3",
      "AUTH-2",
      "AUTH-10",
      "AUTH-7",
      "AUTH-8",
    ]);
  });

  it("doneOf leaves canceled out of the total", () => {
    expect(doneOf(cards)).toEqual({ done: 1, total: 7 });
  });

  it("cardTitle falls back to the id", () => {
    expect(cardTitle({ id: "AUTH-1", title: "Sign in" })).toBe("Sign in");
    expect(cardTitle({ id: "AUTH-1", title: "(no title)" })).toBe("AUTH-1");
    expect(cardTitle({ id: "AUTH-1", title: "" })).toBe("AUTH-1");
  });
});

describe("cardRole", () => {
  it("a holder is held", () => {
    expect(cardRole(card({ recordStatus: "in_progress", agent: agent({}) }))).toBe("held");
  });
  it("a released todo card whose last agent is not holding is open", () => {
    expect(cardRole(card({ agent: agent({ holding: false }) }))).toBe("open");
  });
  it("a todo card with an open question to the person (display waiting) is open", () => {
    expect(cardRole(card({ status: "waiting" }))).toBe("open");
  });
  it("a done card with a last agent", () => {
    expect(cardRole(card({ recordStatus: "done", agent: agent({ holding: false }) }))).toBe(
      "closed-with-agent",
    );
    expect(cardRole(card({ recordStatus: "canceled", agent: agent({ holding: false }) }))).toBe(
      "closed-with-agent",
    );
  });
  it("a done card no agent claimed", () => {
    expect(cardRole(card({ recordStatus: "done" }))).toBe("closed");
  });
});

describe("startBlocked", () => {
  it("a missing root first", () => {
    const p = project({ rootExists: false, goal: undefined });
    expect(startBlocked(p, true)).toEqual({
      case: "root",
      line: "The project folder is missing: /w/auth",
    });
  });
  it("a failed server", () => {
    const p = project({
      server: { state: "failed", checkedAt: NOW, stage: "spawn", message: "no" },
    });
    expect(startBlocked(p, false)?.case).toBe("server");
  });
  it("no goal blocks a goal start only", () => {
    const p = project({ goal: undefined });
    expect(startBlocked(p, true)).toEqual({
      case: "goal",
      line: "Add a goal so agents know what to work toward.",
    });
    expect(startBlocked(p, false)).toBeNull();
  });
  it("none", () => {
    expect(startBlocked(project({}), true)).toBeNull();
  });
});

describe("cardPrimary", () => {
  const blocked = startBlocked(project({ rootExists: false }), false);

  it("open: a start, or nothing when a start is known to fail", () => {
    expect(cardPrimary(card({}), null)).toEqual({ action: "start" });
    expect(cardPrimary(card({}), blocked)).toBeNull();
  });
  it("held and closed-with-agent: open, disabled as the plan says", () => {
    const held = card({ recordStatus: "in_progress", agent: agent({}) });
    expect(cardPrimary(held, null)).toEqual({ action: "open" });
    expect(cardPrimary(held, blocked)).toEqual({ action: "open" });
    const done = card({
      recordStatus: "done",
      agent: agent({ holding: false, open: { disabled: "It runs in a terminal." } }),
    });
    expect(cardPrimary(done, null)).toEqual({
      action: "open",
      disabled: "It runs in a terminal.",
    });
  });
  it("disabled while grove has not found the session", () => {
    const held = card({ recordStatus: "in_progress", agent: agent({ sessionKey: undefined }) });
    expect(cardPrimary(held, null)).toEqual({
      action: "open",
      disabled: "Grove has not found this agent's session yet.",
    });
  });
  it("closed: no button", () => {
    expect(cardPrimary(card({ recordStatus: "canceled" }), null)).toBeNull();
  });
});

describe("threadItems", () => {
  const thread: CardView["thread"] = [
    { kind: "event", seq: 1, at: NOW + 1, who: ME, event: "claim", text: "" },
    { kind: "comment", seq: 1, at: NOW + 2, who: ME, text: "looking", artifacts: [] },
    {
      kind: "comment",
      seq: 2,
      at: NOW + 3,
      who: ME,
      text: "the diff",
      artifacts: [{ type: "file", ref: "src/a.ts", at: NOW + 3 }],
    },
    {
      kind: "question",
      seq: 3,
      at: NOW + 5,
      who: ME,
      text: "which uri?",
      to: "person",
      open: true,
      artifacts: [],
    },
    {
      kind: "question",
      seq: 4,
      at: NOW + 6,
      who: ME,
      text: "is the api up?",
      to: "AUTH-9",
      open: false,
      artifacts: [],
    },
    { kind: "answer", seq: 5, at: NOW + 7, who: "person", text: "8h", answers: 3, artifacts: [] },
    { kind: "event", seq: 2, at: NOW + 8, who: ME, event: "release", text: "later" },
    { kind: "event", seq: 3, at: NOW + 9, who: ME, event: "takeover", text: "x" },
    { kind: "event", seq: 4, at: NOW + 10, who: ME, event: "done", text: "shipped" },
    { kind: "event", seq: 5, at: NOW + 11, who: ME, event: "cancel", text: "dup" },
    { kind: "event", seq: 6, at: NOW + 12, who: ME, event: "paused", text: "lunch" },
  ];
  const items = threadItems(
    card({
      thread,
      conclusions: [
        conclusion("D-2", { at: NOW + 4, what: "use pkce" }),
        conclusion("F-1", { kind: "finding", at: NOW + 13, what: "no refresh", problems: 1 }),
        conclusion("V-1", { kind: "verdict", by: "person", at: NOW + 14, what: "ship it" }),
      ],
      problems: [
        { file: "cards/AUTH-1/comments/0002.md", problems: ["cut short"] },
        { file: "cards/AUTH-1/claims/0004.md", problems: ["no date"] },
        { file: "cards/AUTH-1/card.md", problems: ["no title"] },
      ],
    }),
  );
  const at = (k: string) => items.find((i) => i.key === k);

  it("merges the thread and the conclusions by at, and skips claim and release", () => {
    expect(items.map((i) => i.key)).toEqual([
      "comment:1",
      "comment:2",
      "D-2",
      "comment:3",
      "comment:4",
      "comment:5",
      "claim:3",
      "claim:4",
      "claim:5",
      "claim:6",
      "F-1",
      "V-1",
    ]);
  });

  it("gives each its word and body", () => {
    expect(items.map((i) => [i.kind, i.word ?? null, i.body ?? null])).toEqual([
      ["comment", null, "looking"],
      ["comment", "attached", "the diff"],
      ["decision", "decided", "use pkce D-2"],
      ["question", "asked you", "which uri?"],
      ["question", "asked", "is the api up?"],
      ["answer", "replied", "8h"],
      ["takeover", "took this over", null],
      ["done", "finished", "shipped"],
      ["cancel", "canceled this", "dup"],
      // a word the page does not know, as written
      ["paused", "paused", "lunch"],
      ["finding", "found", "no refresh F-1"],
      ["verdict", "concluded", "ship it V-1"],
    ]);
  });

  it("an open question to the person waits on you, a question to a card names it", () => {
    expect(at("comment:3")?.waitingOnYou).toBe(true);
    expect(at("comment:4")).toMatchObject({ toCard: "AUTH-9", waitingOnYou: false });
    expect(items.filter((i) => i.waitingOnYou)).toHaveLength(1);
  });

  it("who: the person is you, a conclusion by the person too", () => {
    expect(at("comment:5")?.who.name).toBe("you");
    expect(at("V-1")?.who.name).toBe("you");
    expect(at("D-2")?.who).toEqual({ kind: "agent", id: "s1", name: "idp config" });
  });

  it("carries artifacts and the problems of its own file", () => {
    expect(at("comment:2")?.artifacts).toHaveLength(1);
    expect(at("comment:2")?.problems).toEqual({
      problems: ["cut short"],
      file: "cards/AUTH-1/comments/0002.md",
    });
    expect(at("claim:4")?.problems).toEqual({
      problems: ["no date"],
      file: "cards/AUTH-1/claims/0004.md",
    });
    expect(at("comment:1")?.problems).toEqual({});
    expect(at("F-1")?.problems).toEqual({ count: 1 });
  });
});

describe("problemsFor", () => {
  const problems = [
    { file: "cards/AUTH-1/comments/0003.md", problems: ["a"] },
    { file: "cards/AUTH-1/claims/0001.md", problems: ["b", "c"] },
  ];
  it("maps comment and claim files", () => {
    expect(problemsFor(problems, "cards/AUTH-1/comments/0003.md")).toEqual({
      problems: ["a"],
      file: "cards/AUTH-1/comments/0003.md",
    });
    expect(problemsFor(problems, "cards/AUTH-1/claims/0001.md").problems).toEqual(["b", "c"]);
    expect(problemsFor(problems, "cards/AUTH-1/card.md")).toEqual({});
  });
});

describe("stateLine", () => {
  const at = NOW - 3 * MIN;
  it.each([
    ["working", "working 3m ago", "text-fg-3"],
    ["permission", "waiting on you 3m ago", "text-waiting"],
    ["waiting", "waiting on you 3m ago", "text-waiting"],
    ["failed", "stopped on an API error 3m ago", "text-danger"],
    ["stopped", "stopped mid-turn 3m ago", "text-danger"],
    ["idle", "idle 3m ago", "text-fg-3"],
  ] as const)("%s", (state, text, tone) => {
    expect(stateLine({ state, stateAt: at }, NOW)).toEqual({ text, tone });
  });
  it("closed has no line, and no stateAt has no time", () => {
    expect(stateLine({ state: "closed", stateAt: at }, NOW)).toBeNull();
    expect(stateLine({ state: "working" }, NOW)?.text).toBe("working");
  });
});

describe("links and artifacts", () => {
  it("linkWord", () => {
    expect(linkWord("needs")).toBe("needs");
    expect(linkWord("from")).toBe("created from");
  });
  it("artifactName", () => {
    expect(artifactName({ type: "file", ref: "src/auth/callback.ts" })).toBe("callback.ts");
    expect(artifactName({ type: "branch", ref: "feat/sso" })).toBe("feat/sso");
    expect(artifactName({ type: "pr", ref: "acme/web#2291" })).toBe("PR #2291");
    expect(artifactName({ type: "pr", ref: "#7" })).toBe("PR #7");
    expect(artifactName({ type: "pr", ref: "https://github.com/acme/web/pull/2291" })).toBe(
      "PR #2291",
    );
    expect(artifactName({ type: "pr", ref: "draft" })).toBe("draft");
    expect(artifactName({ type: "link", ref: "https://example.com/docs/sso/" })).toBe(
      "example.com/docs/sso",
    );
    expect(artifactName({ type: "link", ref: "not a url" })).toBe("not a url");
  });
  it("prUrl", () => {
    expect(prUrl("owner/repo#12")).toBe("https://github.com/owner/repo/pull/12");
    // the url the record's tool text asks agents for, with or without what follows the number
    expect(prUrl("https://github.com/owner/repo/pull/12")).toBe(
      "https://github.com/owner/repo/pull/12",
    );
    expect(prUrl("https://github.com/owner/repo/pull/12/files#diff-1")).toBe(
      "https://github.com/owner/repo/pull/12",
    );
    expect(prUrl("https://gitlab.com/owner/repo/-/merge_requests/12")).toBeNull();
    expect(prUrl("https://evil.example/owner/repo/pull/12")).toBeNull();
    expect(prUrl("#12")).toBeNull();
    expect(prUrl("owner/repo")).toBeNull();
  });
  it("a conclusion's source opens like the artifact it is", () => {
    const type = (ref: string) => sourceArtifact({ ref }, 5).type;
    expect(
      sourceArtifact({ ref: "https://acme.slack.com/archives/C01/p17", note: "n" }, 5),
    ).toEqual({ type: "link", ref: "https://acme.slack.com/archives/C01/p17", at: 5 });
    expect(type("https://github.com/owner/repo/pull/12")).toBe("pr");
    expect(type("artifacts/thread-digest.md")).toBe("file");
    // only a web url leaves the app. anything else is a path, shown in Finder when it is inside the project
    expect(type("notes/thread#12")).toBe("file");
    expect(type("javascript:alert(1)")).toBe("file");
    expect(type("file:///etc/passwd")).toBe("file");
  });
});

describe("conclusions", () => {
  const list = [
    conclusion("D-3", {
      what: "Use PKCE for the redirect",
      why: "the spa has no secret",
      card: { id: "AUTH-2", title: "Sign in" },
      area: "auth",
    }),
    conclusion("F-2", { kind: "finding", what: "Tokens expire in 1h", by: "person" }),
    conclusion("V-1", { kind: "verdict", what: "Ship it", who: { sessionId: "s2", name: "rev" } }),
  ];
  const ids = (l: ConclusionView[]) => l.map((c) => c.id);

  it("every word must match, across id, text, card, who and area", () => {
    expect(ids(filterConclusions(list, "", "all"))).toEqual(["D-3", "F-2", "V-1"]);
    expect(ids(filterConclusions(list, "pkce secret", "all"))).toEqual(["D-3"]);
    expect(ids(filterConclusions(list, "pkce tokens", "all"))).toEqual([]);
    expect(ids(filterConclusions(list, "auth-2", "all"))).toEqual(["D-3"]);
    expect(ids(filterConclusions(list, "REV", "all"))).toEqual(["V-1"]);
    expect(ids(filterConclusions(list, "f-2", "all"))).toEqual(["F-2"]);
  });
  it('"you" finds the person\'s', () => {
    expect(ids(filterConclusions(list, "you", "all"))).toEqual(["F-2"]);
  });
  it("the kind filter applies on top", () => {
    expect(ids(filterConclusions(list, "", "verdict"))).toEqual(["V-1"]);
    expect(ids(filterConclusions(list, "pkce", "finding"))).toEqual([]);
  });

  it("decidedLine for the six cases and an unknown chat", () => {
    const who = { sessionId: "s1", name: "idp config" };
    expect(decidedLine({ kind: "decision", by: "person", who })).toBe(
      "Decided by you in idp config's chat",
    );
    expect(decidedLine({ kind: "decision", by: "agent", who })).toBe(
      "Decided by idp config without asking",
    );
    expect(decidedLine({ kind: "finding", by: "person", who })).toBe(
      "Found by you in idp config's chat",
    );
    expect(decidedLine({ kind: "finding", by: "agent", who })).toBe("Found by idp config");
    expect(decidedLine({ kind: "verdict", by: "person", who })).toBe(
      "Concluded by you in idp config's chat",
    );
    expect(decidedLine({ kind: "verdict", by: "agent", who })).toBe(
      "Concluded by idp config without asking",
    );
    expect(decidedLine({ kind: "decision", by: "person" })).toBe(
      "Decided by you in an agent's chat",
    );
    expect(decidedLine({ kind: "decision", by: "agent" })).toBe(
      "Decided by an agent without asking",
    );
  });

  it("revealConclusion resets the query and kind only when they hide the id", () => {
    const shown = { query: "pkce", kind: "all" as const, open: null };
    expect(revealConclusion(list, shown, "D-3")).toEqual({ ...shown, open: "D-3" });
    expect(revealConclusion(list, shown, "V-1")).toEqual({ query: "", kind: "all", open: "V-1" });
    const byKind = { query: "", kind: "decision" as const, open: "D-3" };
    expect(revealConclusion(list, byKind, "F-2")).toEqual({ query: "", kind: "all", open: "F-2" });
  });
});
