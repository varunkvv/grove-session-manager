// what the screens compute from main's views. pure: every fact here was derived in main, this is
// only filtering, order and words.
import {
  type AgentState,
  type CardDisplayStatus,
  formatRelativeTime,
  tokenize,
} from "@grove/core/pure";
import type { ConclusionKind, Source } from "@grove/record/types";
import type {
  ArtifactView,
  CardHead,
  CardView,
  ConclusionView,
  InboxRowView,
  InboxView,
  ProjectId,
  ProjectView,
  RecordProblem,
} from "../../shared/ipc.ts";
import { webLink } from "./refs.ts";
import { type WhoView, whoView } from "./who.ts";

// ---------- inbox ----------

/** one project's rows, in main's order. never re-sorted */
export function projectRows(inbox: InboxView, project: ProjectId | null): InboxRowView[] {
  return inbox.rows.filter((r) => r.project === project);
}

/** how many inbox rows name this card: the count on its Cards row */
export function pendingFor(inbox: InboxView, project: ProjectId, cardId: string): number {
  return inbox.rows.filter((r) => r.project === project && r.card?.id === cardId).length;
}

/** a project's Asked and Stopped rows: what the switcher counts */
export function needsYouCount(inbox: InboxView, project: ProjectId): number {
  return inbox.rows.filter(
    (r) => r.project === project && (r.kind === "asked" || r.kind === "stopped"),
  ).length;
}

/** case and accents do not count: `cafe` finds Café */
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** the switcher's search: every word typed is somewhere in the name, in the list's own order */
export function matchProjects<T extends { name: string }>(
  projects: readonly T[],
  query: string,
): T[] {
  const words = tokenize(fold(query));
  return projects.filter((p) => {
    const name = fold(p.name);
    return words.every((w) => name.includes(w));
  });
}

// ---------- cards ----------

export type GroupKey = "waiting" | "in_progress" | "todo" | "done" | "canceled";

export interface CardGroup {
  /** also the status its header icon draws */
  key: GroupKey;
  label: string;
  cards: CardHead[];
}

const GROUPS: Record<GroupKey, string> = {
  waiting: "Waiting on you",
  in_progress: "In progress",
  todo: "Todo",
  done: "Done",
  canceled: "Canceled",
};

const GROUP_OF: Record<CardDisplayStatus, GroupKey> = {
  waiting: "waiting",
  stopped: "waiting",
  in_progress: "in_progress",
  todo: "todo",
  done: "done",
  canceled: "canceled",
};

const cardNumber = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1));

/** the five groups in order, empty ones left out. the backlog in the order it was written, the rest newest first */
export function groupCards(cards: readonly CardHead[]): CardGroup[] {
  return (Object.keys(GROUPS) as GroupKey[])
    .map((key) => ({
      key,
      label: GROUPS[key],
      cards: cards
        .filter((c) => GROUP_OF[c.status] === key)
        .sort(
          key === "todo"
            ? (a, b) => cardNumber(a.id) - cardNumber(b.id)
            : (a, b) => b.lastActivity - a.lastActivity,
        ),
    }))
    .filter((g) => g.cards.length > 0);
}

/** the ids in the order the Cards screen draws them, for the keyboard */
export function cardOrder(cards: readonly CardHead[]): string[] {
  return groupCards(cards).flatMap((g) => g.cards.map((c) => c.id));
}

/** `{done} of {total} done`. a canceled card is not part of the total */
export function doneOf(cards: readonly CardHead[]): { done: number; total: number } {
  return {
    done: cards.filter((c) => c.status === "done").length,
    total: cards.filter((c) => c.status !== "canceled").length,
  };
}

/** the record's reader says `(no title)` when card.md has none */
export function cardTitle(c: { id: string; title: string }): string {
  return !c.title || c.title === "(no title)" ? c.id : c.title;
}

export type CardRole = "held" | "open" | "closed-with-agent" | "closed";

/** on the record's own status and whether the agent still holds it, never on the display status */
export function cardRole(card: Pick<CardView, "recordStatus" | "agent">): CardRole {
  if (card.agent?.holding) return "held";
  if (card.recordStatus === "done" || card.recordStatus === "canceled")
    return card.agent ? "closed-with-agent" : "closed";
  return "open";
}

export interface StartBlock {
  case: "root" | "server" | "goal";
  /** the start state's second line, and the side panel's in place of its start button */
  line: string;
}

