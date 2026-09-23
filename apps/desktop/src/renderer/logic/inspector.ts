import { formatDuration, formatTokens, modelLabel, type SessionAgent } from "@grove/core/pure";
import type { AgentStats, SessionInspection } from "../../shared/ipc.ts";

/** the pane's width range, and what the list keeps beside it */
export const PANE_MIN = 440;
export const PANE_MAX = 560;
export const LIST_MIN = 420;

export type PaneLayout = { mode: "side" | "overlay"; width: number };

/**
 * beside the list when the window has room for both, over it from the right when it does not -
 * crushing the list to fit would make both unreadable. `available` is what the rail leaves.
 */
export function paneLayout(available: number): PaneLayout {
  const want = Math.round(Math.min(PANE_MAX, Math.max(PANE_MIN, available * 0.42)));
  if (available - want >= LIST_MIN) return { mode: "side", width: want };
  // as narrow as it can be, so the selected row still shows beside it
  return { mode: "overlay", width: Math.max(0, Math.min(PANE_MIN, available - 24)) };
}

export type BarTone = "running" | "done" | "error";

export interface FanBar {
  id: string;
  lane: number;
  /** fractions of the axis */
  left: number;
  width: number;
  tone: BarTone;
}

export interface FanOut {
  bars: FanBar[];
  lanes: number;
  start: number;
  end: number;
  ticks: [string, string, string];
}

/** one lane each up to this many. past it, agents that never overlap share a lane. */
const OWN_LANES = 12;

/**
 * when it ran. the transcript's own first and last timestamps once they are known: the scan's
 * times are file times, and a copied or touched file lies about them.
 */
export function agentSpan(
  agent: SessionAgent,
  stats: AgentStats | undefined,
  now: number,
): { start: number; end: number } {
  const start = stats?.startedAt ?? agent.startedAt;
  const end = agent.state === "running" ? now : (stats?.lastAt ?? agent.lastActivityAt);
  return { start, end: Math.max(start, end) };
}

export function toneOf(agent: SessionAgent, stats: AgentStats | undefined): BarTone {
  if (stats?.error) return "error";
  return agent.state === "running" ? "running" : "done";
}

/**
 * the one picture in the app: one lane per agent, on an axis that spans the agents' own window -
 * first start to last end, or now - rather than the session's life. a session open for two days
 * whose agents ran in a twenty-minute burst must not come out as slivers.
 */
export function fanOut(
  agents: readonly SessionAgent[],
  inspection: SessionInspection | null | undefined,
  now: number,
): FanOut {
  const spans = agents
    .map((a) => ({ a, ...agentSpan(a, inspection?.agents[a.id], now) }))
    .sort((x, y) => x.start - y.start || x.a.id.localeCompare(y.a.id));
  if (spans.length === 0) return { bars: [], lanes: 0, start: now, end: now, ticks: ["", "", ""] };
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  const span = Math.max(1000, end - start);
  const laneEnds: number[] = [];
  const bars = spans.map(({ a, start: s, end: e }, i) => {
    let lane = i;
    if (spans.length > OWN_LANES) {
      // the first lane this one fits in after a small gap, so a long series stays one row of beads
      const gap = span * 0.01;
      lane = laneEnds.findIndex((laneEnd) => laneEnd + gap <= s);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = e;
    }
    return {
      id: a.id,
      lane,
      left: (s - start) / span,
      width: (e - s) / span,
      tone: toneOf(a, inspection?.agents[a.id]),
    };
  });
  const lanes = spans.length > OWN_LANES ? laneEnds.length : spans.length;
  return {
    bars,
    lanes,
    start,
    end,
    ticks: ["0:00", formatDuration(span / 2), formatDuration(span)],
  };
}

/** lane pitch and bar height for this many lanes, never taller than `max` altogether */
export function laneGeometry(lanes: number, max = 96): { pitch: number; bar: number } {
  if (lanes <= 0) return { pitch: 0, bar: 0 };
  const pitch = Math.min(12, max / lanes);
  return { pitch, bar: Math.max(1.5, Math.min(4, pitch - 2)) };
}

export type AgentListItem =
  | { type: "workflow"; id: string; label: string }
  | { type: "agent"; id: string; agent: SessionAgent; depth: number };

/**
 * the agents in the order they started, so the list reads like the picture above it: the story
 * of what the session sent out, first to last. an agent another agent started sits under it, and
 * a workflow's agents sit under one small header, like a day.
 */
