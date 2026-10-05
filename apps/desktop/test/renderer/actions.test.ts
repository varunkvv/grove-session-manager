import { beforeEach, describe, expect, it } from "vitest";
import {
  back,
  editProject,
  go,
  newProject,
  openCard,
  openConclusion,
  openRow,
  perform,
  switchProject,
} from "../../src/renderer/state/actions.ts";
import { applyLanding } from "../../src/renderer/state/landing.ts";
import { applyRecord, useStore } from "../../src/renderer/state/store.ts";
import type { CardHead, ConclusionView, InboxRowView, ProjectView } from "../../src/shared/ipc.ts";

const project = (id: string): ProjectView => ({
  id,
  name: id,
  root: `/ws/${id}`,
  prefix: id.slice(0, 4).toUpperCase(),
  workspaceFile: `/ws/${id}/${id}.code-workspace`,
  longWork: "foreground",
  folders: [],
  status: "known",
  rootExists: true,
  server: { state: "unknown" },
  shadowed: [],
  starting: [],
});
const row = (id: string, o: Partial<InboxRowView> = {}): InboxRowView => ({
  id,
  project: "auth",
  projectName: "auth",
  kind: "decided",
  at: 0,
  title: id,
  summary: "",
  reviewKeys: [`conclusion:${id}`],
  ...o,
});
const head = (id: string, o: Partial<CardHead> = {}): CardHead => ({
  id,
  title: id,
  status: "todo",
  at: 0,
  lastActivity: 0,
  version: "1",
  problems: 0,
  ...o,
});
const conclusion = (id: string, what: string): ConclusionView => ({
  id,
  kind: id.startsWith("F") ? "finding" : "decision",
  what,
  why: "",
  by: "agent",
  replacedBy: [],
  superseded: false,
  related: [],
  changesPlan: false,
  sources: [],
  at: 0,
  needsReview: true,
  reviewed: false,
  problems: 0,
});

const s = () => useStore.getState();

beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true);
  s().set({
    ready: true,
    projects: [project("auth"), project("billing")],
    project: "auth",
    records: {
      auth: {
        cards: [head("AUTH-1"), head("AUTH-2")],
        conclusions: [conclusion("D-2", "sessions live in redis"), conclusion("F-1", "no tenant")],
        problems: [],
        readAt: 1,
      },
    },
    inbox: {
      rows: [
        row("asked:AUTH-1", { kind: "asked", card: { id: "AUTH-1", title: "callback" } }),
        row("decided:D-2"),
        row("other", { project: "billing" }),
      ],
      tray: 1,
    },
  });
});

describe("navigation", () => {
  it("a screen from the nav has nothing to go back to", () => {
    openCard("AUTH-1");
    s().set({ overlay: "palette" });
    go("cards");
    expect(s()).toMatchObject({
      section: "cards",
      view: { name: "cards" },
      back: [],
      overlay: null,
    });
  });

  it("going to Conclusions from the nav resets its controls, going elsewhere keeps them", () => {
    s().set({ conclusions: { query: "redis", kind: "decision", open: "D-2" } });
    go("cards");
    expect(s().conclusions.query).toBe("redis");
    go("conclusions");
    expect(s().conclusions).toEqual({ query: "", kind: "all", open: null });
  });

  it("a card is pushed, and the nav keeps saying where it was opened from", () => {
    go("cards");
    openCard("AUTH-1");
    openCard("AUTH-2");
    expect(s()).toMatchObject({ section: "cards", view: { name: "card", cardId: "AUTH-2" } });
    back();
    expect(s().view).toEqual({ name: "card", cardId: "AUTH-1" });
    back();
    expect(s().view).toEqual({ name: "cards" });
    // nothing left: the section
    back();
    expect(s()).toMatchObject({ view: { name: "cards" }, back: [] });
  });

  it("a conclusion opened from a card can go back to it. on Conclusions it only opens the row", () => {
    openCard("AUTH-1");
    openConclusion("D-2");
    expect(s()).toMatchObject({
      section: "conclusions",
      view: { name: "conclusions" },
      conclusions: { open: "D-2" },
    });
    expect(s().back).toHaveLength(2);
    openConclusion("F-1");
    expect(s().back).toHaveLength(2);
    expect(s().conclusions.open).toBe("F-1");
    back();
    expect(s().view).toEqual({ name: "card", cardId: "AUTH-1" });
  });

  it("a search or a kind that hides the conclusion is reset, one that shows it is kept", () => {
    go("conclusions");
    s().set({ conclusions: { query: "redis", kind: "all", open: null } });
    openConclusion("D-2");
    expect(s().conclusions).toEqual({ query: "redis", kind: "all", open: "D-2" });
    openConclusion("F-1");
    expect(s().conclusions).toEqual({ query: "", kind: "all", open: "F-1" });
  });

  it("another project shows the same screen, with nothing carried over", () => {
    go("cards");
    openCard("AUTH-1");
    s().set({ active: { inbox: "x", cards: "AUTH-1", conclusions: null } });
    switchProject("billing");
    expect(s()).toMatchObject({
      project: "billing",
      section: "cards",
      view: { name: "cards" },
      back: [],
      card: null,
      active: { inbox: null, cards: null, conclusions: null },
    });
  });

  it("Edit project sits under Cards, and both forms go back where they came from", () => {
    editProject();
    expect(s()).toMatchObject({ section: "cards", view: { name: "edit-project" } });
    back();
    expect(s().view).toEqual({ name: "inbox" });
    newProject();
    // the menu's accelerator and the page's key can both ask
    newProject();
    expect(s().back).toEqual([{ name: "inbox" }]);
    s().set({ project: null });
    editProject();
    expect(s().view).toEqual({ name: "new-project" });
  });
});

