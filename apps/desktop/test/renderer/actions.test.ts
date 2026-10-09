import { beforeEach, describe, expect, it } from "vitest";
import { CLOSED, PAGE } from "../../src/renderer/logic/views.ts";
import {
  back,
  drawMore,
  editProject,
  go,
  loadSessions,
  newProject,
  openRow,
  perform,
  review,
  setInbox,
  switchProject,
  toggleOlder,
} from "../../src/renderer/state/actions.ts";
import { applyLanding } from "../../src/renderer/state/landing.ts";
import { listInput, useStore } from "../../src/renderer/state/store.ts";
import type { InboxRowView, ProjectView, SessionHit } from "../../src/shared/ipc.ts";

const project = (id: string): ProjectView => ({
  id,
  name: id,
  root: `/ws/${id}`,
  workspaceFile: `/ws/${id}/${id}.code-workspace`,
  longWork: "foreground",
  folders: [],
  status: "known",
  rootExists: true,
});
// a list cuts its rows by the day they last moved: these all moved in the last minute
const NOW = Date.now();
const DAY = 24 * 3_600_000;
const hit = (id: string, o: Partial<SessionHit> = {}): SessionHit => ({
  key: `/p/${id}.jsonl`,
  sessionId: id,
  title: id,
  project: "auth",
  where: "auth",
  activityMs: NOW,
  runtime: "vscode",
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
  at: 0,
  summary: "",
  reviewKeys: [`seen:${id}`],
  ...o,
});

const s = () => useStore.getState();
/** what main answers. a test that reaches main sets what it needs */
const grove: Record<string, (...args: never[]) => unknown> = {};
(globalThis as { window?: unknown }).window = { grove };

beforeEach(() => {
  for (const k of Object.keys(grove)) delete grove[k];
  useStore.setState(useStore.getInitialState(), true);
  s().set({
    ready: true,
    now: NOW,
    projects: [project("auth"), project("billing")],
    project: "auth",
    inbox: {
      rows: [
        row("s-asks"),
        row("s-cut", { kind: "stopped" }),
        row("s-bill", { project: "billing" }),
      ],
    },
    // newest first, as main sends them
    sessions: {
      scope: "auth",
      hits: [
        hit("s-quiet", { title: "sketch the login page", activityMs: NOW - 1 }),
        hit("s-works", { live: "running", activityMs: NOW - 2 }),
        hit("s-cut", { activityMs: NOW - 3 }),
        hit("s-asks", { branch: "fix/login", activityMs: NOW - 4 }),
        hit("s-old", { prompt: "rotate the login keys", activityMs: NOW - 5 }),
      ],
    },
  });
});

