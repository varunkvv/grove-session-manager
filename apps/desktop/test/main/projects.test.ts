import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Combo, LiveStatus, RegistryEntry } from "@grove/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Interruption } from "../../src/main/services/interrupted.ts";
import { ProjectsService } from "../../src/main/services/projects.ts";
import type { SearchHit } from "../../src/main/services/sessions.ts";
import type { InboxView, RecapView, SessionRow } from "../../src/shared/ipc.ts";

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

/** fakes for the combos, the sessions, the live state and the dismissals */
function setup() {
  const dir = mkdtempSync(path.join(tmp, "t-"));
  const combos: Combo[] = [];
  const rows: SessionRow[] = [];
  const interrupted = new Map<string, Interruption>();
  const holders = new Map<string, RegistryEntry>();
  const alive = new Set<string>();
  const marks = new Set<string>();
  const seen: string[] = [];
  const hits: SearchHit[] = [];
  /** what the recap service would say of a session, by its key, and every recap asked for */
  const recaps = new Map<string, RecapView>();
  const wanted: Array<[string, unknown]> = [];
  const got = {
    inbox: [] as InboxView[],
    sessions: 0,
    stopped: [] as unknown[],
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
    recaps: {
      view: (key) => recaps.get(key),
      want: async (r, how) => {
        wanted.push([r.sessionId, how]);
      },
    },
    onInbox: (v) => got.inbox.push(v),
    onSessions: () => got.sessions++,
    onStopped: (s) => got.stopped.push(s),
  });

  /** a project, with its folder on disk */
  const project = (name: string, goal = "Fix the rounding.") => {
    const root = path.join(dir, name);
    mkdirSync(root);
    combos.push({ name, root, note: goal, folders: [] });
    return { id: name, root };
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
    recaps,
    wanted,
    got,
  };
}

const inChat = { comboName: "chat", comboRelation: "root" } as const;

