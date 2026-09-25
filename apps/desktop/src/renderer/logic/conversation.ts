import { formatDuration, modelLabel } from "@grove/core/pure";
import type {
  ConversationTurns,
  ConversationView,
  DetailStep,
  SessionAction,
  SessionRow,
} from "../../shared/ipc.ts";

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