describe("navigation", () => {
  it("a list from the sidebar has nothing to go back to, and no panel", () => {
    newProject();
    s().set({ overlay: "palette", peek: "s-asks" });
    go("inbox");
    expect(s()).toMatchObject({
      section: "inbox",
      view: { name: "inbox" },
      back: [],
      overlay: null,
      peek: null,
    });
    go("sessions");
    expect(s()).toMatchObject({ section: "sessions", view: { name: "sessions" }, project: "auth" });
    // Older is closed every time a list comes on screen
    s().set({ older: { open: true, drawn: 150 } });
    go("inbox");
    expect(s().older).toEqual(CLOSED);
    s().set({ older: { open: true, drawn: 150 } });
    switchProject("billing");
    expect(s().older).toEqual(CLOSED);
  });

  it("a project is its sessions, with nothing carried over from another's", () => {
    go("sessions");
    openRow("sessions", "s-quiet");
    s().set({ filter: "login" });
    switchProject("billing");
    expect(s()).toMatchObject({
      project: "billing",
      view: { name: "sessions" },
      peek: null,
      filter: "",
      active: { sessions: null },
      // auth's rows never show under billing's name
      sessions: null,
    });
    // from the inbox, a project it already has the rows of keeps them while main is asked again
    s().set({ sessions: { scope: "billing", hits: [hit("s-bill")] } });
    go("inbox");
    switchProject("billing");
    expect(s().sessions?.hits).toHaveLength(1);
  });

  it("main's answer for a project that left the screen, or to an older ask, is dropped", async () => {
    const answers: Array<(hits: SessionHit[]) => void> = [];
    const scopes: unknown[] = [];
    grove.listSessions = (scope: unknown) => {
      scopes.push(scope);
      return new Promise<SessionHit[]>((done) => answers.push(done));
    };
    switchProject("billing");
    const first = loadSessions();
    const second = loadSessions();
    answers[1]?.([hit("s-new")]);
    answers[0]?.([hit("s-stale")]);
    await Promise.all([first, second]);
    expect(s().sessions).toEqual({ scope: "billing", hits: [hit("s-new")] });

    const late = loadSessions();
    switchProject("auth");
    answers[2]?.([hit("s-billing")]);
    await late;
    expect(s().sessions).toBeNull();

    // the home screen asks for every project's, and a form asks for nothing
    go("inbox");
    const all = loadSessions();
    answers[3]?.([hit("s-any", { project: undefined })]);
    await all;
    expect(scopes).toEqual(["billing", "billing", "billing", null]);
    expect(s().sessions).toMatchObject({ scope: null, hits: [{ sessionId: "s-any" }] });
    newProject();
    await loadSessions();
    expect(scopes).toHaveLength(4);
  });

  it("Edit project is a project's, and both forms go back where they came from", () => {
    // the inbox is every project's: there is none to edit
    editProject();
    expect(s().view).toEqual({ name: "inbox" });
    go("sessions");
    editProject();
    editProject();
    expect(s()).toMatchObject({ view: { name: "edit-project" }, back: [{ name: "sessions" }] });
    back();
    expect(s().view).toEqual({ name: "sessions" });
    go("inbox");
    newProject();
    newProject();
    expect(s().back).toEqual([{ name: "inbox" }]);
    back();
    expect(s().view).toEqual({ name: "inbox" });
  });
});

describe("a landing", () => {
  const land = (target: Parameters<typeof applyLanding>[0]["target"]) =>
    applyLanding({ target, at: 1 });

  it("a session in the inbox: its row is the keyboard's and its panel is open", () => {
    go("sessions");
    s().set({ overlay: "palette", dialog: { kind: "settings" } });
    land({ view: "inbox", session: "s-cut" });
    expect(s()).toMatchObject({
      view: { name: "inbox" },
      peek: "s-cut",
      active: { inbox: "s-cut" },
      keys: true,
      overlay: null,
      dialog: null,
    });
    // several stopped at once: the inbox, and no one of them
    land({ view: "inbox" });
    expect(s()).toMatchObject({ view: { name: "inbox" }, peek: null });
  });

  it("a session that no longer needs him: its row in its project's sessions", () => {
    s().set({ filter: "login" });
    land({ view: "sessions", project: "billing", session: "s-9" });
    expect(s()).toMatchObject({
      project: "billing",
      view: { name: "sessions" },
      peek: "s-9",
      active: { sessions: "s-9" },
      keys: true,
      filter: "",
    });
  });

  it("a project that is gone: the inbox", () => {
    go("sessions");
    land({ view: "sessions", project: "deleted", session: "s-9" });
    expect(s()).toMatchObject({ project: "auth", view: { name: "inbox" } });
  });
});