describe("the inbox", () => {
  it("says what a session's recap says it needs, and asks for one when a row comes in", () => {
    const t = setup();
    t.project("chat");
    const lines = { goal: "g", done: "d", state: "tests pass", needs: "pick the tenant" };
    t.session("s-turn", { ...inChat, live: live("waiting", 5000, { question: "Which vault?" }) });
    t.session("s-perm", {
      ...inChat,
      live: live("permission", 4000, { detail: "Bash", target: "pnpm test" }),
    });
    t.rows.push(
      row("s-cut", { ...inChat, lastPrompt: "wire it", interrupted: { why: "gone", at: 3000 } }),
    );
    t.session("s-done", { ...inChat, live: live("waiting", 2000, { question: "All done." }) });
    t.session("s-old", { ...inChat, live: live("waiting", 1000, { question: "Ship it?" }) });
    t.recaps.set("/claude/projects/s-turn.jsonl", { lines, at: 1 });
    t.recaps.set("/claude/projects/s-perm.jsonl", { lines, at: 1 });
    t.recaps.set("/claude/projects/s-done.jsonl", {
      lines: { ...lines, needs: "Nothing." },
      at: 1,
    });
    t.recaps.set("/claude/projects/s-old.jsonl", { lines, at: 1, old: true, writing: true });

    const rows = t.svc.inbox().rows;
    expect(rows.map((r) => [r.sessionId, r.summary])).toEqual([
      ["s-turn", "pick the tenant"],
      // a permission prompt is answered from its row: the tool and what it would act on
      ["s-perm", "Bash pnpm test"],
      // no recap yet: what it was working on
      ["s-cut", "wire it"],
      // nothing to do: where it stands
      ["s-done", "tests pass"],
      // the conversation moved on since its recap: the end of its last message, as before
      ["s-old", "Ship it?"],
    ]);
    // the panel draws the recap from the row, a permission row's too
    expect(rows[1]?.recap).toEqual({ lines, at: 1 });
    expect(rows[2]?.recap).toBeUndefined();
    // what was in the inbox when grove started is looked at. permission rows wait for their panel
    expect(t.wanted).toEqual([
      ["s-turn", { moved: false }],
      ["s-cut", { moved: false }],
      ["s-done", { moved: false }],
      ["s-old", { moved: false }],
    ]);

    // the same rows again ask for nothing. a new turn's end does, as a session that moved
    t.wanted.length = 0;
    t.svc.sessionsChanged();
    t.svc.inbox();
    expect(t.wanted).toEqual([]);
    t.rows[0] = { ...t.rows[0]!, live: live("waiting", 6000, { question: "And now?" }) };
    t.session("s-new", { ...inChat, live: live("failed", 7000) });
    t.svc.sessionsChanged();
    t.svc.inbox();
    expect(t.wanted).toEqual([
      ["s-new", { moved: true }],
      ["s-turn", { moved: true }],
    ]);

    // switched on or off: every row is looked at again
    t.wanted.length = 0;
    t.svc.recapsSwitched();
    t.svc.inbox();
    expect(t.wanted.map(([id]) => id)).toEqual(["s-new", "s-turn", "s-cut", "s-done", "s-old"]);
  });

  it("tells the sessions lists when a recap arrives", () => {
    const t = setup();
    t.project("chat");
    t.session("s-quiet", { ...inChat });
    t.svc.inbox();
    const before = t.got.sessions;
    t.recaps.set("/claude/projects/s-quiet.jsonl", { writing: true });
    t.svc.sessionsChanged();
    t.svc.inbox();
    expect(t.got.sessions).toBe(before + 1);
    expect(t.svc.listSessions("chat")[0]?.recap).toEqual({ writing: true });
  });

  it("is every project's sessions that need the person, newest first", () => {
    const t = setup();
    t.project("chat");
    t.project("ops");
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
    t.project("chat");
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

describe("what a notification is about, and where it lands", () => {
  it("takes the interruptions at start() as the stopped baseline", () => {
    const t = setup();
    t.project("chat");
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
    t.project("chat");
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
    const chat = t.project("chat");
    t.project("ops");
    const views = () => t.svc.views();
    expect(views().projects.map((p) => p.id)).toEqual(["chat", "ops"]);
    expect(views().projects[0]).toMatchObject({
      root: chat.root,
      goal: "Fix the rounding.",
      rootExists: true,
    });
    // a second combo on another folder called chat
    const other = path.join(mkdtempSync(path.join(tmp, "t-")), "chat");
    t.combos.push({ name: "chat copy", root: other, folders: [] });
    expect(views().projects.map((p) => p.name)).toEqual(["chat", "ops"]);
    expect(views().problem).toBe(
      'Two combos have folders called "chat". Only "chat" is shown. Move one of them.',
    );
  });

  it("finds sessions by their fields, then by full text, each with where it is and how it opens", async () => {
    const t = setup();
    t.project("chat");
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

  it("a screen's search stays in what the screen lists, and a project's does not find its own name", async () => {
    const t = setup();
    t.project("chat");
    t.project("ops");
    const inOps = { comboName: "ops", comboRelation: "root" } as const;
    t.rows.push(row("s-fix", { ...inChat, title: "rounding fix", cwdBase: "chat", activityMs: 9 }));
    t.rows.push(
      row("s-notes", { ...inChat, title: "deploy notes", cwdBase: "chat", activityMs: 8 }),
    );
    t.rows.push(row("s-ops", { ...inOps, title: "rounding in the chat export", activityMs: 7 }));
    t.rows.push(row("s-loose", { title: "chat with sales", activityMs: 6 }));
    // a finished run in a subfolder, and a script outside every project: no screen lists them
    t.rows.push(
      row("s-sub", { comboName: "chat", comboRelation: "inside", title: "rounding run" }),
    );
    t.rows.push(row("s-script", { entrypoint: "sdk-cli", title: "nightly script" }));
    t.hits.push(
      { key: "/claude/projects/s-notes.jsonl", snippet: "the rounding mode is banker's" },
      { key: "/claude/projects/s-script.jsonl", snippet: "rounding" },
    );
    const ids = async (q: string, scope?: string | null) =>
      (await t.svc.findSessions(q, scope)).map((h) => h.sessionId);

    // the home screen: every project's and the ones in none, by their fields and then by what was said
    const all = await t.svc.findSessions("rounding", null);
    expect(all.map((h) => h.sessionId)).toEqual(["s-fix", "s-ops", "s-notes"]);
    expect(all[2]).toMatchObject({ snippet: "the rounding mode is banker's", project: "chat" });
    // every hit is a row the screen has
    const listed = new Set(t.svc.listSessions(null).map((h) => h.sessionId));
    expect(all.every((h) => listed.has(h.sessionId))).toBe(true);
    // a project's screen: its own sessions
    expect(await ids("rounding", "chat")).toEqual(["s-fix", "s-notes"]);
    // found by its branch, which the home screen's row does not show: the second line says it
    t.rows.push(row("s-branch", { ...inOps, title: "tidy up", gitBranch: "fix/rounding-mode" }));
    const byBranch = (hits: Awaited<ReturnType<typeof t.svc.findSessions>>) =>
      hits.find((h) => h.sessionId === "s-branch")?.snippet;
    expect(byBranch(await t.svc.findSessions("rounding", null))).toBe("fix/rounding-mode");
    // a project's own screen has the branch on the row, and the palette is as it was
    expect(byBranch(await t.svc.findSessions("rounding", "ops"))).toBeUndefined();
    expect(byBranch(await t.svc.findSessions("rounding"))).toBeUndefined();
    t.rows.pop();
    expect(await ids("rounding", "no-such-project")).toEqual([]);
    // the palette still looks everywhere
    expect(await ids("rounding")).toEqual(["s-fix", "s-ops", "s-sub", "s-notes", "s-script"]);

    // nothing was said about chat anywhere: from here on it is the fields alone
    t.hits.length = 0;
    // a project's name finds its sessions on the home screen, and nothing on its own screen
    expect(await ids("chat", null)).toEqual(["s-fix", "s-notes", "s-ops", "s-loose"]);
    expect(await ids("chat", "chat")).toEqual([]);
    expect(await ids("chat", "ops")).toEqual(["s-ops"]);
    // nothing typed is nothing found: the list itself is the screen's
    expect(await ids("  ", null)).toEqual([]);

    // a screen is given up to 200, the palette 50
    for (let i = 0; i < 230; i++) {
      t.rows.push(row(`s-many-${i}`, { ...inOps, title: `rounding ${i}`, activityMs: 100 + i }));
    }
    expect(await t.svc.findSessions("rounding", "ops")).toHaveLength(200);
    expect(await t.svc.findSessions("rounding", null)).toHaveLength(200);
    expect(await t.svc.findSessions("rounding")).toHaveLength(50);
  });

  it("lists every session started in a project's folder, newest first, and a subfolder's only while it needs the person or runs", () => {
    const t = setup();
    t.project("chat");
    t.project("ops");
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

    const chat = t.svc.listSessions("chat");
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
    expect(t.svc.listSessions("ops").map((h) => h.sessionId)).toEqual(["s-ops"]);
    expect(t.svc.listSessions("no-such-project")).toEqual([]);

    // he has many: no cap
    for (let i = 0; i < 135; i++) {
      t.rows.push(row(`s-many-${i}`, { ...inOps, activityMs: 100 + i }));
    }
    const many = t.svc.listSessions("ops").map((h) => h.sessionId);
    expect(many).toHaveLength(136);
    expect(many[0]).toBe("s-many-134");
    expect(many.at(-1)).toBe("s-ops");
  });

  it("lists every project's sessions with a null scope, and the ones in no project that a person started", () => {
    const t = setup();
    t.project("chat");
    t.project("ops");
    const inside = { comboName: "chat", comboRelation: "inside" } as const;
    t.rows.push(row("s-chat", { ...inChat, activityMs: 90 }));
    t.rows.push(row("s-ops", { comboName: "ops", comboRelation: "root", activityMs: 80 }));
    // a project's own rule holds here too: a finished one in a subfolder is the palette's
    t.rows.push(row("s-sub", { ...inside, activityMs: 70 }));
    t.session("s-sub-asks", { ...inside, live: live("waiting"), activityMs: 60 });
    // in no project: the editor, a terminal, the desktop app, and one that does not say
    t.rows.push(row("s-loose", { entrypoint: "claude-vscode", activityMs: 50 }));
    t.rows.push(row("s-cli", { entrypoint: "cli", activityMs: 40 }));
    t.rows.push(row("s-desktop", { entrypoint: "claude-desktop", activityMs: 30 }));
    t.rows.push(row("s-unsaid", { activityMs: 20 }));
    // `claude -p` and SDK apps are scripts: only while one runs
    t.rows.push(row("s-script", { entrypoint: "sdk-cli", activityMs: 95 }));
    t.rows.push(row("s-sdk", { entrypoint: "sdk-ts", activityMs: 94 }));
    t.rows.push(
      row("s-script-runs", { entrypoint: "sdk-cli", live: live("running"), activityMs: 10 }),
    );

    const all = t.svc.listSessions(null);
    expect(all.map((h) => h.sessionId)).toEqual([
      "s-chat",
      "s-ops",
      "s-sub-asks",
      "s-loose",
      "s-cli",
      "s-desktop",
      "s-unsaid",
      "s-script-runs",
    ]);
    // a project's session says which project, one in none its folder's name
    expect(all[0]).toMatchObject({ project: "chat", where: "chat" });
    expect(all[3]).toMatchObject({ project: undefined, where: "elsewhere" });
    // every project's own list is in it
    const ids = new Set(all.map((h) => h.sessionId));
    for (const p of ["chat", "ops"]) {
      expect(t.svc.listSessions(p).every((h) => ids.has(h.sessionId))).toBe(true);
    }
  });

  it("an archived project is put away: the home screen has its sessions only while they need the person or run, and it is a project everywhere else", async () => {
    const t = setup();
    t.project("chat");
    t.project("ops");
    const inOps = { comboName: "ops", comboRelation: "root" } as const;
    t.rows.push(row("s-chat", { ...inChat, title: "rounding fix", activityMs: 90 }));
    t.rows.push(row("s-quiet", { ...inOps, title: "rounding notes", activityMs: 80 }));
    t.session("s-asks", {
      ...inOps,
      title: "rounding ask",
      live: live("waiting", 5000),
      activityMs: 70,
    });
    t.session("s-runs", {
      ...inOps,
      title: "rounding run",
      live: live("running", 6000),
      activityMs: 60,
    });
    t.rows.push(
      row("s-cut", {
        ...inOps,
        title: "rounding cut",
        interrupted: { why: "gone", at: 4000 },
        activityMs: 50,
      }),
    );
    // only what was said in it has the word
    t.rows.push(row("s-said", { ...inOps, title: "deploy notes", activityMs: 40 }));
    t.hits.push({ key: "/claude/projects/s-said.jsonl", snippet: "the rounding mode" });
    const ids = (hits: Array<{ sessionId: string }>) => hits.map((h) => h.sessionId);
    const home = () => ids(t.svc.listSessions(null));
    const ops = () => t.combos[1] as { archived?: boolean };
    /** the combo model changed: what ComboService's onModelChanged does. how many times the lists were told */
    const changed = () => {
      const before = t.got.sessions;
      t.svc.start();
      t.svc.inbox();
      return t.got.sessions - before;
    };
    const everything = ["s-chat", "s-quiet", "s-asks", "s-runs", "s-cut", "s-said"];
    expect(home()).toEqual(everything);
    const inbox = ids(t.svc.inbox().rows);
    expect(inbox).toEqual(["s-asks", "s-cut"]);
    expect(t.svc.views().projects.map((p) => p.archived)).toEqual([undefined, undefined]);

    ops().archived = true;
    expect(changed()).toBe(1);
    expect(t.svc.views().projects.map((p) => p.archived)).toEqual([undefined, true]);
    // the quiet ones are out. the one that needs him, the stopped one and the running one are in
    expect(home()).toEqual(["s-chat", "s-asks", "s-runs", "s-cut"]);
    // its own screen lists all of it, as for any project
    expect(ids(t.svc.listSessions("ops"))).toEqual(everything.slice(1));
    // archiving mutes nothing: the same rows count in the inbox, the tray and the dock
    expect(ids(t.svc.inbox().rows)).toEqual(inbox);
    expect(t.got.inbox).toHaveLength(1);
    // a click on a notification about a quiet one still lands on its row, in its project
    expect(t.svc.landing("s-quiet")).toEqual({
      view: "sessions",
      project: "ops",
      session: "s-quiet",
    });
    expect(t.svc.landing("s-asks")).toEqual({ view: "inbox", session: "s-asks" });
    expect(t.svc.projectOf("s-quiet")).toBe("ops");
    await t.svc.review("ops", ["stopped:s-cut@4000"], true);
    expect([...t.marks]).toEqual(["ops/stopped:s-cut@4000"]);
    // dismissed, it is a quiet session of an archived project
    expect(home()).toEqual(["s-chat", "s-asks", "s-runs"]);

    // the home screen's search follows its list, in what was said too
    expect(ids(await t.svc.findSessions("rounding", null))).toEqual(["s-chat", "s-asks", "s-runs"]);
    expect(ids(await t.svc.findSessions("rounding", "ops"))).toEqual([
      "s-quiet",
      "s-asks",
      "s-runs",
      "s-cut",
      "s-said",
    ]);
    // the palette's still finds every session
    expect(ids(await t.svc.findSessions("rounding"))).toEqual([
      ...everything.slice(0, 5),
      "s-said",
    ]);

    // its own screen still draws its quiet rows: one that changes moves the lists
    Object.assign(t.rows[1] as SessionRow, { title: "rounding notes, renamed" });
    expect(changed()).toBe(1);
    expect(changed()).toBe(0);
    // a quiet one that runs again is back on the home screen, and leaves it when it is seen
    Object.assign(t.rows[1] as SessionRow, { live: live("waiting", 9000) });
    expect(changed()).toBe(1);
    expect(home()).toEqual(["s-chat", "s-quiet", "s-asks", "s-runs"]);
    Object.assign(t.rows[1] as SessionRow, { live: live("waiting", 9000, { seen: true }) });
    expect(changed()).toBe(1);
    expect(home()).toEqual(["s-chat", "s-asks", "s-runs"]);

    // brought back: all of it is on the home screen again
    delete ops().archived;
    expect(changed()).toBe(1);
    expect(home()).toEqual(everything);
  });

  it("a working session says what it was last asked and since when, and no other does", () => {
    const t = setup();
    t.project("chat");
    const asked = `fix the   rounding in\nthe invoice totals ${"and the tests ".repeat(30)}`;
    t.session("s-runs", {
      ...inChat,
      firstPrompt: "start here",
      lastPrompt: asked,
      live: live("running", 9000, { turnStart: 4000 }),
    });
    // the process registry saw it busy: there is no turn, only since when
    t.session("s-busy", {
      ...inChat,
      firstPrompt: "the only prompt",
      live: live("running", 7000, { source: "registry" }),
    });
    t.session("s-asks", { ...inChat, lastPrompt: "then this", live: live("waiting", 8000) });
    t.rows.push(row("s-quiet", { ...inChat, lastPrompt: "long ago" }));
    const by = Object.fromEntries(t.svc.listSessions("chat").map((h) => [h.sessionId, h]));
    expect(by["s-runs"]?.since).toBe(4000);
    expect(by["s-runs"]?.doing).toMatch(/^fix the rounding in the invoice totals and the tests /);
    expect(by["s-runs"]?.doing?.length).toBeLessThanOrEqual(200);
    expect(by["s-busy"]).toMatchObject({ since: 7000, doing: "the only prompt" });
    for (const id of ["s-asks", "s-quiet"]) {
      expect(by[id]?.doing, id).toBeUndefined();
      expect(by[id]?.since, id).toBeUndefined();
    }
  });

  it("says the lists changed when what a row shows moved, not on every line an agent writes", () => {
    const t = setup();
    t.project("chat");
    // a turn that started at 500: every status of it says so, whatever its own time
    const turn = { turnStart: 500 };
    t.session("s-1", { ...inChat, live: live("running", 1000, turn) });
    t.rows.push(row("s-nowhere"));
    t.rows.push(row("s-script", { entrypoint: "sdk-cli" }));
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
    set({ live: live("running", 2000, turn), activityMs: 2000 });
    expect(moved()).toBe(0);
    // a new prompt while it works is a new turn, and what it is doing
    set({ live: live("running", 2500, { turnStart: 2500 }), lastPrompt: "and the tests" });
    expect(moved()).toBe(1);
    set({ live: live("waiting", 3000) });
    expect(moved()).toBe(1);
    set({ title: "rounding fix" });
    expect(moved()).toBe(1);
    // its window closed
    t.alive.delete("s-1");
    expect(moved()).toBe(1);
    // a session outside every project is in the list of all of them. a script there is in none
    Object.assign(t.rows[1] as SessionRow, { title: "elsewhere" });
    expect(moved()).toBe(1);
    Object.assign(t.rows[2] as SessionRow, { title: "a scripted run" });
    expect(moved()).toBe(0);
    t.rows.push(row("s-2", inChat));
    expect(moved()).toBe(1);
  });
});