describe("a landing", () => {
  const land = (target: Parameters<typeof applyLanding>[0]["target"]) =>
    applyLanding({ target, at: 1 });

  it("a card, with the screen main named behind it", () => {
    s().set({ overlay: "palette", dialog: { kind: "settings" } });
    land({ view: "card", project: "billing", cardId: "BILL-3", back: "inbox" });
    expect(s()).toMatchObject({
      project: "billing",
      view: { name: "card", cardId: "BILL-3" },
      back: [{ name: "inbox" }],
      overlay: null,
      dialog: null,
    });
    land({ view: "card", project: "auth", cardId: "AUTH-1", back: "cards" });
    expect(s()).toMatchObject({ project: "auth", section: "cards", back: [{ name: "cards" }] });
  });

  it("an inbox row is the keyboard's, and shows it", () => {
    go("cards");
    land({ view: "inbox", project: "auth", rowId: "stopped:s1" });
    expect(s()).toMatchObject({
      view: { name: "inbox" },
      active: { inbox: "stopped:s1" },
      keys: true,
    });
    s().set({ keys: false });
    land({ view: "inbox" });
    expect(s()).toMatchObject({ project: "auth", view: { name: "inbox" }, keys: false });
  });

  it("a conclusion is open on its screen", () => {
    land({ view: "conclusions", project: "auth", conclusionId: "F-1" });
    expect(s()).toMatchObject({ view: { name: "conclusions" }, conclusions: { open: "F-1" } });
    land({ view: "conclusions", project: "auth" });
    expect(s().conclusions.open).toBeNull();
  });

  it("a project that is gone: the inbox of the one on screen", () => {
    go("cards");
    land({ view: "card", project: "deleted", cardId: "X-1", back: "cards" });
    expect(s()).toMatchObject({ project: "auth", view: { name: "inbox" } });
  });
});

describe("keys on a list", () => {
  it("the first Enter, cmd-Enter or cmd-D only shows which row the keyboard is on", () => {
    for (const type of ["open", "open-editor", "review"] as const) {
      s().set({ keys: false });
      perform({ type });
      expect(s(), type).toMatchObject({ keys: true, view: { name: "inbox" } });
      expect(s().inbox.rows).toHaveLength(3);
    }
    // the next press acts: the first row opens in the panel, and the list stays
    perform({ type: "open" });
    expect(s()).toMatchObject({ view: { name: "inbox" }, peek: "asked:AUTH-1" });
  });

  it("the first arrow only shows the keyboard's row. the next move through this project's rows only", () => {
    perform({ type: "move", delta: 1 });
    expect(s()).toMatchObject({ active: { inbox: "asked:AUTH-1" }, keys: true });
    perform({ type: "move", delta: 1 });
    expect(s()).toMatchObject({ active: { inbox: "decided:D-2" }, keys: true });
    perform({ type: "move", delta: 5 });
    expect(s().active.inbox).toBe("decided:D-2");
    perform({ type: "move-to", where: "first" });
    expect(s().active.inbox).toBe("asked:AUTH-1");
  });

  it("cmd-Enter on a row grove cannot open says why, instead of nothing", () => {
    const blocked = row("decided:D-2", {
      sessionKey: "/p/s.jsonl",
      open: { disabled: "running in the background" },
    });
    s().set({ inbox: { rows: [blocked], tray: 0 }, keys: true });
    perform({ type: "open-editor" });
    expect(s().toasts).toMatchObject([
      { level: "error", title: "Could not open decided:D-2: running in the background" },
    ]);
  });

  it("Cards moves through the cards. Enter opens one in the panel, cmd-Enter its agent in the editor", () => {
    const records = s().records;
    const held = head("AUTH-2", {
      sessionKey: "/p/s.jsonl",
      open: { disabled: "running in the background" },
    });
    s().set({ records: { ...records, auth: { ...records.auth!, cards: [head("AUTH-1"), held] } } });
    go("cards");
    // a card nobody was on has no session: cmd-Enter opens nothing, starts nothing and says nothing
    perform({ type: "move-to", where: "first" });
    perform({ type: "open-editor" });
    expect(s()).toMatchObject({ view: { name: "cards" }, peek: null, toasts: [], dialog: null });
    perform({ type: "move-to", where: "last" });
    perform({ type: "open-editor" });
    expect(s().toasts).toMatchObject([
      { level: "error", title: "Could not open AUTH-2: running in the background" },
    ]);

    perform({ type: "open" });
    expect(s()).toMatchObject({
      view: { name: "cards" },
      peek: "AUTH-2",
      active: { cards: "AUTH-2" },
      back: [],
    });
    // the arrows move it, and Escape closes it
    perform({ type: "move", delta: -1 });
    expect(s()).toMatchObject({ peek: "AUTH-1", active: { cards: "AUTH-1" } });
    perform({ type: "close-panel" });
    expect(s()).toMatchObject({ view: { name: "cards" }, peek: null });
    // it is one panel for both lists: leaving for the inbox shuts it
    perform({ type: "open" });
    go("inbox");
    expect(s().peek).toBeNull();
  });

  it("Conclusions opens a row in place, and closes it", () => {
    go("conclusions");
    s().set({ keys: true });
    perform({ type: "move", delta: 1 });
    perform({ type: "open" });
    expect(s().conclusions.open).toBe("F-1");
    perform({ type: "open" });
    expect(s().conclusions.open).toBeNull();
  });

  it("alt-arrows step through the projects and stop at the ends", () => {
    perform({ type: "project-step", delta: -1 });
    expect(s().project).toBe("auth");
    perform({ type: "project-step", delta: 1 });
    perform({ type: "project-step", delta: 1 });
    expect(s().project).toBe("billing");
  });
});