describe("keys on a list", () => {
  it("the first Enter, cmd-Enter or cmd-D only shows which row the keyboard is on", () => {
    for (const type of ["open", "open-editor", "review"] as const) {
      s().set({ keys: false });
      perform({ type });
      expect(s(), type).toMatchObject({ keys: true, view: { name: "inbox" }, peek: null });
      expect(s().inbox.rows).toHaveLength(3);
    }
    // the next press acts: the first row opens in the panel, and the list stays
    perform({ type: "open" });
    expect(s()).toMatchObject({ view: { name: "inbox" }, peek: "s-asks" });
  });

  it("with a session open in the panel, the first cmd-D dismisses that one: the open row is marked", async () => {
    const asked: unknown[] = [];
    grove.review = (...args: unknown[]) => {
      asked.push(args);
      return Promise.resolve({ ok: true, value: undefined });
    };
    // he clicked s-cut and is reading it. the mouse moved last, and it is on no row
    s().set({ keys: false, peek: "s-cut", active: { ...s().active, inbox: "s-asks" } });
    perform({ type: "review" });
    await Promise.resolve();
    expect(asked).toHaveLength(1);
    expect(s().inbox.rows.map((r) => r.sessionId)).not.toContain("s-cut");
    expect(s().inbox.rows).toHaveLength(2);
    // nothing became the keyboard's row for it
    expect(s().keys).toBe(false);
  });

  it("the first arrow only shows the keyboard's row. the next move through every project's rows", () => {
    perform({ type: "move", delta: 1 });
    expect(s()).toMatchObject({ active: { inbox: "s-asks" }, keys: true });
    perform({ type: "move", delta: 1 });
    expect(s().active.inbox).toBe("s-cut");
    perform({ type: "move", delta: 5 });
    expect(s().active.inbox).toBe("s-bill");
    perform({ type: "move-to", where: "first" });
    expect(s().active.inbox).toBe("s-asks");
  });

  it("cmd-Enter on a row grove cannot open says why, instead of nothing", () => {
    const blocked = row("s-bg", { open: { disabled: "running in the background" } });
    s().set({ inbox: { rows: [blocked] }, keys: true });
    perform({ type: "open-editor" });
    expect(s().toasts).toMatchObject([
      { level: "error", title: "Could not open s-bg: running in the background" },
    ]);
  });

  it("a project's sessions move in the order they are drawn: the ones that need him, the working, the rest", () => {
    go("sessions");
    const walk = () => {
      const seen: Array<string | null> = [];
      perform({ type: "move-to", where: "first" });
      for (let i = 0; i < 6; i++) {
        seen.push(s().active.sessions);
        perform({ type: "move", delta: 1 });
      }
      return [...new Set(seen)];
    };
    expect(walk()).toEqual(["s-asks", "s-cut", "s-works", "s-quiet", "s-old"]);
    // the filter: a word in the title, the branch or a prompt
    s().set({ filter: "LOGIN" });
    expect(walk()).toEqual(["s-asks", "s-quiet", "s-old"]);
    perform({ type: "clear-query" });
    expect(s().filter).toBe("");

    // Enter opens the keyboard's row in the panel. cmd-D dismisses one that needs him, and only that
    const sent: unknown[] = [];
    grove.review = async (...args: unknown[]) => {
      sent.push(args);
      return { ok: true };
    };
    perform({ type: "move-to", where: "last" });
    perform({ type: "open" });
    expect(s()).toMatchObject({ peek: "s-old", view: { name: "sessions" } });
    perform({ type: "review" });
    expect(sent).toEqual([]);
    perform({ type: "move-to", where: "first" });
    perform({ type: "review" });
    expect(sent).toEqual([["auth", ["seen:s-asks"], true]]);
    // it leaves the inbox at once, and stays in its project's list as a quiet session
    expect(s().inbox.rows.map((r) => r.sessionId)).toEqual(["s-cut", "s-bill"]);
  });

  it("alt-arrows step down the sidebar: the inbox, then the projects, and stop at the ends", () => {
    perform({ type: "project-step", delta: -1 });
    expect(s().view).toEqual({ name: "inbox" });
    perform({ type: "project-step", delta: 1 });
    expect(s()).toMatchObject({ view: { name: "sessions" }, project: "auth" });
    perform({ type: "project-step", delta: 1 });
    perform({ type: "project-step", delta: 1 });
    expect(s().project).toBe("billing");
    perform({ type: "project-step", delta: -1 });
    perform({ type: "project-step", delta: -1 });
    expect(s()).toMatchObject({ view: { name: "inbox" }, project: "auth" });
  });

  it("cmd-F is the search of the list on screen, and from a form of the list under it", () => {
    perform({ type: "focus-search" });
    expect(s()).toMatchObject({ view: { name: "inbox" } });
    go("sessions");
    perform({ type: "focus-search" });
    expect(s()).toMatchObject({ view: { name: "sessions" }, project: "auth" });
    editProject();
    perform({ type: "focus-search" });
    expect(s()).toMatchObject({ view: { name: "sessions" }, back: [] });
    go("inbox");
    newProject();
    perform({ type: "focus-search" });
    expect(s()).toMatchObject({ view: { name: "inbox" }, back: [] });
  });

  it("what is typed is cleared when the screen changes, and an answer to it is not another list's", () => {
    const found = { scope: null, query: "login", hits: [hit("s-old")] };
    s().set({ filter: "login", found });
    expect(listInput(s()).found).toHaveLength(1);
    // one more letter: the answer is to an older query
    s().set({ filter: "logins" });
    expect(listInput(s()).found).toBeUndefined();
    s().set({ filter: "login" });
    go("sessions");
    expect(s().filter).toBe("");
    // the same word typed on a project's screen is not answered by the home screen's search
    s().set({ filter: "login" });
    expect(listInput(s()).found).toBeUndefined();
    go("inbox");
    expect(s().filter).toBe("");
  });

  it("cmd-O and cmd-E do nothing on the inbox, which shows no one project", () => {
    perform({ type: "open-project" });
    perform({ type: "edit-project" });
    expect(s()).toMatchObject({ view: { name: "inbox" }, toasts: [] });
  });
});

