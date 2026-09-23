import type { Scope } from "./rows.ts";

export type Intent =
  | { type: "move"; delta: number }
  | { type: "move-to"; where: "first" | "last" }
  | { type: "activate" }
  | { type: "activate-default" }
  | { type: "menu" }
  | { type: "focus-search" }
  | { type: "clear-query" }
  | { type: "close-overlay" }
  | { type: "scope"; scope: Scope }
  | { type: "combo-step"; delta: 1 | -1 }
  | { type: "copy-resume" }
  | { type: "mark-seen" }
  | { type: "mark-all-seen" }
  | { type: "new-combo" }
  | { type: "open-combo" }
  | { type: "edit-combo" }
  | { type: "repair-combo" }
  | { type: "refresh" }
  | { type: "settings" }
  | { type: "type-through" };

export interface KeyContext {
  /** a dialog or the action menu is open. they handle their own keys. */
  overlay: boolean;
  query: string;
  /** DOM focus is in a text field other than the search field */
  inOtherTextField: boolean;
  inSearch: boolean;
  pageSize: number;
}

export interface KeyInput {
  key: string;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  composing: boolean;
}

/**
 * one place that decides what a key means. focus stays in the search field while the arrows move
 * the active row (combobox + listbox): the only way "search is always focused" and "arrow keys
 * move" are both true.
 */
export function interpret(ctx: KeyContext, e: KeyInput): Intent | null {
  if (e.composing) return null;
  if (e.key === "Escape") {
    if (ctx.overlay) return { type: "close-overlay" };
    if (ctx.query) return { type: "clear-query" };
    return { type: "focus-search" };
  }
  if (ctx.overlay) return null;

  if (e.meta && !e.alt && !e.ctrl) {
    const k = e.key.toLowerCase();
    if (k === "k") return { type: "menu" };
    if (k === "f") return { type: "focus-search" };
    if (k === "1") return { type: "scope", scope: "combo" };
    if (k === "2") return { type: "scope", scope: "all" };
    if (k === "n") return { type: "new-combo" };
    if (k === "o") return { type: "open-combo" };
    if (k === "e") return { type: "edit-combo" };
    if (k === ",") return { type: "settings" };
    if (k === "r") return e.shift ? { type: "repair-combo" } : { type: "refresh" };
    if (k === "c" && e.shift) return { type: "copy-resume" };
    // the "i have read that" key. today it costs a right click and a menu item.
    if (k === "d") return e.shift ? { type: "mark-all-seen" } : { type: "mark-seen" };
    if (e.key === "Enter") return { type: "activate-default" };
    if (e.key === "ArrowDown") return { type: "move-to", where: "last" };
    if (e.key === "ArrowUp") return { type: "move-to", where: "first" };
    return null;
  }
  if (ctx.inOtherTextField) return null;

  if (e.alt && !e.meta && !e.ctrl) {
    if (e.key === "ArrowDown") return { type: "combo-step", delta: 1 };
    if (e.key === "ArrowUp") return { type: "combo-step", delta: -1 };
    return null;
  }
  if (e.ctrl) return null;

  switch (e.key) {
    case "ArrowDown":
      return { type: "move", delta: 1 };
    case "ArrowUp":
      return { type: "move", delta: -1 };
    case "PageDown":
      return { type: "move", delta: Math.max(1, ctx.pageSize - 1) };
    case "PageUp":
      return { type: "move", delta: -Math.max(1, ctx.pageSize - 1) };
    case "Enter":
      return { type: "activate" };
    case "/":
      return ctx.inSearch ? null : { type: "focus-search" };
  }
  if (!ctx.inSearch) {
    if (e.key === "Home") return { type: "move-to", where: "first" };
    if (e.key === "End") return { type: "move-to", where: "last" };
    // typing anywhere goes to the search field
    if (e.key.length === 1) return { type: "type-through" };
  }
  return null;
}
