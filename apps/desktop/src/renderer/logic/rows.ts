import {
  type DayBucket,
  dayBucket,
  type LiveStatus,
  type SessionAgent,
  snippetAround,
  tokenize,
} from "@grove/core/pure";
import { rowHaystack } from "../../shared/haystack.ts";
import type { SearchHit, SessionKey, SessionRow } from "../../shared/ipc.ts";
import { MAIN_ID } from "./inspector.ts";

export type Scope = "combo" | "all" | "agents" | "inbox";

export type ListItem =
  | {
      type: "header";
      id: string;
      label: DayBucket | typeof NEEDS_YOU | typeof RUNNING;
      /** how many rows are under it: "Needs you · 3" */
      count?: number;
    }
  | {
      type: "row";
      id: SessionKey;
      row: SessionRow;
      secondary: string;
      secondaryIsMatch: boolean;
      /** the second line is what this agent said: the search found the session through it */
      agent?: string;
      /** it sits in the band behind what needs you, the last one rounding it off */
      band?: "in" | "last";
    }
  | {
      type: "agent";
      id: string;
      row: SessionRow;
      agent: SessionAgent;
      /** what it said that matched, when its labels did not */
      match?: string;
    }
  /** a session asking for someone, in the Inbox: taller, and saying what it asks */
  | { type: "inbox"; id: SessionKey; row: SessionRow }
  /** a running session's own conversation, among the agents at work */
  | { type: "main"; id: string; row: SessionRow };

/**
 * an agent's row in the Agents scope. the list, the keyboard and the active row all work on keys,
 * so an agent gets one of its own: its session's key and its id, split by a NUL no path can hold.
 */
const AGENT_KEY = "\0agent:";

export function agentKey(session: SessionKey, agentId: string): string {
  return `${session}${AGENT_KEY}${agentId}`;
}

/** the id a session's own conversation takes among its agents: one id for the pane and the scope */
export const MAIN_AGENT = MAIN_ID;

/** the session a key belongs to: itself, or the session of the agent it names */
export function sessionKeyOf(key: string): SessionKey {
  const at = key.indexOf(AGENT_KEY);
  return at < 0 ? key : key.slice(0, at);
}

/** the agent a key names, or null for a session's key */
export function agentIdOf(key: string): string | null {
  const at = key.indexOf(AGENT_KEY);
  return at < 0 ? null : key.slice(at + AGENT_KEY.length);
}

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
export const RUNNING = "Running";

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
    deep?: ReadonlyMap<SessionKey, SearchHit>;
  },
): ListModel {
  if (opts.scope === "agents") return buildAgentList(rows, opts);
  if (opts.scope === "inbox") return buildInbox(rows, opts);
  const { tokens, archivedOnly } = splitQuery(opts.query);
  const scoped = opts.scope === "combo" && opts.combo !== null;
  const items: ListItem[] = [];
  const keys: SessionKey[] = [];
  let elsewhere = 0;
  let archivedHidden = 0;
  let bucket: DayBucket | null = null;

  const inScope: Array<{ r: SessionRow; deep?: SearchHit }> = [];
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
    items.push({ type: "header", id: "h:needs-you", label: NEEDS_YOU, count: pinned.length });
    pinned.forEach(({ r }, i) => {
      const secondary = secondaryLine(r, tokens);
      items.push({
        type: "row",
        id: r.key,
        row: r,
        secondary: secondary.text,
        secondaryIsMatch: false,
        band: i === pinned.length - 1 ? "last" : "in",
      });
      keys.push(r.key);
    });
  }

  for (const { r, deep } of rest) {
    const b = dayBucket(r.activityMs, opts.now);
    if (b !== bucket) {
      bucket = b;
      items.push({ type: "header", id: `h:${b}`, label: b });
    }
    const secondary =
      deep !== undefined ? { text: deep.snippet, isMatch: true } : secondaryLine(r, tokens);
    items.push({
      type: "row",
      id: r.key,
      row: r,
      secondary: secondary.text,
      secondaryIsMatch: secondary.isMatch,
      ...(deep?.agent ? { agent: deep.agent } : {}),
    });
    keys.push(r.key);
  }
  return { items, keys, tokens, elsewhere, scoped, archivedHidden, archivedOnly };
}

