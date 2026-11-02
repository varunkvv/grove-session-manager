import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isObject, mapLimit, readJsonGuarded } from "../fsx.ts";
import { readTail } from "../transcript/reader.ts";
import { squash } from "../transcript/title.ts";
import type { AgentRun, SessionAgent } from "../types.ts";
import { inputHint } from "./timeline.ts";

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

/**
 * where an agent's own transcript is: under its session's subagents folder, a workflow's one level
 * deeper. null for an id that is not a plain agent id, or one that is not there
 */
export async function findAgentFile(transcriptPath: string, id: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const dir = subagentsDir(transcriptPath);
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  const hit = names.map(String).find((n) => path.basename(n) === `agent-${id}.jsonl`);
  return hit ? path.join(dir, hit) : null;
}

export interface AgentMeta {
  agentType: string;
  description?: string;
  requestShape?: string;
  spawnDepth?: number;
  toolUseId?: string;
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
  const toolUseId = str(value.toolUseId);
  if (description) meta.description = description;
  if (requestShape) meta.requestShape = requestShape;
  if (toolUseId) meta.toolUseId = toolUseId;
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

/**
 * the model and effort an agent's last response ran on, from the end of its transcript. every
 * assistant line of its own carries both (`message.model`, and `effort` beside `message`). what
 * claude writes for its own errors is `<synthetic>`, and is not a model
 */
export function modelFromTail(text: string): { model?: string; effort?: string } | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.charCodeAt(0) !== 0x7b || !line.includes('"assistant"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || entry.type !== "assistant" || !isObject(entry.message)) continue;
    const model = entry.message.model;
    if (typeof model !== "string" || !model || model === "<synthetic>") continue;
    const effort = typeof entry.effort === "string" && entry.effort ? entry.effort : undefined;
    return { model, ...(effort ? { effort } : {}) };
  }
  return null;
}

/**
 * the tail of an agent's transcript as a handful of lines: the tools it called and what it last
 * said. this is what goes to the summariser - raw json would be most of the bytes and none of the
 * meaning, and it is worth reading on its own when no summary comes back.
 */
export function agentDigest(tail: string, maxChars = 2000): string {
  const lines: string[] = [];
  for (const line of tail.split("\n")) {
    if (line.charCodeAt(0) !== 0x7b) continue;
    if (!line.includes('"tool_use"') && !line.includes('"text"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || entry.type !== "assistant" || !isObject(entry.message)) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        const arg = inputHint(block.input);
        lines.push(arg ? `${block.name}: ${arg}` : block.name);
      } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        lines.push(`said: ${squash(block.text, 300)}`);
      }
    }
  }
  // the end is what matters, so an over-long digest loses its oldest lines
  let out = lines.join("\n");
  while (out.length > maxChars && lines.length > 1) {
    lines.shift();
    out = lines.join("\n");
  }
  return out.slice(-maxChars);
}

/** how far into an agent's file its first response is looked for: a prompt and its first results can run past 100KB (a real one: 8 lines, ~60KB before the first reply) */
const MODEL_HEAD_BYTES = 262_144;

/** where the prompt is looked for. a prompt that does not end inside it has no first line to give. */
const PROMPT_HEAD_BYTES = 32_768;

/**
 * the model and effort from the head of an agent's transcript, for one whose tail is all tool
 * results (a single result can be 40KB, so the last 16KB may hold no assistant line). they do not
 * change for an agent, so this is only asked while they are unknown
 */
export async function readAgentModel(
  file: string,
): Promise<{ model?: string; effort?: string } | null> {
  const fh = await open(file, constants.O_RDONLY).catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(MODEL_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MODEL_HEAD_BYTES, 0);
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    return end < 0 ? null : modelFromTail(buf.toString("utf8", 0, end));
  } finally {
    await fh.close();
  }
}

/**
 * the first line of what an agent was asked, from the head of its transcript: the first entry is
 * the prompt. only read for an agent with no label, and never again once it is known.
 */
