// what the screens compute from main's views. pure: every fact here was derived in main, this is
// only filtering, order and words.
import { formatDuration, type InboxKind, type TurnView, tokenize } from "@grove/core/pure";
import type {
  InboxRowView,
  InboxView,
  ProjectId,
  ProjectView,
  SessionHit,
} from "../../shared/ipc.ts";

/** how many of a project's sessions need the person: the count beside it in the sidebar */
export function needsYouCount(inbox: InboxView, project: ProjectId): number {
  return inbox.rows.filter((r) => r.project === project).length;
}

/** 32-bit FNV-1a over the UTF-16 code units */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const hues = new WeakMap<object, Map<ProjectId, number>>();

/**
 * each project's own colour, 1 to 9. a project asks for the one its id hashes to, which a rename
 * does not change, and in the sidebar's order takes the next free one when an earlier project has
 * it: hashed alone, three of seven land on one colour. past nine projects they are shared
 */
export function projectHues(projects: readonly { id: ProjectId }[]): Map<ProjectId, number> {
  const had = hues.get(projects);
  if (had) return had;
  const out = new Map<ProjectId, number>();
  const taken = new Set<number>();
  for (const p of projects) {
    let hue = fnv1a(p.id) % 9;
    while (taken.has(hue)) hue = (hue + 1) % 9;
    out.set(p.id, hue + 1);
    taken.add(hue);
    // all nine are out: the next nine start over
    if (taken.size === 9) taken.clear();
  }
  hues.set(projects, out);
  return out;
}

/** what a row says a session is at: the inbox's four, or working. a quiet one says nothing */
export type SessionState = InboxKind | "working";

export interface SessionItem {
  hit: SessionHit;
  state?: SessionState;
  /** its inbox row, when it needs the person: what Dismiss clears */
  row?: InboxRowView;
  /** a search found it by what was said in it, not by its title: the words around what matched */
  snippet?: string;
}

export interface SessionGroup {
  key: "needs" | "working" | "today" | "yesterday" | "day-2" | "day-3" | "older";
  label: string;
  /** the rows that are drawn */
  items: SessionItem[];
  /** how many it holds. more than are drawn only in Older */
  count: number;
  /** Older alone: its rows show. the others have no way to close */
  open?: boolean;
}

/** how many rows Older draws when it opens, and how many more each time its end comes near */
export const PAGE = 50;

/** Older as a screen starts with it: closed */
export const CLOSED: OlderView = { open: false, drawn: PAGE };

export interface OlderView {
  open: boolean;
  drawn: number;
}

/** everything a sessions list is drawn from. the screen and the keyboard are given the same one */
export interface ListInput {
  /** a project's list, or with null every project's */
  scope: ProjectId | null;
  /** newest first. null until main has answered for this scope */
  hits: readonly SessionHit[] | null;
  inbox: InboxView;
  /** what is typed in the top bar's field */
  query: string;
  /** what main found for `query`, in what was said too. undefined until it has answered */
  found?: readonly SessionHit[];
  now: number;
  older: OlderView;
  /** the session in the panel. its row is drawn wherever it is, or the panel would be on nothing */
  peek: string | null;
}

/**
 * the search, as far as the page can answer it at once: every word typed is in the title, a prompt
 * or the branch, and on the home screen (`home`) the project's name. what was said is main's
 */
