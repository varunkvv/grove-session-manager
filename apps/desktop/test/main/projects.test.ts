import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Combo, type LiveStatus, projectIdOf, type RegistryEntry } from "@grove/core";
import * as record from "@grove/record";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Interruption } from "../../src/main/services/interrupted.ts";
import type { ProjectSnapshot } from "../../src/main/services/projectRecord.ts";
import {
  ProjectsService,
  type RecordPatch,
  START_TTL_MS,
} from "../../src/main/services/projects.ts";
import type { InboxView, SearchHit, SessionRow } from "../../src/shared/ipc.ts";

// the record honours the GROVE_RECORD_SESSION / _AGENT / _PID overrides only with this set
process.env.GROVE_RECORD_TEST = "1";

const tmp = mkdtempSync(path.join(os.tmpdir(), "grove-projects-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
});

const running = (o: Partial<LiveStatus> = {}): LiveStatus => ({
  state: "running",
  at: 1000,
  lastEventAt: 1000,
  ...o,
});

function row(sessionId: string, o: Partial<SessionRow> = {}): SessionRow {
  return {
    key: `/claude/projects/${sessionId}.jsonl`,
    sessionId,
    projectLabel: "elsewhere",
    activityMs: 1,
    parsed: true,
    ...o,
  };
}

/**
 * real record files in a temp folder, read into snapshots by hand (no watchers), and fakes for the
 * sessions, the live state and the review marks
 */
function setup() {
  const dir = mkdtempSync(path.join(tmp, "t-"));
  const combos: Combo[] = [];
  const snaps = new Map<string, ProjectSnapshot>();
  const rows: SessionRow[] = [];
  const live = new Map<string, LiveStatus>();
  const interrupted = new Map<string, Interruption>();
  const holders = new Map<string, RegistryEntry>();
  const alive = new Set<string>();
  const marks = new Set<string>();
  const seen: string[] = [];
  const hits: SearchHit[] = [];
  const got = {
    record: [] as Array<[string, RecordPatch]>,
    inbox: [] as InboxView[],
    projects: 0,
    questions: [] as unknown[],
    stopped: [] as unknown[],
  };
  const read = (id: string) => {
    const c = combos.find((x) => projectIdOf(x) === id);
    if (!c) return;
    const r = record.readRecord(c.root);
    snaps.set(id, {
      root: c.root,
      cards: new Map(r.cards.map((x) => [x.id, x])),
      conclusions: r.conclusions,
      problems: [],
      readAt: 1,
    });
  };
  const svc = new ProjectsService({
    combos: {
      list: () => combos,
      views: () =>
        combos.map((c) => ({
          name: c.name,
          root: c.root,
          workspaceFile: path.join(c.root, `${c.name}.code-workspace`),
          longWork: "background",
          folders: [],
          status: "known",
        })),
      syncReport: () => undefined,
      problemMessage: () => undefined,
    },
    server: () => undefined,
    record: {
      setProjects: () => {},
      snapshot: (id) => snaps.get(id),
      check: (id) => {
        if (id) read(id);
      },
    },
    sessions: {
      list: () => rows,
      get: (key) => rows.find((r) => r.key === key),
      search: async () => hits,
    },
    live: {
      list: () => live,
      interruptions: () => interrupted,
      holder: (id) => holders.get(id),
      isAlive: (id) => alive.has(id),
      markSeen: (ids) => {
        seen.push(...ids);
      },
    },
    reviewed: {
      keys: (prefix) =>
        new Set(
          [...marks]
            .filter((k) => k.startsWith(`${prefix}/`))
            .map((k) => k.slice(prefix.length + 1)),
        ),
      set: async (keys, on) => {
        for (const k of keys) on ? marks.add(k) : marks.delete(k);
      },
    },
    onRecord: (p, patch) => got.record.push([p, patch]),
    onInbox: (v) => got.inbox.push(v),
    onProjects: () => got.projects++,
    onQuestion: (q) => got.questions.push(q),
    onStopped: (s) => got.stopped.push(s),
  });

  /** a project, and writers acting as an agent session or as the person */
  const project = (name: string, prefix: string, goal = "Fix the rounding.") => {
    const root = path.join(dir, name);
    mkdirSync(root);
    const made = record.syncProject(root, { prefix, name, goal });
    if (!made.ok) throw new Error(made.text);
    combos.push({ name, root, prefix, note: goal, folders: [] });
    const as = (session: string, agent = session) => {
      const env = {
        GROVE_RECORD_TEST: "1",
        GROVE_RECORD_SESSION: session,
        GROVE_RECORD_AGENT: agent,
        GROVE_RECORD_PID: String(process.pid),
        GROVE_RECORD_REGISTRY: path.join(tmp, "no-registry"),
      };
      return (tool: string, args: Record<string, unknown>) => {
        const r = record.runTool(tool, args, { root, env });
        if (!r.ok) throw new Error(r.text);
        // under a fake Date every write gets its own second, so orders by time are stable
        if (vi.isFakeTimers()) vi.setSystemTime(Date.now() + 1000);
      };
    };
    /** what ProjectRecordService does after a flush */
    const changed = () => {
      read(name);
      svc.recordChanged(name);
    };
    return { id: name, root, as, changed };
  };

  /** a session grove has indexed, in a project or not, with a live process */
  const session = (
    id: string,
    o: Partial<SessionRow> & { entrypoint?: string; kind?: string } = {},
  ) => {
    const { entrypoint = "claude-vscode", kind = "interactive", ...rest } = o;
    rows.push(row(id, rest));
    holders.set(id, { pid: 1, sessionId: id, status: "busy", kind, entrypoint });
    alive.add(id);
  };

  const heads = (id: string) => svc.recordViews()[id]?.cards ?? [];
  return {
    svc,
    combos,
    project,
    session,
    heads,
    rows,
    live,
    interrupted,
    holders,
    alive,
    marks,
    seen,
    hits,
    got,
    snaps,
  };
}

