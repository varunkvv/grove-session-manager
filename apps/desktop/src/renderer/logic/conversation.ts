import { formatDuration, modelLabel } from "@grove/core/pure";
import type {
  ConversationDivider,
  ConversationEntry,
  ConversationTurn,
  ConversationTurns,
  ConversationView,
  DetailStep,
  Mark,
  SessionAction,
  SessionRow,
} from "../../shared/ipc.ts";
import { type StepItem, stepItems } from "./steps.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** `12m`, `5h 12m`, `2d 4h`: how long a session went on, at the grain a person thinks in */
export function spanLabel(ms: number): string {
  if (ms < DAY) return formatDuration(ms);
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/**
 * `chat-features · main · opus 5 · 2d 4h · 412 tools`: where it ran, on what branch, with which
 * model, for how long, how much it did. no context-token number - the row's usage chip already
 * says tokens, and two meanings side by side would be one too many.
 */
export function conversationMeta(
  row: Pick<SessionRow, "comboName" | "cwdBase" | "projectLabel" | "gitBranch" | "usage">,
  head?: Pick<ConversationView, "model" | "tools" | "startedAt" | "lastAt"> | null,
): string {
  const parts: string[] = [row.comboName ?? row.cwdBase ?? row.projectLabel];
  if (row.gitBranch) parts.push(row.gitBranch);
  const model = head?.model ?? row.usage?.[0]?.model;
  if (model) parts.push(modelLabel(model));
  if (head?.startedAt !== undefined && head.lastAt !== undefined) {
    parts.push(spanLabel(head.lastAt - head.startedAt));
  }
  if (head) parts.push(`${head.tools} ${head.tools === 1 ? "tool" : "tools"}`);
  return parts.join(" · ");
}

/**
 * what the pane's open button says: where the first offer goes. a held background session's first
 * offer is Terminal (attach), an interrupted one's is to carry on in the background.
 */
export function openLabel(action: SessionAction | undefined, editorLabel: string): string {
  if (!action) return `Open in ${editorLabel}`;
  switch (action.id) {
    case "combo-land":
    case "folder-land":
      return `Open in ${editorLabel}`;
    case "attach":
    case "terminal":
      return "Open in Terminal";
    default:
      return action.label;
  }
}

/** a push applied to what is on screen: every entry from `from` on replaced, the live work spliced */
export function applyTurns(view: ConversationView, p: ConversationTurns): ConversationView {
  const next: ConversationView = {
    ...view,
    ...p.head,
    items: [...view.items.slice(0, p.from), ...p.items],
  };
  if (p.live) {
    const kept: DetailStep[] =
      view.live?.n === p.live.n ? view.live.steps.filter((s) => s.n < p.live!.from) : [];
    next.live = { n: p.live.n, steps: [...kept, ...p.live.steps] };
  }
  return next;
}

/** one line or block of the conversation as the pane lists it */
export type ConversationLine =
  | { type: "day"; id: string; label: string }
  | { type: "prompt"; id: string; turn: ConversationTurn }
  | { type: "work"; id: string; turn: ConversationTurn; open: boolean; live: boolean }
  | { type: "loading"; id: string; turn: ConversationTurn }
  | (StepItem & { turn: ConversationTurn })
  | { type: "mark"; id: string; turn: ConversationTurn; mark: Mark }
  | { type: "answer"; id: string; turn: ConversationTurn }
  | { type: "output"; id: string; turn: ConversationTurn }
  | { type: "status"; id: string; turn: ConversationTurn; tone: "quiet" | "error"; text: string }
  | { type: "compact"; id: string; divider: ConversationDivider };

/** where a turn's lines go in the list: every id starts with the turn's own number */
export const stepPrefix = (n: number) => `${n}:`;

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today", "Yesterday", "Tue 23 Sep": the day a turn started, in the list's own words */
export function dayLabel(ms: number, now: number): string {
  if (dayKey(ms) === dayKey(now)) return "Today";
  if (dayKey(ms) === dayKey(now - 24 * HOUR)) return "Yesterday";
  const d = new Date(ms);
  const year = new Date(now).getFullYear() === d.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** `12m · 48 steps · 6 files edited · 2 agents`: a turn's work, in one line */
export function workLine(turn: ConversationTurn, now: number, live: boolean): string {
  const parts: string[] = [];
  const ms = live && turn.startedAt !== undefined ? now - turn.startedAt : turn.durationMs;
  if (ms !== undefined) parts.push(formatDuration(ms));
  parts.push(`${turn.tools} ${turn.tools === 1 ? "step" : "steps"}`);
  if (turn.filesEdited) {
    parts.push(`${turn.filesEdited} ${turn.filesEdited === 1 ? "file" : "files"} edited`);
  }
  if (turn.agents) parts.push(`${turn.agents} ${turn.agents === 1 ? "agent" : "agents"}`);
  return parts.join(" · ");
}

/** where a mark sits among a turn's lines: a plan or question right after its call, words before the next step */
function markKey(m: Mark): number {
  return m.kind === "said" ? m.step - 0.5 : m.step + 0.5;
}

function firstStepOf(item: StepItem): number {
  return item.type === "run" ? (item.steps[0]?.n ?? 0) : item.step.n;
}

/** the last line of a turn: how it ended, when that was not with an answer */
function statusOf(turn: ConversationTurn): ConversationLine | null {
  const id = `s:${turn.n}`;
  if (turn.error) return { type: "status", id, turn, tone: "error", text: turn.error };
  if (turn.interrupted) return { type: "status", id, turn, tone: "quiet", text: "Interrupted" };
  if (turn.apiError && !turn.answer) {
    return { type: "status", id, turn, tone: "quiet", text: turn.apiError };
  }
  return null;
}

export interface LinesOptions {
  /** turns whose work is open */
  open: ReadonlySet<number>;
  /** the live turn's work is open unless someone closed it */
  closedLive: boolean;
  /** each opened turn's steps, once they came */
  steps: ReadonlyMap<number, readonly DetailStep[]>;
  /** the turn still being written, while the session runs */
  live: number | null;
  thinking: boolean;
  openRuns: ReadonlySet<string>;
  now: number;
}

/**
 * the conversation top to bottom: a day header where the day changes, then per turn the prompt,
 * one line for its work (opened: every step, with what was said and asked in between), and the
 * answer. a plan, a question, what the person said, an interrupt and a final error are always in
 * sight - they are the conversation, not the work.
 */
export function conversationLines(view: ConversationView, o: LinesOptions): ConversationLine[] {
  const lines: ConversationLine[] = [];
  const startOf = (e: ConversationEntry) =>
    e.kind === "compact" ? e.at : (e.prompt?.at ?? e.startedAt ?? 0);
  const days = new Set(view.items.map((e) => dayKey(startOf(e))));
  let day = "";
  for (const entry of view.items) {
    const when = startOf(entry);
    if (days.size > 1 && when && dayKey(when) !== day) {
      day = dayKey(when);
      lines.push({ type: "day", id: `d:${entry.n}`, label: dayLabel(when, o.now) });
    }
    if (entry.kind === "compact") {
      lines.push({ type: "compact", id: `c:${entry.n}`, divider: entry });
      continue;
    }
    const turn = entry;
    const n = turn.n;
    const live = o.live === n;
    if (turn.prompt) lines.push({ type: "prompt", id: `q:${n}`, turn });
    const marks = turn.marks.map((mark, i) => ({
      type: "mark" as const,
      id: `k:${n}:${i}`,
      turn,
      mark,
    }));
    if (turn.tools > 0 || live) {
      const open = live ? !o.closedLive : o.open.has(n);
      lines.push({ type: "work", id: `w:${n}`, turn, open, live });
      if (open) {
        const steps = o.steps.get(n);
        if (!steps) lines.push({ type: "loading", id: `l:${n}`, turn });
        else {
          const items = stepItems(steps, {
            thinking: o.thinking,
            openRuns: o.openRuns,
            running: live,
            prefix: stepPrefix(n),
          });
          const pending = [...marks].sort((a, b) => markKey(a.mark) - markKey(b.mark));
          for (const item of items) {
            while (pending[0] && markKey(pending[0].mark) < firstStepOf(item)) {
              lines.push(pending.shift() as ConversationLine);
            }
            lines.push({ ...item, turn });
          }
          lines.push(...pending);
        }
      } else lines.push(...marks);
    } else lines.push(...marks);
    if (turn.answer) lines.push({ type: "answer", id: `a:${n}`, turn });
    if (turn.output !== undefined) lines.push({ type: "output", id: `o:${n}`, turn });
    const status = statusOf(turn);
    if (status) lines.push(status);
  }
  return lines;
}

/** the turn a line belongs to, by its id */
export function turnOfLine(line: ConversationLine): number | null {
  if (line.type === "day" || line.type === "compact") return null;
  return line.turn.n;
}

/** the lines the keyboard stops on: prompts, work lines, and the steps of an open work */
export function isStop(line: ConversationLine): boolean {
  return (
    line.type === "prompt" || line.type === "work" || line.type === "tool" || line.type === "run"
  );
}
