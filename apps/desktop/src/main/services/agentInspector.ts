import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type AgentSnapshot,
  agentParents,
  fileMark,
  firstSentence,
  loadCachedTimeline,
  mapLimit,
  readAgentTimeline,
  readWorkflowJournal,
  readWorkflowRuns,
  type SessionAgent,
  saveCachedTimeline,
  sweepTimelineCache,
  type TimelineState,
  timelineCacheDir,
  timelineView,
  toolLabel,
  type WorkflowRun,
  workflowResultText,
} from "@grove/core";
import type { AgentStats, SessionInspection, SessionKey } from "../../shared/ipc.ts";
import { log } from "../log.ts";

/** folded timelines kept in memory. the 4MB agent folds to ~270KB, so this stays well under 20MB. */
const MEMORY = 48;

export interface AgentInspectorOptions {
  stateDir: string;
  /** the scan of one session's agents, with the file each one writes to */
  snapshot: (key: SessionKey) => AgentSnapshot | undefined;
}

/**
 * what a session's agents did, read from their own transcripts when someone looks - never for
 * every row. a finished agent's fold is cached in .grove, keyed by its own file's mtime:size: its
 * parent's transcript can sit still while a background agent keeps writing.
 */
export class AgentInspector {
  private readonly opts: AgentInspectorOptions;
  private readonly cacheDir: string;
  /** insertion order is recency: a hit is moved to the end */
  private readonly memory = new Map<string, { mark: string; state: TimelineState }>();
  /** one fold per file at a time */
  private readonly folding = new Map<string, Promise<TimelineState | null>>();
  /** workflow names by session. a run's name never changes once it is known. */
  private readonly runs = new Map<SessionKey, { mark: string; runs: Map<string, WorkflowRun> }>();

  constructor(opts: AgentInspectorOptions) {
    this.opts = opts;
    this.cacheDir = timelineCacheDir(opts.stateDir);
    const sweep = setTimeout(() => void sweepTimelineCache(this.cacheDir), 60_000);
    sweep.unref?.();
  }

  /**
   * one agent's folded transcript: from memory, from the cache, or read - and only what was
   * appended since, when an older fold exists. null when the file is gone.
   */
  timeline(file: string, finished: boolean): Promise<TimelineState | null> {
    const running = this.folding.get(file);
    if (running) return running;
    const job = this.fold(file, finished).finally(() => this.folding.delete(file));
    this.folding.set(file, job);
    return job;
  }

  private async fold(file: string, finished: boolean): Promise<TimelineState | null> {
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    const mark = fileMark(info);
    const held = this.memory.get(file);
    if (held?.mark === mark) {
      this.remember(file, held);
      return held.state;
    }
    let prev = held?.state;
    if (!prev) {
      const cached = await loadCachedTimeline(this.cacheDir, file);
      if (cached?.mark === mark) {
        this.remember(file, cached);
        return cached.state;
      }
      prev = cached?.state;
    }
    const state = await readAgentTimeline(file, prev);
    this.remember(file, { mark, state });
    // a running agent's fold is worth nothing on disk: it is stale by the next write
    if (finished) {
      void saveCachedTimeline(this.cacheDir, file, mark, state).catch((e) =>
        log.warn("agent timeline cache:", e),
      );
    }
    return state;
  }

  private remember(file: string, entry: { mark: string; state: TimelineState }): void {
    this.memory.delete(file);
    this.memory.set(file, entry);
    while (this.memory.size > MEMORY) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  /** every agent of one session, with what its transcript says. the scan alone draws the rest. */
  async inspect(key: SessionKey): Promise<SessionInspection> {
    const snapshot = this.opts.snapshot(key);
    const out: SessionInspection = { key, agents: {}, workflows: {} };
    if (!snapshot || snapshot.agents.length === 0) return out;
    const folded = await mapLimit(snapshot.agents, 4, async (agent) => {
      const file = snapshot.reads[agent.id]?.file;
      const state = file
        ? await this.timeline(file, agent.state === "done").catch((e) => {
            log.warn("agent timeline of", file, e);
            return null;
          })
        : null;
      return { agent, file, state };
    });

    const journals = new Map<string, Map<string, unknown>>();
    for (const { agent, file } of folded) {
      if (!agent.workflow || !file || journals.has(agent.workflow)) continue;
      journals.set(agent.workflow, await readWorkflowJournal(path.dirname(file)));
    }
    const parents = agentParents(
      snapshot.agents,
      new Map(folded.flatMap(({ agent, state }) => (state ? [[agent.id, state.steps]] : []))),
    );
    for (const { agent, file, state } of folded) {
      if (!state) {
        // a meta file with no transcript beside it: deleted, or not written yet
        if (file) out.agents[agent.id] = { id: agent.id, toolCount: 0, tokens: 0, gone: true };
        continue;
      }
      const journal = agent.workflow ? journals.get(agent.workflow)?.get(agent.id) : undefined;
      out.agents[agent.id] = statsOf(agent, state, journal, parents.get(agent.id));
    }
    const wanted = [...new Set(snapshot.agents.flatMap((a) => (a.workflow ? [a.workflow] : [])))];
    if (wanted.length > 0) {
      const runs = await this.workflowRuns(key, wanted);
      for (const run of wanted) {
        const found = runs.get(run);
        out.workflows[run] = {
          ...(found?.name ? { name: found.name } : {}),
          ...(found?.summary ? { summary: found.summary } : {}),
        };
      }
    }
    return out;
  }

  /**
   * the names come from the session's own transcript, which can be 100MB. it is read again only
   * when a run is still unnamed and the transcript has moved since the last look.
   */
  private async workflowRuns(key: SessionKey, wanted: string[]): Promise<Map<string, WorkflowRun>> {
    const held = this.runs.get(key);
    if (held && wanted.every((run) => held.runs.has(run))) return held.runs;
    const info = await stat(key).catch(() => null);
    const mark = info ? fileMark(info) : "";
    if (held?.mark === mark) return held.runs;
    const runs = await readWorkflowRuns(key).catch(() => new Map<string, WorkflowRun>());
    this.runs.set(key, { mark, runs });
    return runs;
  }
}

function statsOf(
  agent: SessionAgent,
  state: TimelineState,
  journal: unknown,
  parentId: string | undefined,
): AgentStats {
  const view = timelineView(state);
  // a workflow agent with an output schema ends in a tool call. its journal has what it returned.
  const result = (agent.workflow ? workflowResultText(journal) : undefined) ?? view.result;
  const stats: AgentStats = { id: agent.id, toolCount: view.toolCount, tokens: view.tokens };
  if (view.model) stats.model = view.model;
  if (view.startedAt !== undefined) stats.startedAt = view.startedAt;
  if (view.lastAt !== undefined) stats.lastAt = view.lastAt;
  if (result) stats.outcome = firstSentence(result);
  if (view.prompt) stats.asked = firstSentence(view.prompt, 100);
  if (view.error) stats.error = view.error;
  if (view.interrupted) stats.interrupted = true;
  if (parentId) stats.parentId = parentId;
  for (let i = view.steps.length - 1; i >= 0; i--) {
    const step = view.steps[i];
    if (step?.kind !== "tool" || step.server) continue;
    stats.lastStep = `${toolLabel(step.name)} ${step.target}`.trim();
    break;
  }
  return stats;
}