describe("card heads and conclusion rows", () => {
  it("joins the record with the holder's session", () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    t.session("s-1", { title: "rounding fix", comboName: "chat" });
    chat.as("s-1", "fixer")("card_create", { title: "Fix rounding", body: "Half to even.\nmore" });
    chat.as("s-1")("card_claim", { card: "CHAT-1" });
    chat.as("s-1")("question_ask", { card: "CHAT-1", text: "8h or 4h?", to: "person" });
    record.callAsPerson(chat.root, "card_create", { title: "Write the release note" });
    chat.changed();

    const [one, two] = t.heads("chat");
    expect(one).toMatchObject({
      id: "CHAT-1",
      title: "Fix rounding",
      status: "waiting",
      agent: {
        ref: { sessionId: "s-1", name: "rounding fix" },
        runtime: "vscode",
        state: "idle",
      },
      problems: 0,
    });
    expect(two).toMatchObject({ id: "CHAT-2", status: "todo", agent: undefined });
  });

  it("marks the conclusions that would enter the inbox, and the ones reviewed", () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    const agent = chat.as("s-1", "fixer");
    agent("card_create", { title: "Fix rounding" });
    agent("conclusion_record", { kind: "decision", what: "Round half up.", by: "agent" });
    agent("conclusion_record", { kind: "finding", what: "Only one caller.", by: "agent" });
    agent("conclusion_record", {
      kind: "finding",
      what: "The parser rounds too.",
      by: "agent",
      changes_plan: true,
      card: "CHAT-1",
    });
    agent("conclusion_record", {
      kind: "decision",
      what: "8h, to match the policy.",
      by: "person",
    });
    agent("conclusion_record", {
      kind: "decision",
      what: "Round half to even.",
      by: "agent",
      replaces: "D-1",
    });
    t.marks.add("CHAT/conclusion:D-3");
    chat.changed();

    const rows = Object.fromEntries(
      t.svc.recordViews().chat?.conclusions.map((c) => [c.id, c]) ?? [],
    );
    expect(rows["D-1"]).toMatchObject({
      superseded: true,
      replacedBy: ["D-3"],
      needsReview: false,
    });
    expect(rows["F-1"]).toMatchObject({ needsReview: false });
    expect(rows["F-2"]).toMatchObject({
      needsReview: true,
      card: { id: "CHAT-1", title: "Fix rounding" },
      who: { sessionId: "s-1", name: "fixer" },
    });
    expect(rows["D-2"]).toMatchObject({ by: "person", needsReview: false });
    expect(rows["D-3"]).toMatchObject({ needsReview: true, reviewed: true, replaces: "D-1" });
  });

  it("gives each of the five runtimes", () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    const cases: Array<[string, () => void]> = [
      ["vscode", () => t.session("s-vscode")],
      ["terminal", () => t.session("s-terminal", { entrypoint: "cli" })],
      ["elsewhere", () => t.session("s-elsewhere", { entrypoint: "sdk-cli" })],
      ["background", () => t.session("s-background", { background: { held: true } })],
      [
        "closed",
        () => {
          t.session("s-closed");
          t.alive.delete("s-closed");
        },
      ],
    ];
    for (const [i, [, make]] of cases.entries()) {
      make();
      const id = `s-${cases[i]?.[0]}`;
      chat.as(id)("card_create", { title: id });
      chat.as(id)("card_claim", { card: `CHAT-${i + 1}` });
    }
    chat.changed();
    expect(t.heads("chat").map((h) => [h.title.slice(2), h.agent?.runtime])).toEqual(
      cases.map(([r]) => [r, r]),
    );
  });

  it("keeps stateAt and version through a tool call, and moves them on a state change", () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    t.session("s-1", { live: running({ at: 1000 }) });
    chat.as("s-1")("card_create", { title: "Fix rounding" });
    chat.as("s-1")("card_claim", { card: "CHAT-1" });
    chat.changed();
    const first = t.heads("chat")[0];
    expect(first?.agent).toMatchObject({ state: "working", stateAt: 1000 });
    const pushes = t.got.record.length;

    // a tool call moves live.at and nothing else
    t.rows[0] = { ...(t.rows[0] as SessionRow), live: running({ at: 2000, lastEventAt: 2000 }) };
    t.svc.sessionsChanged();
    const second = t.heads("chat")[0];
    expect(second?.version).toBe(first?.version);
    expect(second?.agent?.stateAt).toBe(1000);
    expect(t.got.record.length).toBe(pushes);

    t.rows[0] = {
      ...(t.rows[0] as SessionRow),
      live: { state: "waiting", at: 3000, lastEventAt: 3000 },
    };
    t.svc.sessionsChanged();
    const third = t.heads("chat")[0];
    expect(third?.status).toBe("waiting");
    expect(third?.agent).toMatchObject({ state: "waiting", stateAt: 3000 });
    expect(third?.version).not.toBe(first?.version);
    expect(t.got.record.at(-1)).toEqual(["chat", { cards: [third], readAt: 1 }]);

    // someone looked: the status moves while the agent's state does not, and the version follows
    t.rows[0] = {
      ...(t.rows[0] as SessionRow),
      live: { state: "waiting", at: 3000, lastEventAt: 3000, seen: true },
    };
    t.svc.sessionsChanged();
    const fourth = t.heads("chat")[0];
    expect(fourth?.status).toBe("in_progress");
    expect(fourth?.version).not.toBe(third?.version);
  });

  it("sends a project's heads whole once, then only the ones that changed", () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    chat.as("s-1")("card_create", { title: "Fix rounding" });
    chat.as("s-1")("card_create", { title: "Write the release note" });
    chat.changed();
    t.svc.inbox();
    expect(t.got.record).toHaveLength(1);
    expect(t.got.record[0]?.[1]).toMatchObject({ replace: true, conclusions: [], problems: [] });
    expect(t.got.record[0]?.[1].cards).toHaveLength(2);

    chat.as("s-1")("comment_add", { card: "CHAT-2", text: "Draft is in." });
    chat.changed();
    t.svc.inbox();
    expect(t.got.record).toHaveLength(2);
    expect(t.got.record[1]?.[1].cards?.map((h) => h.id)).toEqual(["CHAT-2"]);
    expect(t.got.record[1]?.[1].conclusions).toBeUndefined();
  });
});