export function filterSessions(
  hits: readonly SessionHit[],
  query: string,
  home = false,
): SessionHit[] {
  const words = tokenize(query);
  if (words.length === 0) return [...hits];
  return hits.filter((h) => {
    const hay =
      `${h.title}\n${h.prompt ?? ""}\n${h.branch ?? ""}\n${home ? h.where : ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * a list of sessions as its screen draws it: the ones that need the person in the inbox's order,
 * the ones working, then the rest by the day they last moved: today, yesterday, the two days
 * before by their weekday, and Older. `hits` is newest first, and each group keeps that. empty
 * groups are left out.
 *
 * Older is closed until its header is pressed, and then draws a page at a time. while something
 * is typed it is open whatever its header was left at: a search hides nothing without saying so
 */
export function groupSessions(i: ListInput): SessionGroup[] {
  const mine = i.inbox.rows.filter((r) => i.scope === null || r.project === i.scope);
  const rows = new Map(mine.map((r, n) => [r.sessionId, [r, n] as const]));
  // a session that needs him is listed from its inbox row until main has said what else there is
  const had = new Set(i.hits?.map((h) => h.sessionId));
  const all = [
    ...(i.hits ?? []),
    ...mine
      .filter((r) => !had.has(r.sessionId))
      .map((r): SessionHit => ({ ...r, activityMs: r.at })),
  ];
  // midnight today and the three before it, by the calendar: a day is not 24 hours twice a year
  const cuts = [0, 1, 2, 3].map((back) => {
    const d = new Date(i.now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    return d.getTime();
  });
  const weekday = (at: number | undefined) =>
    new Date(at ?? 0).toLocaleDateString("en-US", { weekday: "long" });
  const labels: Record<SessionGroup["key"], string> = {
    needs: "Needs you",
    working: "Working",
    today: "Today",
    yesterday: "Yesterday",
    "day-2": weekday(cuts[2]),
    "day-3": weekday(cuts[3]),
    older: "Older",
  };
  const keys = Object.keys(labels) as SessionGroup["key"][];
  const days = keys.slice(2);
  const groups = Object.fromEntries(keys.map((key) => [key, [] as SessionItem[]])) as Record<
    SessionGroup["key"],
    SessionItem[]
  >;
  const typed = tokenize(i.query).length > 0;
  // main's answer is joined in by session id: the rows it found that the page's own filter did
  // not, and for each one found by what was said in it, the words around the match
  const found = new Map(typed ? i.found?.map((h) => [h.sessionId, h.snippet]) : []);
  const local = new Set(filterSessions(all, i.query, i.scope === null));
  for (const hit of all) {
    if (!local.has(hit) && !found.has(hit.sessionId)) continue;
    const snippet = found.get(hit.sessionId);
    const row = rows.get(hit.sessionId)?.[0];
    if (row) groups.needs.push({ hit, state: row.kind, row, snippet });
    else if (hit.live === "running") groups.working.push({ hit, state: "working", snippet });
    else {
      // older than three days: it last moved before the start of the day three days ago
      const back = cuts.findIndex((cut) => hit.activityMs >= cut);
      groups[days[back < 0 ? 4 : back] ?? "older"].push({ hit, snippet });
    }
  }
  groups.needs.sort(
    (a, b) => (rows.get(a.hit.sessionId)?.[1] ?? 0) - (rows.get(b.hit.sessionId)?.[1] ?? 0),
  );
  const at = groups.older.findIndex((x) => x.hit.sessionId === i.peek);
  const open = typed || i.older.open || at >= 0;
  return keys
    .map((key): SessionGroup => {
      const items = groups[key];
      if (key !== "older") return { key, label: labels[key], items, count: items.length };
      const drawn = open ? Math.max(i.older.drawn, at + 1) : 0;
      return { key, label: labels[key], items: items.slice(0, drawn), count: items.length, open };
    })
    .filter((g) => g.count > 0);
}

/**
 * the ids in the order the screen draws them, for the keyboard and the panel's handoff. only the
 * rows that are drawn: Enter and the arrows never land on a row nobody sees
 */
export function sessionOrder(i: ListInput): string[] {
  return groupSessions(i).flatMap((g) => g.items.map((x) => x.hit.sessionId));
}

/** `for 12m`: how long a working session's turn has run, in the room of `12m ago` */
export function runningFor(since: number, now: number): string {
  const min = Math.floor(Math.max(0, now - since) / 60_000);
  return min < 1 ? "now" : `for ${min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`}`;
}

export interface StartBlock {
  case: "root";
  /** why, as a start button's hint */
  line: string;
}

/** why a start would fail. it never offers a start that is known to fail */
export function startBlocked(project: Pick<ProjectView, "root" | "rootExists">): StartBlock | null {
  if (!project.rootExists)
    return { case: "root", line: `The project folder is missing: ${project.root}` };
  return null;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `12 steps · 3 files edited · 4m`: a turn's work in one line. nothing for a turn that only talked */
export function workLine(t: Pick<TurnView, "tools" | "files" | "agents" | "ms">): string {
  if (!t.tools) return "";
  const parts = [count(t.tools, "step")];
  if (t.files) parts.push(`${count(t.files, "file")} edited`);
  if (t.agents) parts.push(count(t.agents, "agent"));
  if (t.ms !== undefined && t.ms >= 1000) parts.push(formatDuration(t.ms));
  return parts.join(" · ");
}