describe("the panel beside a list", () => {
  it("a click opens the row beside the list and never toggles: a double-click is two clicks first", () => {
    openRow("inbox", "s-cut");
    expect(s()).toMatchObject({
      peek: "s-cut",
      active: { inbox: "s-cut" },
      view: { name: "inbox" },
      back: [],
      toasts: [],
    });
    openRow("inbox", "s-cut");
    expect(s().peek).toBe("s-cut");
  });

  it("follows the arrows while it is open, from its own row, and stays shut while it is not", () => {
    perform({ type: "move", delta: 1 });
    perform({ type: "move", delta: 1 });
    expect(s()).toMatchObject({ active: { inbox: "s-cut" }, peek: null });
    perform({ type: "move-to", where: "first" });
    expect(s().peek).toBeNull();

    openRow("inbox", "s-asks");
    // the mouse went over another row and away: the keyboard's row moved, the panel did not
    s().set({ active: { ...s().active, inbox: "s-bill" }, keys: false });
    expect(s().peek).toBe("s-asks");
    // the open row shows where the arrows are, so the first one moves
    perform({ type: "move", delta: 1 });
    expect(s()).toMatchObject({ peek: "s-cut", active: { inbox: "s-cut" }, keys: true });
    perform({ type: "move-to", where: "first" });
    expect(s()).toMatchObject({ peek: "s-asks", active: { inbox: "s-asks" } });
  });

  it("Escape closes it, and so does going to another list or project", () => {
    openRow("inbox", "s-asks");
    perform({ type: "close-panel" });
    expect(s()).toMatchObject({ peek: null, view: { name: "inbox" } });

    openRow("inbox", "s-asks");
    go("sessions");
    expect(s().peek).toBeNull();
    openRow("sessions", "s-quiet");
    switchProject("billing");
    expect(s().peek).toBeNull();
  });
});

describe("the home screen", () => {
  // every project's, newest first: three need him, one works, one is quiet, one is in no project
  const all = [
    hit("s-loose", { project: undefined, where: "scratch", activityMs: NOW - 1 }),
    hit("s-works", { live: "running", activityMs: NOW - 2 }),
    hit("s-cut", { activityMs: NOW - 3 }),
    hit("s-asks", { activityMs: NOW - 4 }),
    hit("s-bill", { project: "billing", where: "billing", activityMs: NOW - 5 }),
    hit("s-ancient", { activityMs: NOW - 30 * DAY }),
  ];
  const walk = () => {
    const seen: Array<string | null> = [];
    perform({ type: "move-to", where: "first" });
    for (let i = 0; i < 8; i++) {
      seen.push(s().active.inbox);
      perform({ type: "move", delta: 1 });
    }
    return [...new Set(seen)];
  };
  beforeEach(() => s().set({ sessions: { scope: null, hits: all } }));

  it("is every session: the ones that need him in the inbox's order, the working, the rest, and Older closed", () => {
    expect(walk()).toEqual(["s-asks", "s-cut", "s-bill", "s-works", "s-loose"]);
  });

  it("a dismissed session stays in the list, and the panel and the keyboard go to the next one that needs him", async () => {
    grove.review = async () => ({ ok: true });
    openRow("inbox", "s-asks");
    await review("auth", ["seen:s-asks"]);
    // the row that took its place in Needs you, not the session's own row lower down
    expect(s()).toMatchObject({ peek: "s-cut", active: { inbox: "s-cut" } });
    expect(walk()).toEqual(["s-cut", "s-bill", "s-works", "s-loose", "s-asks"]);

    // the keyboard's row alone, with no panel: it moves the same way
    s().set({ peek: null, active: { ...s().active, inbox: "s-bill" } });
    await review("billing", ["seen:s-bill"]);
    expect(s()).toMatchObject({ peek: null, active: { inbox: "s-cut" } });

    // main says a row left by itself: he answered it in the editor
    openRow("inbox", "s-cut");
    setInbox({ rows: [] });
    // the last one: the panel closes, and nothing is the keyboard's until a key says so
    expect(s()).toMatchObject({ peek: null, active: { inbox: null } });
  });

  it("a panel on a session that does not need him stays put while the inbox moves", () => {
    openRow("inbox", "s-loose");
    setInbox({ rows: [row("s-cut", { kind: "stopped" })] });
    expect(s()).toMatchObject({ peek: "s-loose", active: { inbox: "s-loose" } });
  });

  it("on a project's screen Dismiss leaves the panel where it is, in Older too", async () => {
    grove.review = async () => ({ ok: true });
    go("sessions");
    // a stop of five days ago that nobody dismissed
    s().set({
      sessions: {
        scope: "auth",
        hits: [hit("s-asks"), hit("s-cut", { activityMs: NOW - 5 * DAY })],
      },
    });
    openRow("sessions", "s-cut");
    await review("auth", ["seen:s-cut"]);
    expect(s()).toMatchObject({ peek: "s-cut", active: { sessions: "s-cut" } });
    // its row is in Older now, which is drawn for it
    perform({ type: "move", delta: -1 });
    expect(s().peek).toBe("s-asks");
  });
});