/** why a start would fail, first that applies. a card start needs no goal */
export function startBlocked(
  project: Pick<ProjectView, "root" | "rootExists" | "server" | "goal">,
  goalStart: boolean,
): StartBlock | null {
  if (!project.rootExists)
    return { case: "root", line: `The project folder is missing: ${project.root}` };
  if (project.server.state === "failed")
    return {
      case: "server",
      line: "Agents cannot reach this project's record, so a new one could not work. Edit project says why.",
    };
  if (goalStart && !project.goal)
    return { case: "goal", line: "Add a goal so agents know what to work toward." };
  return null;
}

export type CardPrimary = { action: "start" } | { action: "open"; disabled?: string };

/** the card header's one button. the screen gives it its words and what it runs */
export function cardPrimary(
  card: Pick<CardView, "recordStatus" | "agent">,
  blocked: StartBlock | null,
): CardPrimary | null {
  const role = cardRole(card);
  if (role === "open") return blocked ? null : { action: "start" };
  if (role === "closed" || !card.agent) return null;
  if (!card.agent.sessionKey)
    return { action: "open", disabled: "Grove has not found this agent's session yet." };
  return card.agent.open.disabled
    ? { action: "open", disabled: card.agent.open.disabled }
    : { action: "open" };
}

// ---------- the card's thread ----------

export interface ProblemProps {
  problems?: string[];
  file?: string;
  count?: number;
}

/** a record file's problems, for ProblemMark. `file` is relative to the project root */
export function problemsFor(problems: readonly RecordProblem[], file: string): ProblemProps {
  const p = problems.find((x) => x.file === file);
  return p ? { problems: p.problems, file } : {};
}

export interface DrawnItem {
  key: string;
  /** comment, question, answer, the event's word (takeover, done, cancel), or the conclusion's kind */
  kind: string;
  at: number;
  who: WhoView;
  word?: string;
  /** a question to another card */
  toCard?: string;
  /** markdown, untrusted */
  body?: string;
  waitingOnYou: boolean;
  problems: ProblemProps;
  artifacts: ArtifactView[];
}

const SOMEONE: WhoView = { kind: "agent", id: "", name: "an agent" };

/** claim and release are not drawn: the side panel says who holds the card */
const EVENT_WORD = new Map<string, string | null>([
  ["claim", null],
  ["release", null],
  ["takeover", "took this over"],
  ["done", "finished"],
  ["cancel", "canceled this"],
]);

const CONCLUDED: Record<ConclusionKind, string> = {
  decision: "decided",
  finding: "found",
  verdict: "concluded",
};

const pad4 = (n: number) => String(n).padStart(4, "0");

/** the thread and the card's conclusions, merged by `at`, oldest first */
export function threadItems(
  card: Pick<CardView, "id" | "thread" | "conclusions" | "problems">,
): DrawnItem[] {
  const dir = `cards/${card.id}`;
  const items: DrawnItem[] = [];
  for (const t of card.thread) {
    const who = whoView(t.who) ?? SOMEONE;
    if (t.kind === "event") {
      const word = EVENT_WORD.has(t.event) ? EVENT_WORD.get(t.event) : t.event;
      if (!word) continue;
      items.push({
        key: `claim:${t.seq}`,
        kind: t.event,
        at: t.at,
        who,
        word,
        body: t.event === "takeover" ? undefined : t.text || undefined,
        waitingOnYou: false,
        problems: problemsFor(card.problems, `${dir}/claims/${pad4(t.seq)}.md`),
        artifacts: [],
      });
      continue;
    }
    const toPerson = t.kind === "question" && t.to === "person";
    items.push({
      key: `comment:${t.seq}`,
      kind: t.kind,
      at: t.at,
      who,
      word:
        t.kind === "answer"
          ? "replied"
          : toPerson
            ? "asked you"
            : t.kind === "question"
              ? "asked"
              : t.artifacts.length > 0
                ? "attached"
                : undefined,
      toCard: t.kind === "question" && !toPerson ? t.to : undefined,
      body: t.text,
      waitingOnYou: toPerson && !!t.open,
      problems: problemsFor(card.problems, `${dir}/comments/${pad4(t.seq)}.md`),
      artifacts: t.artifacts,
    });
  }
  for (const c of card.conclusions) {
    items.push({
      key: c.id,
      kind: c.kind,
      at: c.at,
      who: whoView(c.by === "person" ? "person" : c.who) ?? SOMEONE,
      word: CONCLUDED[c.kind],
      // the id at the end renders as a chip
      body: `${c.what} ${c.id}`,
      waitingOnYou: false,
      problems: c.problems ? { count: c.problems } : {},
      artifacts: [],
    });
  }
  // stable: at the same time the thread comes before a conclusion
  return items.sort((a, b) => a.at - b.at);
}