describe("the card view", () => {
  it("shows the last agent of a done card, not holding, and the thread in order", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setup();
    const chat = t.project("chat", "CHAT");
    t.session("s-1", { title: "rounding fix", usage: [{ model: "claude-opus-5-5" } as never] });
    const agent = chat.as("s-1", "fixer");
    agent("card_create", { title: "Fix rounding", needs: [] });
    agent("card_claim", { card: "CHAT-1" });
    agent("question_ask", { card: "CHAT-1", text: "8h or 4h?", to: "person" });
    agent("question_answer", { card: "CHAT-1", question: 1, text: "8h.", by: "person" });
    agent("comment_add", {
      card: "CHAT-1",
      text: "Notes written.",
      artifacts: [{ type: "file", ref: "artifacts/notes.md" }],
    });
    agent("conclusion_record", { kind: "decision", what: "8h.", by: "person", card: "CHAT-1" });
    agent("card_done", { card: "CHAT-1", summary: "Fixed, see D-1." });
    chat.changed();

    const view = t.svc.card("chat", "chat-1");
    expect(view).toMatchObject({
      id: "CHAT-1",
      status: "done",
      recordStatus: "done",
      agent: {
        ref: { sessionId: "s-1", name: "rounding fix" },
        holding: false,
        runtime: "vscode",
        model: expect.any(String),
        sessionKey: "/claude/projects/s-1.jsonl",
      },
      artifacts: [{ type: "file", ref: "artifacts/notes.md" }],
      conclusions: [{ id: "D-1", by: "person" }],
      problems: [],
    });
    expect(view?.thread.map((x) => (x.kind === "event" ? x.event : x.kind))).toEqual([
      "claim",
      "question",
      "answer",
      "comment",
      "done",
    ]);
    expect(view?.thread[1]).toMatchObject({ to: "person", open: false, answeredBy: [2] });
    expect(view?.thread[2]).toMatchObject({ who: "person", answers: 1 });
    expect(view?.version).toBe(t.heads("chat")[0]?.version);
    expect(t.svc.card("chat", "CHAT-9")).toBeNull();
    expect(t.svc.card("nope", "CHAT-1")).toBeNull();
  });
});

