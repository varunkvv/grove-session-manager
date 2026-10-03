// the inbox (decision 15): what in one project is waiting for the person to look at.
// pure: built in main, and importable by the renderer through @grove/core/pure.
import type { Card, Conclusion } from "@grove/record/types";
import { needsYou } from "../sessions/needsYou.ts";
import { squash } from "../transcript/title.ts";
import type { LiveStatus } from "../types.ts";
import { type AgentRef, agentRef, type SessionFacts } from "./derive.ts";
import type { ProjectId } from "./ids.ts";

export type InboxKind = "asked" | "decided" | "verdict" | "found" | "new" | "finished" | "stopped";

/** the tray menu and the page's kind label both read these */
export const KIND_WORD: Record<InboxKind, string> = {
  asked: "Asked",
  decided: "Decided",
  verdict: "Verdict",
  found: "Found",
  new: "New card",
  finished: "Finished",
  stopped: "Stopped",
};

export interface InboxInput {
  project: { id: ProjectId; name: string };
  cards: readonly Card[];
  /** superseded already marked (the record's readers do it) */
  conclusions: readonly Conclusion[];
  /** every session in the project, and every session holding one of its cards, by session id */
  sessions: ReadonlyMap<string, SessionFacts>;
  /** this project's marks from reviewed.json, with the `<PREFIX>/` taken off */
  reviewed: ReadonlySet<string>;
}

export interface InboxRow {
  /** stable: `<kind>:<CARD or conclusion id>`, `asked:session:<id>`, `stopped:<id>` */
  id: string;
  project: ProjectId;
  kind: InboxKind;
  /** ms */
  at: number;
  card?: { id: string; title: string };
  conclusionId?: string;
  title: string;
  who?: AgentRef;
  /** the session Open in VS Code goes to */
  sessionId?: string;
  summary: string;
  /** what Reviewed does. `question:` and `seen:` change the input instead of being marked */
  reviewKeys: string[];
}

const urgent = (r: InboxRow) => r.kind === "asked" || r.kind === "stopped";

/**
 * Asked and Stopped first, newest first among them, then every other row newest first. ties by id.
 * main sorts every project's rows together with it, so the tray's first three are the right ones.
 */
