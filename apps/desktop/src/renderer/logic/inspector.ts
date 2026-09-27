import { formatDuration, formatTokens, modelLabel, type SessionAgent } from "@grove/core/pure";
import type { AgentStats, MainStats, SessionInspection } from "../../shared/ipc.ts";

/**
 * the pane's width range, and what the list keeps beside it. a conversation is read, so the pane
 * starts at half of what the rail leaves - 440-560px was too narrow for prose.
 */
export const PANE_MIN = 480;
export const PANE_MAX = 960;
export const LIST_MIN = 420;

export type PaneLayout = { mode: "side" | "overlay"; width: number };

/** the widest the pane can be beside a list that keeps its minimum */
export function paneWidth(available: number, wanted?: number): number {
  const most = Math.min(PANE_MAX, available - LIST_MIN);
  const want = wanted ?? Math.round(available / 2);
  return Math.round(Math.max(PANE_MIN, Math.min(most, want)));
}

/**
 * beside the list when the window has room for both, over it from the right when it does not -
 * crushing the list to fit would make both unreadable. `available` is what the rail leaves, and
 * `wanted` the width someone dragged it to.
 */
export function paneLayout(available: number, wanted?: number): PaneLayout {
  if (available - PANE_MIN >= LIST_MIN)
    return { mode: "side", width: paneWidth(available, wanted) };
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
  /**
   * the session's own conversation, on top: each turn's work clipped to the agents' window, so
   * main working, then waiting while its agents fan out, shows in one picture
   */
  main?: { segments: Array<{ left: number; width: number }>; running: boolean };
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
  /** the session is in the middle of a turn: its last span goes on to now */
  mainRunning = false,
): FanOut {
  const picture = agentsFanOut(agents, inspection, now);
  const spans = inspection?.main?.spans;
  if (!spans?.length || picture.bars.length === 0) return picture;
  const span = Math.max(1000, picture.end - picture.start);
  const segments = spans.flatMap(([s, e], i) => {
    const end = mainRunning && i === spans.length - 1 ? now : e;
    // the axis stays the agents' own window: what main did outside it is not drawn
    const a = Math.max(s, picture.start);
    const b = Math.min(end, picture.end);
    return b > a ? [{ left: (a - picture.start) / span, width: (b - a) / span }] : [];
  });
  return { ...picture, main: { segments, running: mainRunning } };
}

function agentsFanOut(
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

/** the session's own conversation, as a row of its agents. no agent id can look like this. */
export const MAIN_ID = "@main";

/**
 * one row of the agents tree. `depth` counts from the session's own conversation, the root at 0:
 * what it sent out is 1, an agent's own agents 2. a workflow's name sits in the tree like a day
 * header, at the depth of the agents under it.
 */
export type AgentListItem =
  | { type: "main"; id: typeof MAIN_ID }
  | { type: "workflow"; id: string; label: string; depth: number }
  | { type: "agent"; id: string; agent: SessionAgent; depth: number };

/**
 * the agents as a tree under the conversation that sent them out, in the order they started, so
 * the list reads like the picture above it: first to last. an agent another agent started sits
 * under it, and a workflow's agents sit under one small header, like a day. the root is always
 * there - it is what every other row hangs from, so it does not wait for the numbers.
 */
export function agentList(
  agents: readonly SessionAgent[],
  inspection: SessionInspection | null | undefined,
): AgentListItem[] {
  if (agents.length === 0) return [];
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
  // the session itself first: what sent them all out
  const items: AgentListItem[] = [{ type: "main", id: MAIN_ID }];
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
      // nested, but its parent's transcript said nothing: as deep as Claude Code says it was
      add(a, Math.max(1, a.spawnDepth ?? 1));
      continue;
    }
    // a workflow's agents stay together, where its first one started, even when others interleave
    const run = a.workflow;
    items.push({
      type: "workflow",
      id: `wf:${run}`,
      label: inspection?.workflows[run]?.name ?? "Workflow",
      depth: 1,
    });
    for (const w of roots) if (w.workflow === run) add(w, 1);
  }
  return items;
}

export type AgentStatus = "running" | "done" | "failed" | "interrupted";

/**
 * how an agent stands, in words: `Running 8m`, `Done 5m`, `Failed 1m`, `Interrupted 4m`. an error
 * wins over everything, like the bar's tone - an agent that died on one is not running whatever
 * the scan guessed. without its stats (the Agents scope) there is only running or done.
 */
export function agentStatus(
  agent: SessionAgent,
  stats: AgentStats | undefined,
  now: number,
): { status: AgentStatus; word: string; time: string } {
  const time = agentDuration(agent, stats, now);
  if (stats?.error) return { status: "failed", word: "Failed", time };
  if (agent.state === "running") return { status: "running", word: "Running", time };
  if (stats?.interrupted) return { status: "interrupted", word: "Interrupted", time };
  return { status: "done", word: "Done", time };
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

/**
 * an agent's second line in the Agents scope, where its session heads the tree above it: its kind,
 * then what it is doing or what it found - or what it said that the search found. a bare tool
 * name is left out: `Plan · Read` reads like two kinds, and the pane has the step with its target
 */
export function agentSecondLine(agent: SessionAgent, match?: string): string {
  const kind = agent.agentType === "workflow-subagent" ? "workflow" : agent.agentType;
  const said = match ?? (agent.state === "running" ? agent.summary : agent.found);
  return said ? `${kind} · ${said}` : kind;
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
  // the first line says it was interrupted. what it was doing then is the part worth reading -
  // its last words were cut off mid-thought, so they are not the answer
  if (stats?.interrupted) {
    const then = agent.found ?? stats.lastStep ?? agent.lastTool;
    return then ? { text: then, tone: "quiet" } : null;
  }
  // the line a model wrote once someone looked says it better than the result's first sentence
  const done = agent.found ?? stats?.outcome;
  return done ? { text: done, tone: "quiet" } : null;
}

/**
 * `2 running · 3 done · 44m of agent time · 1.2M tokens`, or `5 agents · …` once none runs. done
 * is everything not running, failed and interrupted included: the rows say which.
 */
export function sessionAgentSummary(
  agents: readonly SessionAgent[],
  inspection: SessionInspection | null | undefined,
  now: number,
): string {
  const n = `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;
  if (agents.length === 0) return n;
  const running = agents.filter(
    (a) => agentStatus(a, inspection?.agents[a.id], now).status === "running",
  ).length;
  const count =
    running === 0
      ? n
      : running === agents.length
        ? `${running} running`
        : `${running} running · ${agents.length - running} done`;
  let time = 0;
  let tokens = 0;
  for (const a of agents) {
    const { start, end } = agentSpan(a, inspection?.agents[a.id], now);
    time += end - start;
    tokens += inspection?.agents[a.id]?.tokens ?? 0;
  }
  const parts = [count, `${formatDuration(time)} of agent time`];
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

/** `main · opus 5 · 412 tools` */
export function mainMeta(main: MainStats): string {
  const parts = ["main"];
  if (main.model) parts.push(modelLabel(main.model));
  parts.push(`${main.tools} ${main.tools === 1 ? "tool" : "tools"}`);
  return parts.join(" · ");
}

/** the third line: what it is doing while it runs, the first sentence of its last answer when not */
export function mainLine(main: MainStats, running: boolean): string | null {
  return (running ? (main.lastStep ?? main.outcome) : main.outcome) ?? null;
}