const STATE_LINE: Record<AgentState, readonly [string, string] | null> = {
  working: ["working", "text-fg-3"],
  permission: ["waiting on you", "text-waiting"],
  waiting: ["waiting on you", "text-waiting"],
  failed: ["stopped on an API error", "text-danger"],
  stopped: ["stopped mid-turn", "text-danger"],
  idle: ["idle", "text-fg-3"],
  // the Closed chip says it
  closed: null,
};

/** the side panel's line under the agent: `waiting on you 3m ago` */
export function stateLine(
  agent: { state: AgentState; stateAt?: number },
  now: number,
): { text: string; tone: string } | null {
  const line = STATE_LINE[agent.state];
  if (!line) return null;
  const [text, tone] = line;
  return {
    text: agent.stateAt === undefined ? text : `${text} ${formatRelativeTime(agent.stateAt, now)}`,
    tone,
  };
}

export function linkWord(link: "needs" | "from"): string {
  return link === "needs" ? "needs" : "created from";
}

/** `owner/repo#12`, or the pull request's github url, which is what the record's tools ask for */
const PR = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)(\d+)(?:[/?#].*)?$/;

/** a file's last path part, a branch as written, `PR #12`, a link's host and path */
export function artifactName(a: Pick<ArtifactView, "type" | "ref">): string {
  if (a.type === "file") return a.ref.split("/").filter(Boolean).pop() ?? a.ref;
  if (a.type === "pr") {
    const n = PR.exec(a.ref)?.[3] ?? /#(\d+)$/.exec(a.ref)?.[1];
    return n ? `PR #${n}` : a.ref;
  }
  if (a.type === "link") {
    try {
      const u = new URL(a.ref);
      return `${u.host}${u.pathname}`.replace(/\/$/, "");
    } catch {
      return a.ref;
    }
  }
  return a.ref;
}

/** a conclusion's source as the artifact it opens like: a web link in the browser, a file shown in Finder */
export function sourceArtifact(s: Source, at: number): ArtifactView {
  const web = webLink(s.ref);
  return { type: web ? (prUrl(web) ? "pr" : "link") : "file", ref: s.ref, at };
}

/** its github pull request. a bare `#12` names no repo, and another host's url is only copied */
export function prUrl(ref: string): string | null {
  const m = PR.exec(ref);
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : null;
}

// ---------- conclusions ----------

export type KindFilter = "all" | ConclusionKind;

export interface ConclusionControls {
  query: string;
  kind: KindFilter;
  open: string | null;
}

function haystack(c: ConclusionView): string {
  return [
    c.id,
    c.what,
    c.why,
    c.card?.id,
    c.card?.title,
    // "you" finds the person's
    c.by === "person" ? "you" : undefined,
    c.who?.name,
    c.area,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** every word must be in it. the kind filter applies on top */
export function filterConclusions(
  list: readonly ConclusionView[],
  query: string,
  kind: KindFilter,
): ConclusionView[] {
  const words = tokenize(query);
  return list.filter((c) => {
    if (kind !== "all" && c.kind !== kind) return false;
    if (words.length === 0) return true;
    const hay = haystack(c);
    return words.every((w) => hay.includes(w));
  });
}

const VERB: Record<ConclusionKind, string> = {
  decision: "Decided",
  finding: "Found",
  verdict: "Concluded",
};

/** the open row's first line. `who` is the recording agent, or for the person the agent whose chat it was */
export function decidedLine(c: Pick<ConclusionView, "kind" | "by" | "who">): string {
  const name = c.who?.name ?? "an agent";
  if (c.by === "person") return `${VERB[c.kind]} by you in ${name}'s chat`;
  return c.kind === "finding" ? `Found by ${name}` : `${VERB[c.kind]} by ${name} without asking`;
}

/** opens `id`. the search and the kind reset only when they would hide it */
export function revealConclusion(
  list: readonly ConclusionView[],
  controls: ConclusionControls,
  id: string,
): ConclusionControls {
  const shown = filterConclusions(list, controls.query, controls.kind).some((c) => c.id === id);
  return shown ? { ...controls, open: id } : { query: "", kind: "all", open: id };
}