export function agentList(
  agents: readonly SessionAgent[],
  inspection: SessionInspection | null | undefined,
): AgentListItem[] {
  const byStart = [...agents].sort(
    (a, b) =>
      (inspection?.agents[a.id]?.startedAt ?? a.startedAt) -
        (inspection?.agents[b.id]?.startedAt ?? b.startedAt) || a.id.localeCompare(b.id),
  );
  const known = new Set(byStart.map((a) => a.id));
  const children = new Map<string, SessionAgent[]>();
  const roots: SessionAgent[] = [];
  for (const a of byStart) {
    const parent = inspection?.agents[a.id]?.parentId;
    if (parent && parent !== a.id && known.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), a]);
    } else roots.push(a);
  }
  const items: AgentListItem[] = [];
  const seen = new Set<string>();
  const add = (a: SessionAgent, depth: number) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    items.push({ type: "agent", id: a.id, agent: a, depth });
    for (const c of children.get(a.id) ?? []) add(c, depth + 1);
  };
  for (const a of roots) {
    if (seen.has(a.id)) continue;
    if (!a.workflow) {
      add(a, Math.max(0, (a.spawnDepth ?? 1) - 1));
      continue;
    }
    // a workflow's agents stay together, where its first one started, even when others interleave
    const run = a.workflow;
    items.push({
      type: "workflow",
      id: `wf:${run}`,
      label: inspection?.workflows[run]?.name ?? "Workflow",
    });
    for (const w of roots) if (w.workflow === run) add(w, 0);
  }
  return items;
}

/** what a row is called: what its parent said it was for, else what it was asked */
export function agentTitle(agent: SessionAgent, stats: AgentStats | undefined): string {
  return agent.description ?? stats?.asked ?? agentName(agent);
}

/** an agent's name from the scan alone: its label, the start of its prompt, or its kind */
export function agentName(agent: SessionAgent): string {
  return (
    agent.description ??
    agent.asked ??
    (agent.agentType === "workflow-subagent" ? "Workflow step" : agent.agentType)
  );
}

/** `Explore · 26 tools · 71k tokens`. a workflow's agents all share one type, so they say their model. */
export function agentMeta(agent: SessionAgent, stats: AgentStats | undefined): string {
  const kind =
    agent.agentType === "workflow-subagent"
      ? stats?.model
        ? modelLabel(stats.model)
        : "workflow"
      : agent.agentType;
  if (!stats) return kind;
  const tools = `${stats.toolCount} ${stats.toolCount === 1 ? "tool" : "tools"}`;
  return stats.tokens > 0
    ? `${kind} · ${tools} · ${formatTokens(stats.tokens)} tokens`
    : `${kind} · ${tools}`;
}

/**
 * the third line: what it is doing while it runs, what it came back with once it is done. the
 * haiku line is the better answer while running - the last tool is what is left when that is off.
 */
export function agentLine(
  agent: SessionAgent,
  stats: AgentStats | undefined,
): { text: string; tone: "quiet" | "error" } | null {
  if (stats?.gone) return { text: "Claude Code deletes transcripts after 30 days", tone: "quiet" };
  if (stats?.error) return { text: stats.error, tone: "error" };
  if (agent.state === "running") {
    const now = agent.summary ?? stats?.lastStep ?? agent.lastTool;
    return now ? { text: now, tone: "quiet" } : null;
  }
  if (stats?.interrupted) return { text: "Interrupted", tone: "quiet" };
  // the line a model wrote once someone looked says it better than the result's first sentence
  const done = agent.found ?? stats?.outcome;
  return done ? { text: done, tone: "quiet" } : null;
}

/** `3 agents · 44m of agent time · 1.2M tokens` */
export function sessionAgentSummary(
  agents: readonly SessionAgent[],
  inspection: SessionInspection | null | undefined,
  now: number,
): string {
  const n = `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;
  if (agents.length === 0) return n;
  let time = 0;
  let tokens = 0;
  for (const a of agents) {
    const { start, end } = agentSpan(a, inspection?.agents[a.id], now);
    time += end - start;
    tokens += inspection?.agents[a.id]?.tokens ?? 0;
  }
  const parts = [n, `${formatDuration(time)} of agent time`];
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  return parts.join(" · ");
}

/** how long it ran, or has been running */
export function agentDuration(
  agent: SessionAgent,
  stats: AgentStats | undefined,
  now: number,
): string {
  const { start, end } = agentSpan(agent, stats, now);
  return formatDuration(end - start);
}

/** a changed list of agents is what makes a fresh look worth asking for */
export function agentsSignature(agents: readonly SessionAgent[] | undefined): string {
  return (agents ?? []).map((a) => `${a.id}:${a.state}:${a.lastActivityAt}`).join("|");
}