describe("the inbox", () => {
  it("builds every project's rows, Asked first, with the session's runtime and open plan", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setup();
    const chat = t.project("chat", "CHAT");
    const ops = t.project("ops", "OPS");
    t.session("s-1", { comboName: "chat" });
    chat.as("s-1")("card_create", { title: "Fix rounding" });
    chat.as("s-1")("conclusion_record", { kind: "decision", what: "Half to even.", by: "agent" });
    chat.changed();
    ops.as("s-2")("card_create", { title: "Rotate keys" });
    ops.as("s-2")("question_ask", { card: "OPS-1", text: "Which vault?", to: "person" });
    ops.changed();

    const inbox = t.svc.inbox();
    expect(inbox.rows.map((r) => r.id)).toEqual([
      "asked:OPS-1",
      "new:OPS-1",
      "decided:D-1",
      "new:CHAT-1",
    ]);
    expect(inbox.tray).toBe(1);
    expect(inbox.rows.find((r) => r.id === "new:CHAT-1")).toMatchObject({
      project: "chat",
      projectName: "chat",
      runtime: "vscode",
      sessionKey: "/claude/projects/s-1.jsonl",
      open: {},
    });
    expect(inbox.rows[0]).not.toHaveProperty("sessionId");
    expect(t.got.inbox.at(-1)).toEqual(inbox);
  });
});

