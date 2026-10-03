// what a card and its agent look like right now: the record's state joined with live session facts.
// pure: the renderer imports this through @grove/core/pure.
import type { Card } from "@grove/record/types";
import { needsYou } from "../sessions/needsYou.ts";
import type { LiveStatus } from "../types.ts";
import type { ProjectId } from "./ids.ts";

/** where a session's process is right now */
export type Runtime = "vscode" | "terminal" | "background" | "elsewhere" | "closed";

/** what the pure functions need about one session id. main builds it from SessionRow + LiveService */
export interface SessionFacts {
  sessionId: string;
  title?: string;
  /** the project its first cwd is in */
  project?: ProjectId;
  live?: LiveStatus;
  interrupted?: { why: "gone" | "failed"; at?: number };
  runtime: Runtime;
  lastPrompt?: string;
}

export interface AgentRef {
  sessionId: string;
  /** the session's title, else the record's `agent` field, else the first 8 characters of the id */
  name: string;
  /** a subagent's name: the `as` it passed */
  sub?: string;
}

/** a person-authored record has no AgentRef */
export function agentRef(
  sessionId: string,
  facts?: SessionFacts,
  recordAgent?: string,
  sub?: string,
): AgentRef {
  const ref: AgentRef = { sessionId, name: facts?.title || recordAgent || sessionId.slice(0, 8) };
  if (sub) ref.sub = sub;
  return ref;
}

/**
 * `holder` is LiveService's registry entry. it can name a process that is gone (the list is only
 * replaced on a non-empty read), so `alive` decides.
 */
export function runtimeOf(i: {
  held?: boolean;
  holder?: { kind?: string; entrypoint?: string };
  alive: boolean;
}): Runtime {
  if (i.held || i.holder?.kind === "bg") return "background";
  if (!i.holder || !i.alive) return "closed";
  if (i.holder.entrypoint === "claude-vscode") return "vscode";
  if (i.holder.entrypoint === "cli") return "terminal";
  // claude -p and SDK processes (sdk-cli), or no entrypoint at all
  return "elsewhere";
}

export type CardDisplayStatus =
  | "waiting"
  | "stopped"
  | "in_progress"
  | "todo"
  | "done"
  | "canceled";

/**
 * a holder whose process went away between turns is not stopped: it stays in progress (a VS Code
 * tab's process goes with its window). only one interrupted mid-turn is. a todo card with an open
 * question to the person is waiting too.
 */
export function cardDisplayStatus(
  card: Pick<Card, "status" | "asksPerson">,
  holder?: SessionFacts,
): CardDisplayStatus {
  if (card.status === "done" || card.status === "canceled") return card.status;
  if (card.status === "in_progress" && holder?.interrupted) return "stopped";
  if (card.asksPerson || needsYou(holder?.live)) return "waiting";
  return card.status;
}

export type AgentState =
  | "working"
  | "permission"
  | "waiting"
  | "failed"
  | "stopped"
  | "idle"
  | "closed";

export function agentState(facts: SessionFacts): AgentState {
  if (facts.interrupted) return "stopped";
  if (facts.live) return facts.live.state === "running" ? "working" : facts.live.state;
  return facts.runtime === "closed" ? "closed" : "idle";
}
