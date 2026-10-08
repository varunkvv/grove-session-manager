// what the screens compute from main's views. pure: every fact here was derived in main, this is
// only filtering, order and words.
import {
  dayBucket,
  formatDuration,
  type InboxKind,
  type TurnView,
  tokenize,
} from "@grove/core/pure";
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
}

export interface SessionGroup {
  key: "needs" | "working" | "today" | "yesterday" | "earlier";
  label: string;
  items: SessionItem[];
}

const GROUPS: Record<SessionGroup["key"], string> = {
  needs: "Needs you",
  working: "Working",
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

/** the sessions filter: every word typed is in the title, a prompt or the branch */
export function filterSessions(hits: readonly SessionHit[], query: string): SessionHit[] {
  const words = tokenize(query);
  if (words.length === 0) return [...hits];
  return hits.filter((h) => {
    const hay = `${h.title}\n${h.prompt ?? ""}\n${h.branch ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * a project's sessions as its screen draws them: the ones that need the person in the inbox's
 * order, the ones working, then the rest by the day they last moved. `hits` is newest first, and
 * each group keeps that. empty groups are left out
 */
export function groupSessions(
  hits: readonly SessionHit[],
  inbox: InboxView,
  query: string,
  now: number,
): SessionGroup[] {
  const rows = new Map(inbox.rows.map((r, i) => [r.sessionId, [r, i] as const]));
  const groups = Object.fromEntries(
    Object.keys(GROUPS).map((key) => [key, [] as SessionItem[]]),
  ) as Record<SessionGroup["key"], SessionItem[]>;
  for (const hit of filterSessions(hits, query)) {
    const row = rows.get(hit.sessionId)?.[0];
    if (row) groups.needs.push({ hit, state: row.kind, row });
    else if (hit.live === "running") groups.working.push({ hit, state: "working" });
    else {
      const day = dayBucket(hit.activityMs, now);
      groups[day === "Today" ? "today" : day === "Yesterday" ? "yesterday" : "earlier"].push({
        hit,
      });
    }
  }
  groups.needs.sort(
    (a, b) => (rows.get(a.hit.sessionId)?.[1] ?? 0) - (rows.get(b.hit.sessionId)?.[1] ?? 0),
  );
  return (Object.keys(GROUPS) as SessionGroup["key"][])
    .map((key) => ({ key, label: GROUPS[key], items: groups[key] }))
    .filter((g) => g.items.length > 0);
}

/** the ids in the order the sessions screen draws them, for the keyboard. the day a row falls in changes no order */
export function sessionOrder(
  hits: readonly SessionHit[],
  inbox: InboxView,
  query: string,
): string[] {
  return groupSessions(hits, inbox, query, 0).flatMap((g) => g.items.map((i) => i.hit.sessionId));
}

export interface StartBlock {
  case: "root" | "goal";
  /** why, as a start button's hint */
  line: string;
}

/** why a start would fail, first that applies. it never offers a start that is known to fail */
export function startBlocked(
  project: Pick<ProjectView, "root" | "rootExists" | "goal">,
): StartBlock | null {
  if (!project.rootExists)
    return { case: "root", line: `The project folder is missing: ${project.root}` };
  if (!project.goal)
    return { case: "goal", line: "Add a goal so agents know what to work toward." };
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
