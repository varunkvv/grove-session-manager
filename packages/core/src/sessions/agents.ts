import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isObject, mapLimit, readJsonGuarded } from "../fsx.ts";
import { readTail } from "../transcript/reader.ts";
import type { AgentRun, SessionAgent } from "../types.ts";

/** enough of an agent's transcript to say what it is doing. it is also what the summariser reads. */
export const AGENT_TAIL_BYTES = 16_384;
/**
 * no SubagentStop, and nothing written for this long: call it finished. this is a guess - the meta
 * file carries no status and no end time, so a genuinely slow agent looks the same as a dead one.
 */
export const AGENT_IDLE_DONE_MS = 2 * 60_000;

/** `<projectDir>/<sessionId>/subagents`. workflow agents nest one level further, under `workflows/`. */
export function subagentsDir(transcriptPath: string): string {
  return path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath, ".jsonl"),
    "subagents",
  );
}

export interface AgentMeta {
  agentType: string;
  description?: string;
  requestShape?: string;
  spawnDepth?: number;
}

/**
 * `agent-<id>.meta.json`, written once when the agent starts. its existence is what tells a real
 * spawned agent from the internal ones Claude Code runs for /btw and prompt suggestions.
 */
export function parseAgentMeta(value: unknown): AgentMeta | null {
  if (!isObject(value)) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const meta: AgentMeta = { agentType: str(value.agentType) ?? "agent" };
  const description = str(value.description);
  const requestShape = str(value.requestShape);
  if (description) meta.description = description;
  if (requestShape) meta.requestShape = requestShape;
  if (typeof value.spawnDepth === "number" && Number.isFinite(value.spawnDepth)) {
    meta.spawnDepth = value.spawnDepth;
  }
  return meta;
}

/** the last tool the agent picked up, from the end of its transcript */
export function lastToolFromTail(text: string): { name: string; at?: number } | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // most of the bytes here are tool results. skip them before paying for a parse.
    if (line.charCodeAt(0) !== 0x7b || !line.includes('"tool_use"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || !isObject(entry.message)) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (let b = content.length - 1; b >= 0; b--) {
      const block: unknown = content[b];
      if (!isObject(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      return { name: block.name, ...(Number.isFinite(at) ? { at } : {}) };
    }
  }
  return null;
}

export interface AgentSnapshot {
  agents: SessionAgent[];
  /** agent id -> the jsonl mtime and size its tail was read at, so an idle file is read once */
  reads: Record<string, string>;
}

export interface AgentScanOptions {
  /** exact start and stop times from the SubagentStart / SubagentStop hooks, by agent id */
  runs?: Readonly<Record<string, AgentRun>>;
  /** false when the parent session is not live: nothing of its can still be running */
  sessionLive?: boolean;
  now?: number;
  /** the previous scan. an unchanged transcript keeps its last tool, and summaries carry over. */
  prev?: AgentSnapshot;
}

export const EMPTY_AGENT_SNAPSHOT: AgentSnapshot = { agents: [], reads: {} };

function idFromTranscript(name: string): string | null {
  const m = /^agent-([^./]+)\.jsonl$/.exec(name);
  return m?.[1] ?? null;
}

/**
 * every subagent of one session. the meta file is the entry: an agent id without one is one of
 * Claude Code's internal agents, not something the session spawned.
 */
export async function scanSessionAgents(
  transcriptPath: string,
  opts: AgentScanOptions = {},
): Promise<AgentSnapshot> {
  const dir = subagentsDir(transcriptPath);
  let names: string[];
  try {
    names = (await readdir(dir, { recursive: true })).map(String);
  } catch {
    return EMPTY_AGENT_SNAPSHOT;
  }
  const now = opts.now ?? Date.now();
  const sessionLive = opts.sessionLive !== false;
  const previous = new Map((opts.prev?.agents ?? []).map((a) => [a.id, a]));

  const found = names.flatMap((rel) => {
    const id = idFromTranscript(path.basename(rel));
    return id ? [{ id, rel }] : [];
  });
  const scanned = await mapLimit(found, 8, async ({ id, rel }) => {
    const file = path.join(dir, rel);
    const metaFile = path.join(path.dirname(file), `agent-${id}.meta.json`);
    const read = await readJsonGuarded(metaFile);
    if (read.status !== "ok") return null;
    const meta = parseAgentMeta(read.value);
    if (!meta) return null;
    const run = opts.runs?.[id];
    const was = previous.get(id);

    const info = await stat(file).catch(() => null);
    // the meta is written when the agent starts, so its birthtime is the start time when no hook saw it
    const metaInfo = await stat(metaFile).catch(() => null);
    const born = metaInfo?.birthtimeMs || metaInfo?.mtimeMs || now;
    const startedAt = run?.startedAt ?? born;
    // the agent's own file, or the start when it has not written one yet
    const lastActivityAt = info?.mtimeMs ?? startedAt;

    const agent: SessionAgent = {
      id,
      agentType: run?.agentType ?? meta.agentType,
      startedAt,
      lastActivityAt,
      state: "running",
    };
    if (meta.description) agent.description = meta.description;
    if (meta.requestShape) agent.requestShape = meta.requestShape;
    if (meta.spawnDepth !== undefined) agent.spawnDepth = meta.spawnDepth;

    const mark = info ? `${info.mtimeMs}:${info.size}` : "";
    const unchanged = !!mark && opts.prev?.reads[id] === mark;
    if (unchanged && was?.lastTool) {
      agent.lastTool = was.lastTool;
      if (was.lastToolAt !== undefined) agent.lastToolAt = was.lastToolAt;
    } else if (info) {
      const tail = await readTail(file, AGENT_TAIL_BYTES).catch(() => null);
      const tool = tail ? lastToolFromTail(tail.text) : null;
      if (tool) {
        agent.lastTool = tool.name;
        if (tool.at !== undefined) agent.lastToolAt = tool.at;
      }
    }
    // the summariser owns these. a rescan must not throw away what it already paid for.
    if (was?.summary) {
      agent.summary = was.summary;
      if (was.summaryAt !== undefined) agent.summaryAt = was.summaryAt;
    }

    const finished =
      run?.stoppedAt !== undefined || !sessionLive || now - lastActivityAt > AGENT_IDLE_DONE_MS;
    if (finished) agent.state = "done";
    return { agent, mark };
  });

  const agents: SessionAgent[] = [];
  const reads: Record<string, string> = {};
  for (const hit of scanned) {
    if (!hit) continue;
    agents.push(hit.agent);
    if (hit.mark) reads[hit.agent.id] = hit.mark;
  }
  // running first, newest first inside each group: the ones still going are what anyone looks at
  agents.sort(
    (a, b) =>
      Number(b.state === "running") - Number(a.state === "running") || b.startedAt - a.startedAt,
  );
  return { agents, reads };
}
