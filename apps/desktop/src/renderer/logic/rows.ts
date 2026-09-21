import { type DayBucket, dayBucket, snippetAround, tokenize } from "@grove/core/pure";
import type { SessionKey, SessionRow } from "../../shared/ipc.ts";

export type Scope = "combo" | "all";

export type ListItem =
  | { type: "header"; id: string; label: DayBucket }
  | { type: "row"; id: SessionKey; row: SessionRow; secondary: string; secondaryIsMatch: boolean };

export interface ListModel {
  items: ListItem[];
  keys: SessionKey[];
  tokens: string[];
  /** matches outside the current scope. a scoped search must never silently hide a result. */
  elsewhere: number;
  scoped: boolean;
}

const haystacks = new WeakMap<SessionRow, string>();

function haystack(r: SessionRow): string {
  let h = haystacks.get(r);
  if (h === undefined) {
    h = [
      r.title,
      r.firstPrompt,
      r.lastPrompt,
      r.comboName,
      r.gitBranch,
      r.cwdBase,
      r.tag,
      r.prNumber ? `#${r.prNumber} ${r.prRepo ?? ""}` : undefined,
      r.sessionId,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    haystacks.set(r, h);
  }
  return h;
}

function matches(r: SessionRow, tokens: readonly string[]): boolean {
  const h = haystack(r);
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
  opts: { scope: Scope; combo: string | null; query: string; now: number },
): ListModel {
  const tokens = tokenize(opts.query);
  const scoped = opts.scope === "combo" && opts.combo !== null;
  const items: ListItem[] = [];
  const keys: SessionKey[] = [];
  let elsewhere = 0;
  let bucket: DayBucket | null = null;

  for (const r of rows) {
    if (tokens.length > 0 && !matches(r, tokens)) continue;
    if (scoped && r.comboName !== opts.combo) {
      if (tokens.length > 0) elsewhere++;
      continue;
    }
    const b = dayBucket(r.activityMs, opts.now);
    if (b !== bucket) {
      bucket = b;
      items.push({ type: "header", id: `h:${b}`, label: b });
    }
    const secondary = secondaryLine(r, tokens);
    items.push({
      type: "row",
      id: r.key,
      row: r,
      secondary: secondary.text,
      secondaryIsMatch: secondary.isMatch,
    });
    keys.push(r.key);
  }
  return { items, keys, tokens, elsewhere, scoped };
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