export function inboxOrder(a: InboxRow, b: InboxRow): number {
  return (
    Number(urgent(b)) - Number(urgent(a)) || b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function trayCount(rows: readonly InboxRow[]): number {
  return rows.filter(urgent).length;
}

/**
 * markdown an agent wrote, as one line of words. a row draws no markdown, so the heading, bold and
 * code markers would show as typed. a `**` in a glob or a power is not bold, so the markers only go
 * as a pair around words, and a backtick only with its pair on the same line
 */
export function oneLine(text: string, max = Number.POSITIVE_INFINITY): string {
  return squash(
    text
      .replace(/^#+\s+/gm, "")
      .replace(/(?<![\w/*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\w/*])/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1"),
    max,
  );
}

/** what a session that needs the person is at, in the notifications' words */
function sessionAsk(live: LiveStatus): string {
  if (live.state === "permission") {
    const what = [live.detail, live.target].filter(Boolean).join(" ");
    return what ? `Needs permission: ${what}` : "Needs permission";
  }
  if (live.state === "failed") return "Stopped on an API error";
  return live.question || live.detail || "";
}

const ms = (iso: string) => Date.parse(iso);
const cardOf = (c: Card) => ({ id: c.id, title: c.title });

export function buildInbox(i: InboxInput): InboxRow[] {
  const { project, sessions, reviewed } = i;
  const rows: InboxRow[] = [];
  // a row whose every key is marked is not built
  const add = (row: Omit<InboxRow, "project">) => {
    if (!row.reviewKeys.every((k) => reviewed.has(k))) rows.push({ ...row, project: project.id });
  };
  const author = (r: { by: string; session: string; agent: string; sub?: string }) =>
    r.by === "agent" ? agentRef(r.session, sessions.get(r.session), r.agent, r.sub) : undefined;

  // the in-progress card each session holds. with several, the one it took last
  const held = new Map<string, Card>();
  for (const c of i.cards) {
    if (c.status !== "in_progress" || !c.holder) continue;
    const had = held.get(c.holder.session)?.holder;
    if (!had || ms(c.holder.since) > ms(had.since)) held.set(c.holder.session, c);
  }

  for (const c of i.cards) {
    if (c.status === "canceled") continue;

    // asked: open questions to the person, and the holder's own session needing them. one row
    const open = c.questions.filter((q) => q.open && q.to === "person");
    const holder = c.holder ? sessions.get(c.holder.session) : undefined;
    const live =
      holder && held.get(holder.sessionId) === c && needsYou(holder.live) ? holder.live : undefined;
    if (open.length || live) {
      const q = open.at(-1);
      const who =
        (q && author(q)) ??
        (c.holder ? agentRef(c.holder.session, holder, c.holder.agent) : undefined);
      const keys = open.map((x) => `question:${c.id}#${x.seq}`);
      if (live) keys.push(`seen:${c.holder?.session}`);
      add({
        id: `asked:${c.id}`,
        kind: "asked",
        at: Math.max(q ? ms(q.at) : 0, live ? live.at : 0),
        card: cardOf(c),
        title: c.title,
        who,
        sessionId: c.holder?.session ?? who?.sessionId,
        summary: q ? oneLine(q.text, 300) : sessionAsk(live as LiveStatus),
        reviewKeys: keys,
      });
    }

    if (c.status === "done") {
      // the last done event, not the last event: an unknown word after it changes nothing
      const done = c.claims.findLast((e) => e.event === "done");
      if (!done) continue;
      const keys = [`finished:${c.id}#${done.seq}`];
      // a card made and finished before anyone looked is one row, and Reviewed marks both
      if (c.by === "agent" && !reviewed.has(`card:${c.id}`)) keys.push(`card:${c.id}`);
      const who = author(done);
      add({
        id: `finished:${c.id}`,
        kind: "finished",
        at: ms(done.at),
        card: cardOf(c),
        title: c.title,
        who,
        sessionId: who?.sessionId,
        summary: oneLine(done.body, 300),
        reviewKeys: keys,
      });
    } else if (c.by === "agent") {
      const who = author(c);
      add({
        id: `new:${c.id}`,
        kind: "new",
        at: ms(c.at),
        card: cardOf(c),
        title: c.title,
        who,
        sessionId: who?.sessionId,
        summary: oneLine(c.body.trim().split("\n", 1)[0] ?? "", 200),
        reviewKeys: [`card:${c.id}`],
      });
    }
  }

  const cards = new Map(i.cards.map((c) => [c.id, c]));
  for (const c of i.conclusions) {
    if (c.by !== "agent" || c.superseded) continue;
    const kind =
      c.kind === "decision"
        ? "decided"
        : c.kind === "verdict"
          ? "verdict"
          : c.changesPlan
            ? "found"
            : undefined;
    if (!kind) continue;
    const card = c.card ? cards.get(c.card) : undefined;
    const who = author(c);
    const what = oneLine(c.what);
    add({
      id: `${kind}:${c.id}`,
      kind,
      at: ms(c.at),
      ...(card ? { card: cardOf(card) } : {}),
      conclusionId: c.id,
      title: card?.title ?? what,
      who,
      sessionId: who?.sessionId,
      summary: what,
      reviewKeys: [`conclusion:${c.id}`],
    });
  }

  for (const f of sessions.values()) {
    const card = held.get(f.sessionId);
    if (!card && f.project !== project.id) continue;
    const who = agentRef(f.sessionId, f, card?.holder?.agent);

    // asked, for a session that holds no card here. one that does asks on its card above
    if (!card && f.live && needsYou(f.live)) {
      add({
        id: `asked:session:${f.sessionId}`,
        kind: "asked",
        at: f.live.at,
        title: f.title ?? "Claude session",
        who,
        sessionId: f.sessionId,
        summary: sessionAsk(f.live),
        reviewKeys: [`seen:${f.sessionId}`],
      });
    }

    const stop = f.interrupted;
    if (stop) {
      add({
        id: `stopped:${f.sessionId}`,
        kind: "stopped",
        // a failure the supervisor reported comes with no time of grove's own
        at: stop.at ?? f.live?.at ?? 0,
        ...(card ? { card: cardOf(card) } : {}),
        title: card?.title ?? f.title ?? "Claude session",
        who,
        sessionId: f.sessionId,
        summary: f.lastPrompt
          ? `Stopped mid-turn. It was working on: ${squash(f.lastPrompt, 200)}`
          : "Stopped mid-turn.",
        reviewKeys: [`stopped:${f.sessionId}@${stop.at ?? "failed"}`],
      });
    }
  }

  return rows.sort(inboxOrder);
}
