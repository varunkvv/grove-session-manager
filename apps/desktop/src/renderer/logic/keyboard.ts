import type { Section, View } from "../state/store.ts";

export type Intent =
  | { type: "move"; delta: number }
  | { type: "move-to"; where: "first" | "last" }
  | { type: "open" }
  | { type: "open-editor" }
  | { type: "review" }
  | { type: "back" }
  | { type: "close-panel" }
  | { type: "clear-query" }
  | { type: "close-overlay" }
  | { type: "go"; section: Section }
  | { type: "go-usage" }
  | { type: "palette" }
  | { type: "project-step"; delta: 1 | -1 }
  | { type: "new-project" }
  | { type: "edit-project" }
  | { type: "archive-project" }
  | { type: "open-project" }
  | { type: "refresh" }
  | { type: "settings" }
  | { type: "focus-search" };

export interface KeyContext {
  /** a dialog or the palette is open. they own their keys. */
  overlay: boolean;
  view: View["name"];
  /** focus is in an input, textarea or select. the search field counts. */
  inText: boolean;
  /** focus is in the top bar's search field (#search) */
  inSearch: boolean;
  /** focus is on a control that answers Enter itself: a button, a link, or anything with role button, menuitem or radio */
  inControl: boolean;
  /** what is typed in the search field */
  query: string;
  /** a session is open in the panel beside its list */
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

const isList = (view: View["name"]) => view === "inbox" || view === "sessions";

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
 * one place that decides what a key means. no single letter acts on any screen: a letter only ever
 * types, in the sessions filter or a form.
 */
export function interpret(ctx: KeyContext, e: KeyInput): Intent | null {
  if (e.composing) return null;
  if (e.key === "Escape") {
    if (ctx.overlay) return { type: "close-overlay" };
    // one step at a time: the panel, then what was typed in the search
    if (isList(ctx.view) && ctx.panel) return { type: "close-panel" };
    if (isList(ctx.view) && ctx.query) return { type: "clear-query" };
    // a form with changes is not thrown away by a stray Escape
    if (ctx.view === "new-project" || ctx.view === "edit-project") {
      return ctx.formDirty ? null : { type: "back" };
    }
    return ctx.canGoBack ? { type: "back" } : null;
  }
  if (ctx.overlay) return null;

  if (e.meta && !e.alt && !e.ctrl) {
    // cmd-shift-A puts the project on screen away, or brings it back. any other cmd-shift is the
    // system's or a field's: selection, redo
    if (e.shift) return e.key.toLowerCase() === "a" ? { type: "archive-project" } : null;
    switch (e.key.toLowerCase()) {
      case "k":
        return { type: "palette" };
      case "1":
        return { type: "go", section: "inbox" };
      case "2":
        return { type: "go", section: "sessions" };
      case "3":
        return { type: "go-usage" };
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

  // in the filter everything else types. Home and End move its caret
  if (isList(ctx.view)) return listKey(ctx, e.key, !ctx.inSearch);
  return null;
}