describe("the panel beside a list", () => {
  it("a click opens the row beside the list and never toggles: a double-click is two clicks first", () => {
    openRow("inbox", "decided:D-2");
    expect(s()).toMatchObject({
      peek: "decided:D-2",
      active: { inbox: "decided:D-2" },
      view: { name: "inbox" },
      back: [],
      toasts: [],
    });
    openRow("inbox", "decided:D-2");
    expect(s().peek).toBe("decided:D-2");
  });

  it("follows the arrows while it is open, from its own row, and stays shut while it is not", () => {
    perform({ type: "move", delta: 1 });
    perform({ type: "move", delta: 1 });
    expect(s()).toMatchObject({ active: { inbox: "decided:D-2" }, peek: null });
    perform({ type: "move-to", where: "first" });
    expect(s().peek).toBeNull();

    openRow("inbox", "asked:AUTH-1");
    // the mouse went over another row and away: the keyboard's row moved, the panel did not
    s().set({ active: { ...s().active, inbox: "decided:D-2" }, keys: false });
    expect(s().peek).toBe("asked:AUTH-1");
    // the open row shows where the arrows are, so the first one moves
    perform({ type: "move", delta: 1 });
    expect(s()).toMatchObject({
      peek: "decided:D-2",
      active: { inbox: "decided:D-2" },
      keys: true,
    });
    perform({ type: "move-to", where: "first" });
    expect(s()).toMatchObject({ peek: "asked:AUTH-1", active: { inbox: "asked:AUTH-1" } });
  });

  it("Escape closes it. a card page and Back keep it, the nav and another project do not", () => {
    openRow("inbox", "asked:AUTH-1");
    perform({ type: "close-panel" });
    expect(s()).toMatchObject({ peek: null, view: { name: "inbox" } });

    openRow("inbox", "asked:AUTH-1");
    openCard("AUTH-2");
    back();
    expect(s()).toMatchObject({ peek: "asked:AUTH-1", view: { name: "inbox" } });
    go("inbox");
    expect(s().peek).toBeNull();

    openRow("inbox", "asked:AUTH-1");
    switchProject("billing");
    expect(s().peek).toBeNull();
  });
});

describe("a record push", () => {
  const base = { cards: [head("A-1"), head("A-2")], conclusions: [], problems: [], readAt: 1 };

  it("changed heads are upserts, removed ones go, and the rest stays", () => {
    const next = applyRecord(base, {
      cards: [head("A-2", { title: "new" }), head("A-3")],
      removedCards: ["A-1"],
      readAt: 2,
    });
    expect(next.cards.map((c) => [c.id, c.title])).toEqual([
      ["A-2", "new"],
      ["A-3", "A-3"],
    ]);
    expect(next).toMatchObject({ conclusions: [], readAt: 2 });
  });

  it("replace is the whole list, and conclusions come whole when they come", () => {
    const next = applyRecord(base, { cards: [head("A-9")], replace: true });
    expect(next.cards.map((c) => c.id)).toEqual(["A-9"]);
    expect(next.readAt).toBe(1);
    const c = conclusion("D-1", "x");
    expect(applyRecord(undefined, { conclusions: [c] })).toEqual({
      cards: [],
      conclusions: [c],
      problems: [],
      readAt: undefined,
    });
  });
});