describe("Older", () => {
  const old = Array.from({ length: 120 }, (_, n) =>
    hit(`old-${n}`, { activityMs: NOW - (10 + n) * DAY }),
  );
  beforeEach(() => {
    go("sessions");
    s().set({ inbox: { rows: [] }, sessions: { scope: "auth", hits: [hit("s-new"), ...old] } });
  });
  const last = () => {
    perform({ type: "move-to", where: "last" });
    return s().active.sessions;
  };

  it("is closed until its header is pressed: the keyboard never lands on a row nobody sees", () => {
    expect(last()).toBe("s-new");
    expect(drawMore()).toBe(false);
    toggleOlder();
    expect(s().older).toEqual({ open: true, drawn: PAGE });
    expect(last()).toBe("old-49");
  });

  it("draws the next page when the end comes near, and when an arrow steps past the last row drawn", () => {
    toggleOlder();
    expect(drawMore()).toBe(true);
    expect(s().older.drawn).toBe(100);
    expect(last()).toBe("old-99");
    perform({ type: "move", delta: 1 });
    expect(s()).toMatchObject({ older: { drawn: 150 }, active: { sessions: "old-100" } });
    // all of it is drawn: the arrow stops on the last row
    expect(drawMore()).toBe(false);
    expect(last()).toBe("old-119");
    perform({ type: "move", delta: 1 });
    expect(s().active.sessions).toBe("old-119");
  });

  it("closes again from its header, and takes a panel on one of its rows with it", () => {
    toggleOlder();
    drawMore();
    openRow("sessions", "old-3");
    toggleOlder();
    expect(s()).toMatchObject({ older: { open: false, drawn: PAGE }, peek: null });
    // a panel on a row outside it stays
    toggleOlder();
    openRow("sessions", "s-new");
    toggleOlder();
    expect(s()).toMatchObject({ older: { open: false }, peek: "s-new" });
  });
});

describe("Dismiss", () => {
  it("takes the row out at once, and puts it back when main refuses", async () => {
    let answer: (ok: boolean) => void = () => {};
    grove.review = () =>
      new Promise((done) => {
        answer = (ok) => done(ok ? { ok } : { ok, error: { code: "x", message: "no" } });
      });
    const going = review("auth", ["seen:s-asks"]);
    expect(s().inbox.rows.map((r) => r.sessionId)).toEqual(["s-cut", "s-bill"]);
    answer(false);
    expect(await going).toBe(false);
    expect(s().inbox.rows).toHaveLength(3);
    expect(s().toasts).toMatchObject([{ level: "error", title: "Could not dismiss it" }]);

    // the same key in another project is another session's
    const other = review("billing", ["seen:s-asks"]);
    expect(s().inbox.rows).toHaveLength(3);
    answer(true);
    expect(await other).toBe(true);
  });
});
