import {
  type DayBucket,
  dayBucket,
  type LiveStatus,
  snippetAround,
  tokenize,
} from "@grove/core/pure";
import { rowHaystack } from "../../shared/haystack.ts";
import type { SessionKey, SessionRow } from "../../shared/ipc.ts";

export type Scope = "combo" | "all";

export type ListItem =
  | { type: "header"; id: string; label: DayBucket | typeof NEEDS_YOU }
  | { type: "row"; id: SessionKey; row: SessionRow; secondary: string; secondaryIsMatch: boolean };

export interface ListModel {
  items: ListItem[];
  keys: SessionKey[];
  tokens: string[];
  /** matches outside the current scope. a scoped search must never silently hide a result. */
  elsewhere: number;
  scoped: boolean;
  /** archived rows this list left out. same rule: never silently hide one. */
  archivedHidden: number;
  /** `is:archived` was typed, so the archive is what is on screen */
  archivedOnly: boolean;
}

export const NEEDS_YOU = "Needs you";

/** typed into the search box to see the archive instead of hiding it. a mode, not a word. */
export const ARCHIVED_FILTER = "is:archived";
const ARCHIVED_RE = String.raw`(^|\s)is:archived(?=\s|$)`;

export interface ParsedQuery {
  /** what is actually searched for: the query with the mode words taken out */
  text: string;
  tokens: string[];
  archivedOnly: boolean;
}

/**
 * one place that splits a query into a mode and words, so the instant filter and the conversation
 * search in the main process are never looking for different things. a quoted "is:archived" is a
 * literal search, because the mode has to sit on its own.
 */
export function splitQuery(query: string): ParsedQuery {
  const archivedOnly = new RegExp(ARCHIVED_RE, "i").test(query);
  const text = archivedOnly ? query.replace(new RegExp(ARCHIVED_RE, "gi"), "$1").trim() : query;
  return { text, tokens: tokenize(text), archivedOnly };
}

/** asking for permission, turn over, or stopped on an error - and nobody has looked yet */
export function needsYou(live: LiveStatus | undefined): boolean {
  return (
    !!live &&
    !live.seen &&
    (live.state === "permission" || live.state === "waiting" || live.state === "failed")
  );
}

function matches(r: SessionRow, tokens: readonly string[]): boolean {
  const h = rowHaystack(r);
  return tokens.every((t) => h.includes(t));
}

/** the second line of a row: why it matched when the title does not show it, else what it was about */
function secondaryLine(
  r: SessionRow,
  tokens: readonly string[],
): { text: string; isMatch: boolean } {
  const title = (r.title ?? "").toLowerCase();
  const missing = tokens.filter((t) => !title.includes(t));
  if (missing.length > 0) {
    for (const field of [r.firstPrompt, r.lastPrompt]) {
      const snippet = field ? snippetAround(field, missing) : undefined;
      if (snippet) return { text: snippet, isMatch: true };
    }
  }
  if (r.firstPrompt && r.firstPrompt !== r.title) return { text: r.firstPrompt, isMatch: false };
  if (r.lastPrompt && r.lastPrompt !== r.title) return { text: r.lastPrompt, isMatch: false };
  return { text: "", isMatch: false };
}

/** rows arrive newest first and stay that way: recency is the ranking, search only narrows */
export function buildList(
  rows: readonly SessionRow[],
  opts: {
    scope: Scope;
    combo: string | null;
    query: string;
    now: number;
    /** rows found in their conversation by the main process, with the part that matched */
    deep?: ReadonlyMap<SessionKey, string>;
  },
): ListModel {
  const { tokens, archivedOnly } = splitQuery(opts.query);
  const scoped = opts.scope === "combo" && opts.combo !== null;
  const items: ListItem[] = [];
  const keys: SessionKey[] = [];
  let elsewhere = 0;
  let archivedHidden = 0;
  let bucket: DayBucket | null = null;

  const inScope: Array<{ r: SessionRow; deep?: string }> = [];
  for (const r of rows) {
    const deep = tokens.length > 0 && !matches(r, tokens) ? opts.deep?.get(r.key) : undefined;
    if (tokens.length > 0 && deep === undefined && !matches(r, tokens)) continue;
    if (scoped && r.comboName !== opts.combo) {
      if (tokens.length > 0) elsewhere++;
      continue;
    }
    // archiving hides a session unless it is asking for someone. a permission prompt nobody sees
    // is worse than a row they did not want, and a hidden one is always counted, never dropped.
    if (archivedOnly) {
      if (!r.archived) continue;
    } else if (r.archived && !needsYou(r.live)) {
      archivedHidden++;
      continue;
    }
    inScope.push({ r, ...(deep !== undefined ? { deep } : {}) });
  }

  // with no query, sessions waiting on a person come first. a search is about finding, not triage.
  const pinned = tokens.length === 0 ? inScope.filter(({ r }) => needsYou(r.live)) : [];
  const rest = pinned.length ? inScope.filter(({ r }) => !needsYou(r.live)) : inScope;
  if (pinned.length) {
    pinned.sort((a, b) => (b.r.live?.at ?? 0) - (a.r.live?.at ?? 0));
    items.push({ type: "header", id: "h:needs-you", label: NEEDS_YOU });
    for (const { r } of pinned) {
      const secondary = secondaryLine(r, tokens);
      items.push({
        type: "row",
        id: r.key,
        row: r,
        secondary: secondary.text,
        secondaryIsMatch: false,
      });
      keys.push(r.key);
    }
  }

  for (const { r, deep } of rest) {
    const b = dayBucket(r.activityMs, opts.now);
    if (b !== bucket) {
      bucket = b;
      items.push({ type: "header", id: `h:${b}`, label: b });
    }
    const secondary = deep !== undefined ? { text: deep, isMatch: true } : secondaryLine(r, tokens);
    items.push({
      type: "row",
      id: r.key,
      row: r,
      secondary: secondary.text,
      secondaryIsMatch: secondary.isMatch,
    });
    keys.push(r.key);
  }
  return { items, keys, tokens, elsewhere, scoped, archivedHidden, archivedOnly };
}

/**
 * the rows on screen that are asking for someone. that is what "mark everything as seen" means:
 * the inbox you are looking at, scope and all, not every session on the machine.
 */
export function needsYouKeys(model: ListModel): SessionKey[] {
  return model.items.flatMap((i) => (i.type === "row" && needsYou(i.row.live) ? [i.id] : []));
}

/** which row is active after the list changed. tracked by key, so live inserts never move it. */
export function nextActiveKey(
  prevKeys: readonly SessionKey[],
  nextKeys: readonly SessionKey[],
  active: SessionKey | null,
  queryChanged: boolean,
): SessionKey | null {
  if (nextKeys.length === 0) return null;
  if (queryChanged || active === null) return nextKeys[0] ?? null;
  if (nextKeys.includes(active)) return active;
  const was = prevKeys.indexOf(active);
  return nextKeys[Math.min(Math.max(was, 0), nextKeys.length - 1)] ?? null;
}
