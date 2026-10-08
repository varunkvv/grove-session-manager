import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Combo, type LiveStatus, projectIdOf, type RegistryEntry } from "@grove/core";
import * as record from "@grove/record";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Interruption } from "../../src/main/services/interrupted.ts";
import type { ProjectSnapshot } from "../../src/main/services/projectRecord.ts";
import { ProjectsService } from "../../src/main/services/projects.ts";
import type { SearchHit } from "../../src/main/services/sessions.ts";
import type { InboxView, SessionRow } from "../../src/shared/ipc.ts";

// the record honours the GROVE_RECORD_SESSION / _AGENT / _PID overrides only with this set
process.env.GROVE_RECORD_TEST = "1";

const tmp = mkdtempSync(path.join(os.tmpdir(), "grove-projects-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
});

const live = (state: LiveStatus["state"], at = 1000, o: Partial<LiveStatus> = {}): LiveStatus => ({
  state,
  at,
  lastEventAt: at,
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
 * fakes for the sessions, the live state and the review marks. the record is real files in a temp
 * folder, read into snapshots by hand (no watchers): only the question notification reads it
 */
function setup() {
  const dir = mkdtempSync(path.join(tmp, "t-"));
  const combos: Combo[] = [];
  const snaps = new Map<string, ProjectSnapshot>();
  const rows: SessionRow[] = [];
  const interrupted = new Map<string, Interruption>();
  const holders = new Map<string, RegistryEntry>();
  const alive = new Set<string>();
  const marks = new Set<string>();
  const seen: string[] = [];
  const hits: SearchHit[] = [];
  const got = {
    inbox: [] as InboxView[],
    sessions: 0,
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
    record: {
      setProjects: () => {},
      snapshot: (id) => snaps.get(id),
    },
    sessions: {
      list: () => rows,
      get: (key) => rows.find((r) => r.key === key),
      search: async () => hits,
    },
    live: {
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
    onInbox: (v) => got.inbox.push(v),
    onSessions: () => got.sessions++,
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

  return {
    svc,
    combos,
    project,
    session,
    rows,
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

const inChat = { comboName: "chat", comboRelation: "root" } as const;

describe("the inbox", () => {
  it("is every project's sessions that need the person, newest first, and waits on no record", () => {
    const t = setup();
    // no record of either project has been read
    t.project("chat", "CHAT");
    t.project("ops", "OPS");
    t.session("s-perm", {
      ...inChat,
      title: "rounding fix",
      gitBranch: "fix/rounding",
      live: live("permission", 3000, { detail: "Bash", target: "pnpm test" }),
    });
    t.session("s-turn", {
      comboName: "ops",
      comboRelation: "inside",
      firstPrompt: "rotate the keys",
      live: live("waiting", 5000, { question: "Which vault?" }),
    });
    t.session("s-failed", { ...inChat, kind: "bg", live: live("failed", 2000) });
    t.rows.push(row("s-cut", { ...inChat, interrupted: { why: "gone", at: 4000 } }));
    t.session("s-working", { ...inChat, live: live("running", 9000) });
    t.session("s-seen", { ...inChat, live: live("waiting", 9000, { seen: true }) });
    // a session in no project is listed nowhere
    t.session("s-nowhere", { live: live("permission", 9000) });

    const inbox = t.svc.inbox();
    expect(inbox.rows.map((r) => [r.sessionId, r.kind, r.project])).toEqual([
      ["s-turn", "turn", "ops"],
      ["s-cut", "stopped", "chat"],
      ["s-perm", "permission", "chat"],
      ["s-failed", "failed", "chat"],
    ]);
    expect(inbox.rows[2]).toEqual({
      key: "/claude/projects/s-perm.jsonl",
      sessionId: "s-perm",
      title: "rounding fix",
      where: "chat",
      runtime: "vscode",
      branch: "fix/rounding",
      open: {},
      project: "chat",
      kind: "permission",
      at: 3000,
      summary: "Bash pnpm test",
      reviewKeys: ["seen:s-perm"],
    });
    expect(inbox.rows[0]).toMatchObject({ title: "rotate the keys", summary: "Which vault?" });
    expect(inbox.rows[1]).toMatchObject({ runtime: "closed", at: 4000 });
    // Claude Code has not said which background session it is: no way to open it yet
    expect(inbox.rows[3]?.open).toEqual({ disabled: "running in the background" });
    expect(t.got.inbox).toEqual([inbox]);
    // nothing moved: nothing is sent again
    t.svc.sessionsChanged();
    t.svc.inbox();
    expect(t.got.inbox).toHaveLength(1);
  });
});

describe("dismiss", () => {
  it("stores a stop under the project's id, sends seen keys to the live state, and refuses bad keys", async () => {
    const t = setup();
    t.project("chat", "CHAT");
    t.rows.push(row("s-cut", { ...inChat, interrupted: { why: "gone", at: 4000 } }));
    t.session("s-turn", { ...inChat, live: live("waiting", 5000) });
    const [turn, cut] = t.svc.inbox().rows;
    expect(cut?.reviewKeys).toEqual(["stopped:s-cut@4000"]);

    await t.svc.review("chat", [...(cut?.reviewKeys ?? []), ...(turn?.reviewKeys ?? [])], true);
    expect([...t.marks]).toEqual(["chat/stopped:s-cut@4000"]);
    // looking at a session is not stored: the live state forgets it at its next event
    expect(t.seen).toEqual(["s-turn"]);
    expect(t.svc.inbox().rows.map((r) => r.sessionId)).toEqual(["s-turn"]);

    await t.svc.review("chat", ["stopped:s-cut@4000"], false);
    expect([...t.marks]).toEqual([]);
    expect(t.svc.inbox().rows.map((r) => r.sessionId)).toEqual(["s-turn", "s-cut"]);

    for (const bad of [["stopped:s-cut; rm -rf"], ["card:CHAT-1"], Array(2001).fill("seen:s-1")]) {
      await expect(t.svc.review("chat", bad, true)).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(t.svc.review("nope", ["seen:s-1"], true)).rejects.toMatchObject({
      code: "no-project",
    });
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
    t.project("chat", "CHAT");
    t.session("s-old", inChat);
    t.session("s-new", { ...inChat, title: "rounding fix" });
    t.session("s-nowhere");

    t.interrupted.set("s-old", { at: 1 });
    t.svc.interruptedChanged(t.interrupted);
    t.svc.start();
    t.svc.interruptedChanged(t.interrupted);
    expect(t.got.stopped).toEqual([]);

    t.interrupted.set("s-new", { at: 2 });
    t.interrupted.set("s-nowhere", { at: 2 });
    t.svc.interruptedChanged(t.interrupted);
    expect(t.got.stopped).toEqual([{ sessionId: "s-new", title: "rounding fix", project: "chat" }]);
    t.svc.interruptedChanged(t.interrupted);
    expect(t.got.stopped).toHaveLength(1);
  });

  it("lands a click on the session's inbox row, else its row in its project's sessions, else nowhere", () => {
    const t = setup();
    t.project("chat", "CHAT");
    const inside = { comboName: "chat", comboRelation: "inside" } as const;
    t.session("s-asks", { ...inside, live: live("permission") });
    t.session("s-quiet", inChat);
    t.session("s-runs", { ...inside, live: live("running") });
    // finished in a subfolder: its project's list leaves it to the palette
    t.session("s-sub", inside);
    t.session("s-nowhere", { live: live("permission") });

    expect(t.svc.landing("s-asks")).toEqual({ view: "inbox", session: "s-asks" });
    expect(t.svc.landing("s-quiet")).toEqual({
      view: "sessions",
      project: "chat",
      session: "s-quiet",
    });
    expect(t.svc.landing("s-runs")).toMatchObject({ view: "sessions", session: "s-runs" });
    // these open in the editor
    expect(t.svc.landing("s-sub")).toBeUndefined();
    expect(t.svc.landing("s-nowhere")).toBeUndefined();
    expect(t.svc.landing("s-unknown")).toBeUndefined();
    expect(t.svc.projectOf("s-sub")).toBe("chat");
    expect(t.svc.projectOf("s-nowhere")).toBeUndefined();
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
    // with no title the prompt is the title, and the word is in it
    expect((await t.svc.findSessions("parser"))[0]).toMatchObject({
      title: "look at the parser",
      snippet: undefined,
    });
    // found by a prompt its title does not show: the prompt says why
    t.session("s-4", { title: "ci cleanup", lastPrompt: "then bump the lexer", activityMs: 1 });
    expect((await t.svc.findSessions("lexer"))[0]).toMatchObject({
      sessionId: "s-4",
      title: "ci cleanup",
      snippet: "then bump the lexer",
    });
  });

  it("lists every session started in a project's folder, newest first, and a subfolder's only while it needs the person or runs", () => {
    const t = setup();
    t.project("chat", "CHAT");
    t.project("ops", "OPS");
    const inOps = { comboName: "ops", comboRelation: "root" } as const;
    const inside = { comboName: "chat", comboRelation: "inside" } as const;
    t.session("s-open", {
      ...inChat,
      title: "rounding fix",
      gitBranch: "fix/rounding",
      activityMs: 20,
    });
    t.rows.push(
      row("s-closed", {
        ...inChat,
        firstPrompt: "look at  the parser",
        lastPrompt: "then the lexer",
        activityMs: 40,
      }),
    );
    // the same session in an older transcript is not a second row
    t.rows.push(row("s-closed", { ...inChat, key: "/moved/s-closed.jsonl", activityMs: 5 }));
    // started in a subfolder: Open takes it to that folder's window, so the palette has it
    t.rows.push(row("s-sub", { ...inside, activityMs: 90 }));
    t.session("s-sub-runs", { ...inside, live: live("running"), activityMs: 80 });
    t.session("s-sub-asks", { ...inside, live: live("waiting"), activityMs: 70 });
    t.session("s-sub-seen", { ...inside, live: live("waiting", 1000, { seen: true }) });
    t.session("s-ops", { ...inOps, activityMs: 60 });
    t.rows.push(row("s-nowhere", { activityMs: 70 }));

    const chat = t.svc.projectSessions("chat");
    expect(chat.map((h) => h.sessionId)).toEqual([
      "s-sub-runs",
      "s-sub-asks",
      "s-closed",
      "s-open",
    ]);
    expect(chat[2]).toMatchObject({
      key: "/claude/projects/s-closed.jsonl",
      title: "look at the parser",
      project: "chat",
      runtime: "closed",
      prompt: "look at the parser\nthen the lexer",
      open: {},
    });
    expect(chat[3]).toMatchObject({
      title: "rounding fix",
      runtime: "vscode",
      branch: "fix/rounding",
    });
    expect(chat[0]?.live).toBe("running");
    // every row of the inbox is in its project's list
    const ids = new Set(chat.map((h) => h.sessionId));
    expect(t.svc.inbox().rows.every((r) => ids.has(r.sessionId))).toBe(true);
    expect(t.svc.projectSessions("ops").map((h) => h.sessionId)).toEqual(["s-ops"]);
    expect(t.svc.projectSessions("no-such-project")).toEqual([]);

    // he has many: no cap
    for (let i = 0; i < 135; i++) {
      t.rows.push(row(`s-many-${i}`, { ...inOps, activityMs: 100 + i }));
    }
    const many = t.svc.projectSessions("ops").map((h) => h.sessionId);
    expect(many).toHaveLength(136);
    expect(many[0]).toBe("s-many-134");
    expect(many.at(-1)).toBe("s-ops");
  });

  it("says the lists changed when what a row shows moved, not on every line an agent writes", () => {
    const t = setup();
    t.project("chat", "CHAT");
    t.session("s-1", { ...inChat, live: live("running", 1000) });
    t.rows.push(row("s-nowhere"));
    const moved = () => {
      const before = t.got.sessions;
      t.svc.sessionsChanged();
      t.svc.inbox();
      return t.got.sessions - before;
    };
    const set = (o: Partial<SessionRow>) => Object.assign(t.rows[0] as SessionRow, o);
    expect(moved()).toBe(1);
    expect(moved()).toBe(0);

    // a tool call: the status's time and the transcript's move, the row does not
    set({ live: live("running", 2000), activityMs: 2000 });
    expect(moved()).toBe(0);
    set({ live: live("waiting", 3000) });
    expect(moved()).toBe(1);
    set({ title: "rounding fix" });
    expect(moved()).toBe(1);
    // its window closed
    t.alive.delete("s-1");
    expect(moved()).toBe(1);
    // a session outside every project is in no list
    Object.assign(t.rows[1] as SessionRow, { title: "elsewhere" });
    expect(moved()).toBe(0);
    t.rows.push(row("s-2", inChat));
    expect(moved()).toBe(1);
  });
});