function mainMatches(r: SessionRow, tokens: readonly string[]): boolean {
  const hay = ["main conversation", r.title, r.comboName, r.cwdBase]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function agentMatches(a: SessionAgent, r: SessionRow, tokens: readonly string[]): boolean {
  const hay = [a.description, a.asked, a.agentType, a.summary, r.title, r.comboName, r.cwdBase]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * every agent on the machine, in one list: the running ones first, then by the day they last did
 * something, like sessions. across every session - an agent is found by what it did, not by
 * where it ran. the archive's rule holds here too: its agents are hidden, and counted.
 */
export function buildAgentList(
  rows: readonly SessionRow[],
  opts: { query: string; now: number; deep?: ReadonlyMap<SessionKey, SearchHit> },
): ListModel {
  const { tokens, archivedOnly } = splitQuery(opts.query);
  const found: Array<{ r: SessionRow; a: SessionAgent; match?: string }> = [];
  let archivedHidden = 0;
  for (const r of rows) {
    // what the agents said, from the search in main: an agent is found by what it found
    const said = new Map((opts.deep?.get(r.key)?.agents ?? []).map((h) => [h.id, h.snippet]));
    for (const a of r.agents ?? []) {
      const labelled = tokens.length === 0 || agentMatches(a, r, tokens);
      const match = labelled ? undefined : said.get(a.id);
      if (!labelled && match === undefined) continue;
      if (archivedOnly) {
        if (!r.archived) continue;
      } else if (r.archived) {
        archivedHidden++;
        continue;
      }
      found.push({ r, a, ...(match !== undefined ? { match } : {}) });
    }
  }
  const running = found.filter(({ a }) => a.state === "running");
  const done = found.filter(({ a }) => a.state !== "running");
  running.sort((x, y) => y.a.startedAt - x.a.startedAt);
  done.sort((x, y) => y.a.lastActivityAt - x.a.lastActivityAt);
  // a session at work is working too: "Running" answers what is working right now. a finished
  // one is not listed - the Sessions scope already has it
  const mains = rows.filter(
    (r) =>
      r.live?.state === "running" &&
      (archivedOnly ? r.archived : !r.archived) &&
      (tokens.length === 0 || mainMatches(r, tokens)),
  );

  const items: ListItem[] = [];
  const keys: SessionKey[] = [];
  const push = ({ r, a, match }: { r: SessionRow; a: SessionAgent; match?: string }) => {
    const id = agentKey(r.key, a.id);
    items.push({ type: "agent", id, row: r, agent: a, ...(match !== undefined ? { match } : {}) });
    keys.push(id);
  };
  if (running.length > 0 || mains.length > 0) {
    items.push({ type: "header", id: "h:running", label: RUNNING });
    // the running ones newest first, sessions and agents alike
    type Working =
      | { kind: "agent"; at: number; hit: { r: SessionRow; a: SessionAgent; match?: string } }
      | { kind: "main"; at: number; r: SessionRow };
    const both: Working[] = [
      ...running.map((hit): Working => ({ kind: "agent", at: hit.a.startedAt, hit })),
      ...mains.map((r): Working => ({ kind: "main", at: r.live?.turnStart ?? r.live?.at ?? 0, r })),
    ].sort((x, y) => y.at - x.at);
    for (const x of both) {
      if (x.kind === "agent") {
        push(x.hit);
        continue;
      }
      const id = agentKey(x.r.key, MAIN_AGENT);
      items.push({ type: "main", id, row: x.r });
      keys.push(id);
    }
  }
  let bucket: DayBucket | null = null;
  for (const hit of done) {
    const b = dayBucket(hit.a.lastActivityAt, opts.now);
    if (b !== bucket) {
      bucket = b;
      items.push({ type: "header", id: `h:${b}`, label: b });
    }
    push(hit);
  }
  return { items, keys, tokens, elsewhere: 0, scoped: false, archivedHidden, archivedOnly };
}

/** how many sessions are asking for someone right now: the Inbox's count */
export function inboxCount(rows: readonly SessionRow[]): number {
  return rows.filter((r) => needsYou(r.live)).length;
}

/**
 * everything asking for someone, and nothing else - the same rule as the dock badge and the
 * pinned group, archive included (a prompt nobody sees is worse than a row nobody wanted). the
 * newest ask first, like the pinned group. a query narrows it like any list.
 */
export function buildInbox(rows: readonly SessionRow[], opts: { query: string }): ListModel {
  const { tokens, archivedOnly } = splitQuery(opts.query);
  const asking = rows
    .filter((r) => needsYou(r.live) && (tokens.length === 0 || matches(r, tokens)))
    .sort((a, b) => (b.live?.at ?? 0) - (a.live?.at ?? 0));
  return {
    items: asking.map((row) => ({ type: "inbox", id: row.key, row })),
    keys: asking.map((r) => r.key),
    tokens,
    elsewhere: 0,
    scoped: false,
    archivedHidden: 0,
    archivedOnly,
  };
}

/**
 * the rows on screen that are asking for someone. that is what "mark everything as seen" means:
 * the inbox you are looking at, scope and all, not every session on the machine.
 */
export function needsYouKeys(model: ListModel): SessionKey[] {
  return model.items.flatMap((i) =>
    (i.type === "row" || i.type === "inbox") && needsYou(i.row.live) ? [i.id] : [],
  );
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
