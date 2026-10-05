import type { Section, View } from "../state/store.ts";

export type Intent =
  | { type: "move"; delta: number }
  | { type: "move-to"; where: "first" | "last" }
  | { type: "open" }
  | { type: "open-editor" }
  | { type: "review" }
  | { type: "back" }
  | { type: "collapse" }
  | { type: "close-panel" }
  | { type: "clear-query" }
  | { type: "close-overlay" }
  | { type: "go"; section: Section }
  | { type: "palette" }
  | { type: "project-step"; delta: 1 | -1 }
  | { type: "new-project" }
  | { type: "edit-project" }
  | { type: "open-project" }
  | { type: "refresh" }
  | { type: "settings" }
  | { type: "focus-search" }
  | { type: "type-through" };

export interface KeyContext {
  /** a dialog, the palette or the project menu is open. they own their keys. */
  overlay: boolean;
  view: View["name"];
  /** focus is in an input, textarea or select. the Conclusions search counts. */
  inText: boolean;
  /** focus is in the Conclusions search (#search) */
  inSearch: boolean;
  /** focus is on a control that answers Enter itself: a button, a link, or anything with role button, menuitem, menuitemradio or radio */
  inControl: boolean;
  /** the Conclusions search text */
  query: string;
  /** a Conclusions row is open */
  expanded: boolean;
  /** a row is open in the panel beside the Inbox or the Cards list */
  panel: boolean;
  /** Back has somewhere to go: the stack is not empty */
  canGoBack: boolean;
  /** the New or Edit project form has changes */
  formDirty: boolean;
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

const isList = (view: View["name"]) =>
  view === "inbox" || view === "cards" || view === "conclusions";

/** arrows, page keys, Home, End and Enter on a list */
function listKey(ctx: KeyContext, key: string, withEnds: boolean): Intent | null {
  const page = Math.max(1, ctx.pageSize - 1);
  switch (key) {
    case "ArrowDown":
      return { type: "move", delta: 1 };
    case "ArrowUp":
      return { type: "move", delta: -1 };
    case "PageDown":
      return { type: "move", delta: page };
    case "PageUp":
      return { type: "move", delta: -page };
    case "Enter":
      return { type: "open" };
  }
  if (withEnds && key === "Home") return { type: "move-to", where: "first" };
  if (withEnds && key === "End") return { type: "move-to", where: "last" };
  return null;
}

/**
 * one place that decides what a key means. no single letter acts on any screen: Inbox, Cards and
 * the card page have no field to type into, and a letter on Conclusions goes to its search.
 */
export function interpret(ctx: KeyContext, e: KeyInput): Intent | null {
  if (e.composing) return null;
  if (e.key === "Escape") {
    if (ctx.overlay) return { type: "close-overlay" };
    if (ctx.view === "conclusions" && ctx.expanded) return { type: "collapse" };
    if (ctx.view === "conclusions" && ctx.query) return { type: "clear-query" };
    if ((ctx.view === "inbox" || ctx.view === "cards") && ctx.panel) return { type: "close-panel" };
    if (ctx.view === "card") return { type: "back" };
    // a form with changes is not thrown away by a stray Escape
    if (ctx.view === "new-project" || ctx.view === "edit-project") {
      return ctx.formDirty ? null : { type: "back" };
    }
    return ctx.canGoBack ? { type: "back" } : null;
  }
  if (ctx.overlay) return null;

  if (e.meta && !e.alt && !e.ctrl) {
    // cmd-shift-anything is the system's or a field's: selection, redo
    if (e.shift) return null;
    switch (e.key.toLowerCase()) {
      case "k":
        return { type: "palette" };
      case "1":
        return { type: "go", section: "inbox" };
      case "2":
        return { type: "go", section: "cards" };
      case "3":
        return { type: "go", section: "conclusions" };
      case "n":
        return { type: "new-project" };
      case "e":
        return { type: "edit-project" };
      case "o":
        return { type: "open-project" };
      case "r":
        return { type: "refresh" };
      case ",":
        return { type: "settings" };
      case "f":
        return { type: "focus-search" };
      case "enter":
        return { type: "open-editor" };
      case "d":
        return { type: "review" };
    }
    // only where there is a list: in a form's field these move the caret
    if (isList(ctx.view)) {
      if (e.key === "ArrowDown") return { type: "move-to", where: "last" };
      if (e.key === "ArrowUp") return { type: "move-to", where: "first" };
    }
    return null;
  }

  if (ctx.inText && !ctx.inSearch) return null;
  // the button's own click runs. a list is not a control, so its Enter still opens the active row
  if (ctx.inControl && (e.key === "Enter" || e.key === " ")) return null;

  if (e.alt && !e.meta && !e.ctrl) {
    if (e.key === "ArrowDown") return { type: "project-step", delta: 1 };
    if (e.key === "ArrowUp") return { type: "project-step", delta: -1 };
    return null;
  }
  if (e.ctrl) return null;

  // everything else types
  if (ctx.inSearch) return listKey(ctx, e.key, false);
  if (ctx.view === "inbox" || ctx.view === "cards") return listKey(ctx, e.key, true);
  if (ctx.view === "conclusions") {
    const list = listKey(ctx, e.key, true);
    if (list) return list;
    if (e.key === "/") return { type: "focus-search" };
    return e.key.length === 1 ? { type: "type-through" } : null;
  }
  // a card: arrows, space and the page keys scroll its main column
  return null;
}