export async function readAgentAsked(file: string): Promise<string | undefined> {
  let text: string;
  const fh = await open(file, constants.O_RDONLY).catch(() => null);
  if (!fh) return undefined;
  try {
    const buf = Buffer.alloc(PROMPT_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PROMPT_HEAD_BYTES, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (nl < 0) return undefined;
    text = buf.toString("utf8", 0, nl);
  } finally {
    await fh.close();
  }
  let entry: unknown;
  try {
    entry = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(entry) || entry.type !== "user" || !isObject(entry.message)) return undefined;
  const content = entry.message.content;
  const prompt =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((b) => (isObject(b) && typeof b.text === "string" ? b.text : "")).join("\n")
        : "";
  const first = prompt.split("\n").find((l) => l.trim() && !l.trim().startsWith("<"));
  return first ? squash(first.replace(/^#+\s*/, ""), 120) : undefined;
}

export interface AgentRead {
  /** the agent's own transcript. workflow agents nest, so this is not derivable from the id. */
  file: string;
  /** its mtime and size when the tail was last read. an unchanged file is not read again. */
  mark: string;
}

export interface AgentSnapshot {
  agents: SessionAgent[];
  reads: Record<string, AgentRead>;
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
    if (meta.toolUseId) agent.toolUseId = meta.toolUseId;
    // workflows/<run>/agent-<id>.jsonl
    const parts = rel.split(path.sep);
    if (parts.length === 3 && parts[0] === "workflows") agent.workflow = parts[1];

    const mark = info ? `${info.mtimeMs}:${info.size}` : "";
    const unchanged = !!mark && opts.prev?.reads[id]?.mark === mark;
    if (unchanged && (was?.lastTool || was?.model)) {
      if (was.lastTool) agent.lastTool = was.lastTool;
      if (was.lastToolAt !== undefined) agent.lastToolAt = was.lastToolAt;
      if (was.model) agent.model = was.model;
      if (was.effort) agent.effort = was.effort;
    } else if (info) {
      const tail = await readTail(file, AGENT_TAIL_BYTES).catch(() => null);
      const tool = tail ? lastToolFromTail(tail.text) : null;
      if (tool) {
        agent.lastTool = tool.name;
        if (tool.at !== undefined) agent.lastToolAt = tool.at;
      }
      const ran = tail ? modelFromTail(tail.text) : null;
      if (ran?.model) agent.model = ran.model;
      else if (was?.model) agent.model = was.model;
      if (ran?.effort) agent.effort = ran.effort;
      else if (was?.effort) agent.effort = was.effort;
      if (!agent.model) {
        const head = await readAgentModel(file);
        if (head?.model) agent.model = head.model;
        if (head?.effort && !agent.effort) agent.effort = head.effort;
      }
    }
    // nobody labelled it: the start of its prompt stands in. a prompt never changes once written.
    if (!meta.description) {
      const asked = was?.asked ?? (info ? await readAgentAsked(file) : undefined);
      if (asked) agent.asked = asked;
    }
    // the summariser owns these. a rescan must not throw away what it already paid for.
    if (was?.summary) {
      agent.summary = was.summary;
      if (was.summaryAt !== undefined) agent.summaryAt = was.summaryAt;
    }
    if (was?.found) agent.found = was.found;

    const finished =
      run?.stoppedAt !== undefined || !sessionLive || now - lastActivityAt > AGENT_IDLE_DONE_MS;
    if (finished) agent.state = "done";
    return { agent, mark, file };
  });

  const agents: SessionAgent[] = [];
  const reads: Record<string, AgentRead> = {};
  for (const hit of scanned) {
    if (!hit) continue;
    agents.push(hit.agent);
    if (hit.mark) reads[hit.agent.id] = { file: hit.file, mark: hit.mark };
  }
  // running first, newest first inside each group: the ones still going are what anyone looks at
  agents.sort(
    (a, b) =>
      Number(b.state === "running") - Number(a.state === "running") || b.startedAt - a.startedAt,
  );
  return { agents, reads };
}
