import { describe, expect, it } from "vitest";
import { interpret, type KeyContext, type KeyInput } from "../../src/renderer/logic/keyboard.ts";

const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  overlay: false,
  query: "",
  inOtherTextField: false,
  inSearch: true,
  pageSize: 8,
  ...over,
});
const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  meta: false,
  alt: false,
  shift: false,
  ctrl: false,
  composing: false,
  ...mods,
});

describe("keyboard model", () => {
  it("arrows move and Enter opens while focus stays in the search field", () => {
    expect(interpret(ctx(), key("ArrowDown"))).toEqual({ type: "move", delta: 1 });
    expect(interpret(ctx(), key("ArrowUp"))).toEqual({ type: "move", delta: -1 });
    expect(interpret(ctx(), key("Enter"))).toEqual({ type: "activate" });
    expect(interpret(ctx(), key("PageDown"))).toEqual({ type: "move", delta: 7 });
  });

  it("'/' focuses search from anywhere else, and is just a character inside it", () => {
    expect(interpret(ctx({ inSearch: false }), key("/"))).toEqual({ type: "focus-search" });
    expect(interpret(ctx({ inSearch: true }), key("/"))).toBeNull();
  });

  it("Escape is a ladder: close the overlay, then clear the query, then focus search", () => {
    expect(interpret(ctx({ overlay: true, query: "x" }), key("Escape"))).toEqual({
      type: "close-overlay",
    });
    expect(interpret(ctx({ query: "x" }), key("Escape"))).toEqual({ type: "clear-query" });
    expect(interpret(ctx(), key("Escape"))).toEqual({ type: "focus-search" });
  });

  it("an open dialog or menu owns every other key", () => {
    expect(interpret(ctx({ overlay: true }), key("ArrowDown"))).toBeNull();
    expect(interpret(ctx({ overlay: true }), key("k", { meta: true }))).toBeNull();
  });

  it("typing in another text field is left alone, shortcuts still work there", () => {
    const c = ctx({ inSearch: false, inOtherTextField: true });
    expect(interpret(c, key("a"))).toBeNull();
    expect(interpret(c, key("ArrowDown"))).toBeNull();
    expect(interpret(c, key("n", { meta: true }))).toEqual({ type: "new-combo" });
  });

  it("a printable key outside any field goes to search", () => {
    expect(interpret(ctx({ inSearch: false }), key("k"))).toEqual({ type: "type-through" });
  });

  it("shortcuts", () => {
    expect(interpret(ctx(), key("k", { meta: true }))).toEqual({ type: "menu" });
    expect(interpret(ctx(), key("Enter", { meta: true }))).toEqual({ type: "activate-default" });
    expect(interpret(ctx(), key("1", { meta: true }))).toEqual({ type: "scope", scope: "combo" });
    expect(interpret(ctx(), key("2", { meta: true }))).toEqual({ type: "scope", scope: "all" });
    expect(interpret(ctx(), key("ArrowDown", { alt: true }))).toEqual({
      type: "combo-step",
      delta: 1,
    });
    expect(interpret(ctx(), key("r", { meta: true }))).toEqual({ type: "refresh" });
    expect(interpret(ctx(), key("R", { meta: true, shift: true }))).toEqual({
      type: "repair-combo",
    });
    expect(interpret(ctx(), key("C", { meta: true, shift: true }))).toEqual({
      type: "copy-resume",
    });
    expect(interpret(ctx(), key("c", { meta: true }))).toBeNull();
    expect(interpret(ctx(), key("d", { meta: true }))).toEqual({ type: "mark-seen" });
    expect(interpret(ctx(), key("D", { meta: true, shift: true }))).toEqual({
      type: "mark-all-seen",
    });
    // a bare letter types into the search field, so every shortcut needs the modifier
    expect(interpret(ctx(), key("d"))).toBeNull();
    expect(interpret(ctx(), key("ArrowDown", { meta: true }))).toEqual({
      type: "move-to",
      where: "last",
    });
  });

  it("IME composition is never interpreted", () => {
    expect(interpret(ctx(), key("Enter", { composing: true }))).toBeNull();
  });

  it("cmd-I opens and closes the inspector, and Escape leaves it one step at a time", () => {
    expect(interpret(ctx(), key("i", { meta: true }))).toEqual({ type: "inspect" });
    const open = ctx({ inspector: true, query: "x" });
    expect(interpret({ ...open, inInspector: true, inSearch: false }, key("Escape"))).toEqual({
      type: "inspector-leave",
    });
    // out of it first, then closed, and only then is the query cleared
    expect(interpret(open, key("Escape"))).toEqual({ type: "inspector-close" });
    // an agent's detail goes back to the list before anything else, wherever the keyboard is
    for (const inInspector of [true, false]) {
      expect(interpret({ ...open, inInspector, inspectorDetail: true }, key("Escape"))).toEqual({
        type: "inspector-back",
      });
    }
    expect(interpret(ctx({ query: "x" }), key("Escape"))).toEqual({ type: "clear-query" });
  });

  it("Tab moves into the inspector, and its own list owns the arrows there", () => {
    expect(interpret(ctx({ inspector: true }), key("Tab"))).toEqual({ type: "inspector-enter" });
    expect(interpret(ctx(), key("Tab"))).toBeNull();
    const inside = ctx({ inspector: true, inInspector: true, inSearch: false });
    expect(interpret(inside, key("Tab", { shift: true }))).toEqual({ type: "inspector-leave" });
    // a second Tab keeps the keyboard where it is, rather than walking off into the footer
    expect(interpret(inside, key("Tab"))).toEqual({ type: "none" });
    expect(interpret(inside, key("ArrowDown"))).toBeNull();
    expect(interpret(inside, key("Enter"))).toBeNull();
    // shortcuts still work from in there
    expect(interpret(inside, key("i", { meta: true }))).toEqual({ type: "inspect" });
  });
});