describe("review", () => {
  it("answers an open question as the person, once, and the card leaves waiting", async () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    t.session("s-1", { comboName: "chat" });
    chat.as("s-1")("card_create", { title: "Fix rounding" });
    chat.as("s-1")("card_claim", { card: "CHAT-1" });
    chat.as("s-1")("question_ask", { card: "CHAT-1", text: "8h or 4h?", to: "person" });
    chat.changed();
    expect(t.heads("chat")[0]?.status).toBe("waiting");
    const asked = t.svc.inbox().rows.find((r) => r.id === "asked:CHAT-1");
    expect(asked?.reviewKeys).toEqual(["question:CHAT-1#1"]);

    await t.svc.review("chat", asked?.reviewKeys ?? [], true);
    const answers = () =>
      record.readCard(chat.root, "CHAT-1")?.comments.filter((c) => c.kind === "answer");
    expect(answers()).toMatchObject([
      { by: "person", session: "person", answers: 1, text: "answered in the agent's chat" },
    ]);
    expect(t.heads("chat")[0]?.status).toBe("in_progress");
    expect(t.svc.inbox().rows.some((r) => r.id === "asked:CHAT-1")).toBe(false);

    // a second Reviewed (a stale row, a double click) adds no second answer
    await t.svc.review("chat", ["question:CHAT-1#1"], true);
    expect(answers()).toHaveLength(1);
    expect(t.marks.size).toBe(0);
  });

  it("stores marks under the prefix, sends seen keys to the live state, and refuses bad keys", async () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    chat.as("s-1")("card_create", { title: "Fix rounding" });
    chat.as("s-1")("conclusion_record", { kind: "decision", what: "Half to even.", by: "agent" });
    chat.changed();
    expect(t.svc.inbox().rows.map((r) => r.id)).toEqual(["decided:D-1", "new:CHAT-1"]);

    await t.svc.review("chat", ["conclusion:D-1", "card:CHAT-1", "seen:s-2"], true);
    expect([...t.marks].sort()).toEqual(["CHAT/card:CHAT-1", "CHAT/conclusion:D-1"]);
    expect(t.seen).toEqual(["s-2"]);
    expect(t.svc.inbox().rows).toEqual([]);
    expect(t.svc.recordViews().chat?.conclusions[0]?.reviewed).toBe(true);

    await t.svc.review("chat", ["card:CHAT-1"], false);
    expect([...t.marks]).toEqual(["CHAT/conclusion:D-1"]);
    expect(t.svc.inbox().rows.map((r) => r.id)).toEqual(["new:CHAT-1"]);

    await expect(t.svc.review("chat", ["card:CHAT-1; rm -rf"], true)).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(t.svc.review("chat", Array(2001).fill("card:CHAT-1"), true)).rejects.toMatchObject(
      {
        code: "invalid",
      },
    );
    await expect(t.svc.review("nope", ["card:CHAT-1"], true)).rejects.toMatchObject({
      code: "no-project",
    });
  });
});

describe("pending starts", () => {
  it("clears a start on a card when that card is claimed after it", () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    chat.as("s-1")("card_create", { title: "Fix rounding" });
    chat.changed();
    const start = t.svc.addStart("chat", "editor", "CHAT-1");
    expect(t.got.projects).toBe(1);
    expect(t.svc.views().projects[0]?.starting).toEqual([start]);

    chat.as("s-2")("card_claim", { card: "CHAT-1" });
    chat.changed();
    t.svc.inbox();
    expect(t.svc.views().projects[0]?.starting).toEqual([]);
    expect(t.got.projects).toBe(2);
  });

  it("drops a start nobody claimed from after 30 minutes", () => {
    vi.useFakeTimers();
    const t = setup();
    const ops = t.project("ops", "OPS");
    ops.changed();
    t.svc.addStart("ops", "background");
    vi.advanceTimersByTime(START_TTL_MS - 60_000);
    expect(t.svc.views().projects[0]?.starting).toHaveLength(1);
    vi.advanceTimersByTime(60_000 + 1000 + 200);
    expect(t.svc.views().projects[0]?.starting).toEqual([]);
    expect(t.got.projects).toBe(2);
  });
});

