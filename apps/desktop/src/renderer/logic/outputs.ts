import { PR_REVIEW_WORD, PR_STATE_WORD, type PrState } from "@grove/core/pure";
import type { PrView } from "../../shared/ipc";

/** the glyph's shape. colour says how it is going, shape what it is */
export type PrGlyphKind = "open" | "draft" | "merged" | "closed";

export interface PrLook {
  glyph: PrGlyphKind;
  /** ui.tsx has the colours: green ready, red failing, faint the rest */
  tone: "green" | "red" | "faint";
  done: boolean;
}

const LOOK: Record<PrState, PrLook> = {
  ready: { glyph: "open", tone: "green", done: false },
  failing: { glyph: "open", tone: "red", done: false },
  pending: { glyph: "open", tone: "faint", done: false },
  draft: { glyph: "draft", tone: "faint", done: false },
  merged: { glyph: "merged", tone: "faint", done: true },
  closed: { glyph: "closed", tone: "faint", done: true },
};

/** a PR gh has not answered for (no gh, or not yet) is an open one with nothing known */
export const lookOf = (p: PrView): PrLook => LOOK[p.state ?? "pending"];

const isOpen = (p: PrView) => !lookOf(p).done;

/**
 * the order a menu and the panel list them in: open ones top of the stack first (the latest
 * linked), then merged and closed the same way
 */
export function ordered(prs: readonly PrView[]): { open: PrView[]; done: PrView[] } {
  const newest = [...prs].reverse();
  return { open: newest.filter(isOpen), done: newest.filter((p) => !isOpen(p)) };
}

const WORST: PrState[] = ["failing", "pending", "draft", "ready"];

/** what a row shows: one open PR as itself, several as the worst of them, all done as done */
export function rollup(prs: readonly PrView[]): { look: PrLook; label: string; single?: PrView } {
  const { open, done } = ordered(prs);
  const only =
    open.length === 1 ? open[0] : !open.length && done.length === 1 ? done[0] : undefined;
  if (only) return { look: lookOf(only), label: `#${only.number}`, single: only };
  if (open.length) {
    const worst = WORST.find((w) => open.some((p) => (p.state ?? "pending") === w)) ?? "pending";
    // a draft inside a stack still reads as an open stack waiting on something
    return { look: LOOK[worst === "draft" ? "pending" : worst], label: `${open.length} PRs` };
  }
  const merged = done.some((p) => p.state === "merged");
  return { look: LOOK[merged ? "merged" : "closed"], label: `${done.length} PRs` };
}

/** `owner/name #12 · checks passed · title`, one per line */
export function prTooltip(prs: readonly PrView[]): string {
  const { open, done } = ordered(prs);
  return [...open, ...done]
    .map((p) =>
      [
        `${p.repo} #${p.number}`,
        p.state ? PR_STATE_WORD[p.state].toLowerCase() : undefined,
        p.review && p.state !== "merged" && p.state !== "closed"
          ? PR_REVIEW_WORD[p.review]
          : undefined,
        p.title,
      ]
        .filter(Boolean)
        .join(" · "),
    )
    .join("\n");
}

/** the repo's name without its owner: the panel and menus have room for the short one */
export const shortRepo = (repo: string) => repo.split("/").pop() || repo;

/** what a row's PRs look like: equal keys draw the same */
export const prsKey = (prs: readonly PrView[] | undefined) =>
  (prs ?? []).map((p) => `${p.url} ${p.state} ${p.review} ${p.title} ${p.stale}`).join("\n");
