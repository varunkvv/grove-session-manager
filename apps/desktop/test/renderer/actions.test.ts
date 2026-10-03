import { beforeEach, describe, expect, it } from "vitest";
import {
  back,
  editProject,
  go,
  newProject,
  openCard,
  openConclusion,
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
    // the next press acts: the first row has a card
    perform({ type: "open" });
    expect(s().view).toEqual({ name: "card", cardId: "AUTH-1" });
  });

  it("the arrows move through this project's rows only, and say the keyboard moved", () => {
    perform({ type: "move", delta: 1 });
    expect(s()).toMatchObject({ active: { inbox: "decided:D-2" }, keys: true });
    perform({ type: "move", delta: 5 });
    expect(s().active.inbox).toBe("decided:D-2");
    perform({ type: "move-to", where: "first" });
    expect(s().active.inbox).toBe("asked:AUTH-1");
  });

  it("Cards moves through the cards and opens one. Conclusions opens a row in place, and closes it", () => {
    go("cards");
    perform({ type: "move-to", where: "last" });
    perform({ type: "open" });
    expect(s().view).toEqual({ name: "card", cardId: "AUTH-2" });
    go("conclusions");
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
