import { describe, expect, it } from "vitest";
import { interpret, type KeyContext, type KeyInput } from "../../src/renderer/logic/keyboard.ts";

const ctx = (o: Partial<KeyContext> = {}): KeyContext => ({
  overlay: false,
  view: "inbox",
  inText: false,
  inSearch: false,
  inControl: false,
  query: "",
  expanded: false,
  canGoBack: false,
  formDirty: false,
  pageSize: 10,
  ...o,
});

const key = (k: string, o: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  meta: false,
  alt: false,
  shift: false,
  ctrl: false,
  composing: false,
  ...o,
});
const cmd = (k: string, o: Partial<KeyInput> = {}) => key(k, { meta: true, ...o });
const search = { view: "conclusions", inText: true, inSearch: true } as const;

describe("what a key means", () => {
  it("nothing while an IME composes", () => {
    expect(interpret(ctx(), key("Enter", { composing: true }))).toBeNull();
    expect(interpret(ctx({ overlay: true }), key("Escape", { composing: true }))).toBeNull();
  });

  it("Escape: one step at a time, by screen", () => {
    expect(interpret(ctx({ overlay: true, view: "card" }), key("Escape"))).toEqual({
      type: "close-overlay",
    });
    const conclusions = (o: Partial<KeyContext>) =>
      interpret(ctx({ view: "conclusions", ...o }), key("Escape"));
    // the open row, then the search, then back
    expect(conclusions({ expanded: true, query: "redis", canGoBack: true })).toEqual({
      type: "collapse",
    });
    expect(conclusions({ query: "redis", canGoBack: true })).toEqual({ type: "clear-query" });
    expect(conclusions({ canGoBack: true })).toEqual({ type: "back" });
    expect(conclusions({})).toBeNull();
    expect(interpret(ctx({ view: "card" }), key("Escape"))).toEqual({ type: "back" });
    expect(interpret(ctx({ view: "inbox" }), key("Escape"))).toBeNull();
    expect(interpret(ctx({ view: "cards", canGoBack: true }), key("Escape"))).toEqual({
      type: "back",
    });
  });

  it("Escape leaves a form, unless it has changes", () => {
    for (const view of ["new-project", "edit-project"] as const) {
      expect(interpret(ctx({ view, inText: true }), key("Escape"))).toEqual({ type: "back" });
      expect(interpret(ctx({ view, inText: true, formDirty: true }), key("Escape"))).toBeNull();
    }
  });

  it("an open dialog, palette or project menu owns every other key", () => {
    const open = ctx({ overlay: true });
    for (const k of [key("ArrowDown"), key("Enter"), cmd("k"), cmd("1"), cmd("Enter"), key("a")]) {
      expect(interpret(open, k), k.key).toBeNull();
    }
  });

  it("the cmd table", () => {
    const table: Array<[string, unknown]> = [
      ["k", { type: "palette" }],
      ["1", { type: "go", section: "inbox" }],
      ["2", { type: "go", section: "cards" }],
      ["3", { type: "go", section: "conclusions" }],
      ["n", { type: "new-project" }],
      ["e", { type: "edit-project" }],
      ["o", { type: "open-project" }],
      ["r", { type: "refresh" }],
      [",", { type: "settings" }],
      ["f", { type: "focus-search" }],
      ["Enter", { type: "open-editor" }],
      ["d", { type: "review" }],
      ["ArrowUp", { type: "move-to", where: "first" }],
      ["ArrowDown", { type: "move-to", where: "last" }],
    ];
    for (const [k, intent] of table) expect(interpret(ctx(), cmd(k)), k).toEqual(intent);
    // caps lock, or shift held for another reason on a letter the system gives upper-cased
    expect(interpret(ctx(), cmd("K"))).toEqual({ type: "palette" });
  });

  it("cmd keys still act while a field or a button has focus", () => {
    const field = ctx({ view: "edit-project", inText: true });
    expect(interpret(field, cmd("k"))).toEqual({ type: "palette" });
    expect(interpret(field, cmd("2"))).toEqual({ type: "go", section: "cards" });
    expect(interpret(ctx({ inControl: true }), cmd("Enter"))).toEqual({ type: "open-editor" });
  });

  it("cmd keys that are gone, and the ones a field keeps for itself", () => {
    for (const k of ["t", "4", "i", "g", "j", "a", "c", "v", "z"]) {
      expect(interpret(ctx(), cmd(k)), k).toBeNull();
    }
    // cmd-shift is selection and redo, and the old shift shortcuts are gone
    for (const k of ["d", "a", "c", "r", "z", "ArrowDown"]) {
      expect(interpret(ctx(), cmd(k, { shift: true })), k).toBeNull();
    }
    // in a form's field cmd-arrows move the caret: there is no list to jump through
    expect(interpret(ctx({ view: "new-project", inText: true }), cmd("ArrowUp"))).toBeNull();
    expect(interpret(ctx({ view: "card" }), cmd("ArrowDown"))).toBeNull();
  });

  it("a text field swallows plain keys", () => {
    const field = ctx({ view: "edit-project", inText: true });
    for (const k of ["ArrowDown", "Enter", "a", "/", "Home", " "]) {
      expect(interpret(field, key(k)), k).toBeNull();
    }
    expect(interpret(field, key("ArrowDown", { alt: true }))).toBeNull();
  });

  it("Enter and Space on a focused control are the control's own", () => {
    const button = ctx({ view: "cards", inControl: true });
    expect(interpret(button, key("Enter"))).toBeNull();
    expect(interpret(button, key(" "))).toBeNull();
    // the arrows still move the list behind it
    expect(interpret(button, key("ArrowDown"))).toEqual({ type: "move", delta: 1 });
  });

  it("alt-arrows step through the projects, and ctrl is left alone", () => {
    expect(interpret(ctx(), key("ArrowDown", { alt: true }))).toEqual({
      type: "project-step",
      delta: 1,
    });
    expect(interpret(ctx({ view: "card" }), key("ArrowUp", { alt: true }))).toEqual({
      type: "project-step",
      delta: -1,
    });
    expect(interpret(ctx(), key("a", { alt: true }))).toBeNull();
    expect(interpret(ctx(), key("ArrowDown", { ctrl: true }))).toBeNull();
  });

  it("Inbox and Cards: arrows, pages, Home, End and Enter. no letter acts", () => {
    for (const view of ["inbox", "cards"] as const) {
      const c = ctx({ view });
      expect(interpret(c, key("ArrowDown"))).toEqual({ type: "move", delta: 1 });
      expect(interpret(c, key("ArrowUp"))).toEqual({ type: "move", delta: -1 });
      expect(interpret(c, key("PageDown"))).toEqual({ type: "move", delta: 9 });
      expect(interpret(c, key("PageUp"))).toEqual({ type: "move", delta: -9 });
      expect(interpret(c, key("Home"))).toEqual({ type: "move-to", where: "first" });
      expect(interpret(c, key("End"))).toEqual({ type: "move-to", where: "last" });
      expect(interpret(c, key("Enter"))).toEqual({ type: "open" });
      for (const k of ["j", "k", "o", "r", "/", " ", "a"]) {
        expect(interpret(c, key(k)), `${view} ${k}`).toBeNull();
      }
    }
    expect(interpret(ctx({ pageSize: 1 }), key("PageDown"))).toEqual({ type: "move", delta: 1 });
  });

  it("in the Conclusions search the arrows and Enter drive the list, and everything else types", () => {
    const c = ctx(search);
    expect(interpret(c, key("ArrowDown"))).toEqual({ type: "move", delta: 1 });
    expect(interpret(c, key("PageUp"))).toEqual({ type: "move", delta: -9 });
    expect(interpret(c, key("Enter"))).toEqual({ type: "open" });
    for (const k of ["a", "/", " ", "Home", "End", "Backspace"]) {
      expect(interpret(c, key(k)), k).toBeNull();
    }
    expect(interpret(c, cmd("d"))).toEqual({ type: "review" });
  });

  it("on Conclusions outside the search, a letter goes to the search", () => {
    const c = ctx({ view: "conclusions" });
    expect(interpret(c, key("ArrowDown"))).toEqual({ type: "move", delta: 1 });
    expect(interpret(c, key("End"))).toEqual({ type: "move-to", where: "last" });
    expect(interpret(c, key("Enter"))).toEqual({ type: "open" });
    expect(interpret(c, key("/"))).toEqual({ type: "focus-search" });
    expect(interpret(c, key("r"))).toEqual({ type: "type-through" });
    expect(interpret(c, key("Tab"))).toBeNull();
    expect(interpret(c, key("Shift"))).toBeNull();
  });

  it("a card leaves arrows, space and the page keys to the browser, which scrolls it", () => {
    const c = ctx({ view: "card" });
    for (const k of ["ArrowDown", "ArrowUp", " ", "PageDown", "Home", "Enter", "a", "/"]) {
      expect(interpret(c, key(k)), k).toBeNull();
    }
    expect(interpret(c, cmd("Enter"))).toEqual({ type: "open-editor" });
  });
});