describe("the notification diffs", () => {
  it("takes each project's first read as its question baseline", () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    const ops = t.project("ops", "OPS");
    chat.as("s-1")("card_create", { title: "Fix rounding" });
    chat.as("s-1")("question_ask", { card: "CHAT-1", text: "Old question", to: "person" });
    chat.changed();
    // ops has no record read yet: its compute says nothing about its questions
    t.svc.recordChanged("ops");
    expect(t.got.questions).toEqual([]);

    chat.as("s-1")("question_ask", { card: "CHAT-1", text: "8h or 4h?", to: "person" });
    chat.as("s-1")("question_ask", { card: "CHAT-1", text: "For the agent", to: "CHAT-1" });
    chat.changed();
    expect(t.got.questions).toEqual([
      { project: "chat", projectName: "chat", card: "CHAT-1", sessionId: "s-1", text: "8h or 4h?" },
    ]);

    // a record that shows up later does not notify the questions it already had
    ops.as("s-2")("card_create", { title: "Rotate keys" });
    ops.as("s-2")("question_ask", { card: "OPS-1", text: "Which vault?", to: "person" });
    ops.changed();
    expect(t.got.questions).toHaveLength(1);
  });

  it("takes the interruptions at start() as the stopped baseline", () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    t.session("s-old", { comboName: "chat" });
    t.session("s-new", { comboName: "chat", title: "rounding fix" });
    t.session("s-holder");
    t.session("s-nowhere");
    chat.as("s-holder")("card_create", { title: "Fix rounding" });
    chat.as("s-holder")("card_claim", { card: "CHAT-1" });
    chat.changed();

    t.interrupted.set("s-old", { at: 1 });
    t.svc.interruptedChanged(t.interrupted);
    t.svc.start();
    t.svc.interruptedChanged(t.interrupted);
    expect(t.got.stopped).toEqual([]);

    t.interrupted.set("s-new", { at: 2 });
    t.interrupted.set("s-holder", { at: 2 });
    t.interrupted.set("s-nowhere", { at: 2 });
    t.svc.interruptedChanged(t.interrupted);
    expect(t.got.stopped).toEqual([
      { sessionId: "s-new", title: "rounding fix", project: "chat" },
      { sessionId: "s-holder", title: undefined, project: "chat" },
    ]);
    t.svc.interruptedChanged(t.interrupted);
    expect(t.got.stopped).toHaveLength(2);
  });

  it("lands a click on the held card, else the project's row, else nowhere", () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    t.session("s-1", { comboName: "chat" });
    t.session("s-2", { comboName: "chat" });
    chat.as("s-1")("card_create", { title: "Fix rounding" });
    chat.as("s-1")("card_claim", { card: "CHAT-1" });
    chat.changed();
    expect(t.svc.landing("s-1", "asked")).toEqual({
      view: "card",
      project: "chat",
      cardId: "CHAT-1",
      back: "inbox",
    });
    expect(t.svc.landing("s-2", "stopped")).toEqual({
      view: "inbox",
      project: "chat",
      rowId: "stopped:s-2",
    });
    expect(t.svc.landing("s-3", "asked")).toBeUndefined();
  });
});

describe("projects and sessions", () => {
  it("shows the first of two combos whose folders share a name, and says why", () => {
    const t = setup();
    const chat = t.project("chat", "CHAT");
    t.project("ops", "OPS");
    const views = () => t.svc.views();
    expect(views().projects.map((p) => p.id)).toEqual(["chat", "ops"]);
    expect(views().projects[0]).toMatchObject({
      root: chat.root,
      goal: "Fix the rounding.",
      prefix: "CHAT",
      rootExists: true,
      server: { state: "unknown" },
      shadowed: [],
      starting: [],
    });
    // a second combo on another folder called chat
    const other = path.join(mkdtempSync(path.join(tmp, "t-")), "chat");
    t.combos.push({ name: "chat copy", root: other, prefix: "CHA2", folders: [] });
    expect(views().projects.map((p) => p.name)).toEqual(["chat", "ops"]);
    expect(views().problem).toBe(
      'Two combos have folders called "chat". Only "chat" is shown. Move one of them.',
    );
  });

  it("finds sessions by their fields, then by full text, each with where it is and how it opens", async () => {
    const t = setup();
    t.project("chat", "CHAT");
    t.session("s-1", { title: "rounding fix", comboName: "chat", activityMs: 5 });
    t.session("s-2", { firstPrompt: "look at the parser", activityMs: 9 });
    t.rows.push(row("s-3", { title: "deploy notes", activityMs: 7 }));
    t.hits.push({ key: "/claude/projects/s-3.jsonl", snippet: "the rounding mode" });

    expect((await t.svc.findSessions("  ")).map((h) => h.sessionId)).toEqual(["s-2", "s-3", "s-1"]);
    const found = await t.svc.findSessions("rounding");
    expect(found).toMatchObject([
      { sessionId: "s-1", where: "chat", project: "chat", runtime: "vscode", open: {} },
      { sessionId: "s-3", where: "elsewhere", runtime: "closed", snippet: "the rounding mode" },
    ]);
    expect((await t.svc.findSessions("parser"))[0]?.title).toBe("look at the parser");
  });
});
