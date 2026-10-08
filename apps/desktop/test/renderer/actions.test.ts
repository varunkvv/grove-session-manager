import { beforeEach, describe, expect, it } from "vitest";
import {
  back,
  editProject,
  go,
  loadSessions,
  newProject,
  openRow,
  perform,
  review,
  switchProject,
} from "../../src/renderer/state/actions.ts";
import { applyLanding } from "../../src/renderer/state/landing.ts";
import { useStore } from "../../src/renderer/state/store.ts";
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
const hit = (id: string, o: Partial<SessionHit> = {}): SessionHit => ({
  key: `/p/${id}.jsonl`,
  sessionId: id,
  title: id,
  project: "auth",
  where: "auth",
  activityMs: 0,
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
      project: "auth",
      hits: [
        hit("s-quiet", { title: "sketch the login page", activityMs: 9 }),
        hit("s-works", { live: "running", activityMs: 8 }),
        hit("s-cut", { activityMs: 7 }),
        hit("s-asks", { branch: "fix/login", activityMs: 6 }),
        hit("s-old", { prompt: "rotate the login keys", activityMs: 5 }),
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
    s().set({ sessions: { project: "billing", hits: [hit("s-bill")] } });
    go("inbox");
    switchProject("billing");
    expect(s().sessions?.hits).toHaveLength(1);
  });

  it("main's answer for a project that left the screen, or to an older ask, is dropped", async () => {
    const answers: Array<(hits: SessionHit[]) => void> = [];
    grove.projectSessions = () => new Promise<SessionHit[]>((done) => answers.push(done));
    switchProject("billing");
    const first = loadSessions();
    const second = loadSessions();
    answers[1]?.([hit("s-new")]);
    answers[0]?.([hit("s-stale")]);
    await Promise.all([first, second]);
    expect(s().sessions).toEqual({ project: "billing", hits: [hit("s-new")] });

    const late = loadSessions();
    switchProject("auth");
    answers[2]?.([hit("s-billing")]);
    await late;
    expect(s().sessions).toBeNull();
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

  it("cmd-F is the sessions filter: from the inbox it goes to the project that was last on screen", () => {
    perform({ type: "focus-search" });
    expect(s()).toMatchObject({ view: { name: "sessions" }, project: "auth" });
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
