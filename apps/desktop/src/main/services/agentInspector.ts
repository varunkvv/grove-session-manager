import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type AgentSnapshot,
  agentParents,
  answerSteps,
  type ConversationItem,
  fileMark,
  firstSentence,
  loadCachedTimeline,
  mapLimit,
  readAgentTimeline,
  readToolDetail,
  readWorkflowJournal,
  readWorkflowRuns,
  type SessionAgent,
  saveCachedTimeline,
  sweepTimelineCache,
  type TimelineState,
  timelineCacheDir,
  timelineView,
  tokenize,
  toolLabel,
  type WorkflowRun,
  workflowResultText,
} from "@grove/core";
import type {
  AgentDetail,
  AgentStats,
  AgentSteps,
  ConversationTurns,
  ConversationView,
  SessionInspection,
  SessionKey,
  StepDetail,
} from "../../shared/ipc.ts";
import { log } from "../log.ts";
import {
  Conversations,
  conversationHead,
  conversationView,
  entryView,
  findTurn,
  turnSteps,
} from "./conversations.ts";
import { detailSteps } from "./detailSteps.ts";

/** folded timelines kept in memory. the 4MB agent folds to ~270KB, so this stays well under 20MB. */
const MEMORY = 48;
/** how often the agent on screen is looked at. also the cap on pushes: four a second. */
export const TAIL_MS = 250;

export interface AgentInspectorOptions {
  stateDir: string;
  /** the scan of one session's agents, with the file each one writes to */
  snapshot: (key: SessionKey) => AgentSnapshot | undefined;
  /** what the agent on screen wrote since the last push */
  onSteps?: (steps: AgentSteps) => void;
  /** a session's transcript, from the index: never a path the renderer sent */
  transcript?: (key: SessionKey) => string | undefined;
  /** whether a session is in the middle of a turn */
  running?: (key: SessionKey) => boolean;
  /** what the conversation on screen wrote since the last push */
  onTurns?: (turns: ConversationTurns) => void;
  tailMs?: number;
}

interface Watched {
  key: SessionKey;
  file: string;
  gen: number;
  mark: string;
  timer: NodeJS.Timeout;
  busy: boolean;
}

interface AgentFollow extends Watched {
  kind: "agent";
  id: string;
  /** the steps array last sent. unchanged steps are the same objects in the next fold. */
  sent: TimelineState["steps"];
  /** fold indexes the view left out as the result when it was sent */
  drop: readonly number[];
}

interface ConversationFollow extends Watched {
  kind: "conversation";
  /** the items last sent. an unchanged turn is the same object in the next fold. */
  sent: readonly ConversationItem[];
  /** the newest turn as it was sent: its steps, and the ones it drew as its answer */
  live: { n: number; steps: TimelineState["steps"]; answer: readonly number[] } | null;
}

/** the one thing on screen: an agent, or a session's own conversation. one pane, one of these. */
type Follow = AgentFollow | ConversationFollow;

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
  /** the one thing on screen. there is one pane, so there is one of these. */
  private following: Follow | null = null;
  private gen = 0;
  readonly conversations: Conversations;

  constructor(opts: AgentInspectorOptions) {
    this.opts = opts;
    this.conversations = new Conversations({ stateDir: opts.stateDir });
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
   * one agent of one session, and the file it writes to. the file always comes from the scan:
   * nothing the renderer sends is ever used as a path.
   */
  private find(key: SessionKey, agentId: string) {
    if (typeof key !== "string" || typeof agentId !== "string") return null;
    const snapshot = this.opts.snapshot(key);
    const agent = snapshot?.agents.find((a) => a.id === agentId);
    const file = snapshot?.reads[agentId]?.file;
    return snapshot && agent && file ? { snapshot, agent, file } : null;
  }

  /** the transcript an agent writes to, for Reveal in Finder */
  agentFile(key: SessionKey, agentId: string): string | null {
    return this.find(key, agentId)?.file ?? null;
  }

  /**
   * one agent, step by step, as the detail view draws it: every line of the timeline without the
   * previews and offsets a step carries in main. the 4MB agent comes to ~50KB this way.
   */
  async detail(key: SessionKey, agentId: string): Promise<AgentDetail | null> {
    const found = this.find(key, agentId);
    if (!found) return null;
    const state = await this.timeline(found.file, found.agent.state === "done");
    return state ? this.build(key, found, state) : null;
  }

  private async build(
    key: SessionKey,
    found: NonNullable<ReturnType<AgentInspector["find"]>>,
    state: TimelineState,
  ): Promise<AgentDetail> {
    const { snapshot, agent, file } = found;
    const view = timelineView(state);
    // an Agent call's id is the toolUseId in the meta of the agent it started
    const started = new Map(
      snapshot.agents.flatMap((a) => (a.toolUseId ? [[a.toolUseId, a.id] as const] : [])),
    );
    const journal = agent.workflow
      ? (await readWorkflowJournal(path.dirname(file))).get(agent.id)
      : undefined;
    const result = (agent.workflow ? workflowResultText(journal) : undefined) ?? view.result;
    const detail: AgentDetail = {
      key,
      id: agent.id,
      tokens: view.tokens,
      toolCount: view.toolCount,
      steps: detailSteps(state.steps, view.steps, started),
    };
    if (view.prompt !== undefined) detail.prompt = view.prompt;
    if (result) detail.result = result;
    if (view.model) detail.model = view.model;
    if (view.startedAt !== undefined) detail.startedAt = view.startedAt;
    if (view.lastAt !== undefined) detail.lastAt = view.lastAt;
    if (view.error) detail.error = view.error;
    if (view.interrupted) detail.interrupted = true;
    return detail;
  }

  /**
   * the agent on screen: everything so far, then only what it appends, pushed as it lands. the
   * file is looked at every TAIL_MS and read from where the last read stopped, so a 4MB agent
   * that wrote one line costs one line. any call replaces the one before.
   */
  async follow(
    key: SessionKey,
    agentId: string | null,
    find = "",
  ): Promise<{ gen: number; detail: AgentDetail; found?: number } | null> {
    // leaving an agent stops watching it, and never the conversation that took its place
    if (typeof agentId !== "string") {
      if (this.following?.kind === "agent") this.unfollow();
      return null;
    }
    this.unfollow();
    const gen = ++this.gen;
    const found = this.find(key, agentId);
    if (!found) return null;
    const state = await this.timeline(found.file, found.agent.state === "done");
    const info = await stat(found.file).catch(() => null);
    // another follow started while this one was reading
    if (!state || !info || gen !== this.gen) return null;
    const detail = await this.build(key, found, state);
    if (gen !== this.gen) return null;
    const f: AgentFollow = {
      kind: "agent",
      key,
      id: agentId,
      file: found.file,
      gen,
      sent: state.steps,
      drop: finalTexts(state),
      mark: fileMark(info),
      timer: setInterval(() => void this.tick(f), this.opts.tailMs ?? TAIL_MS),
      busy: false,
    };
    f.timer.unref?.();
    this.following = f;
    const landed = find ? findStep(state, tokenize(find)) : undefined;
    return { gen, detail, ...(landed !== undefined ? { found: landed } : {}) };
  }

  private unfollow(): void {
    const f = this.following;
    if (f) clearInterval(f.timer);
    // whatever the last push read of a running session goes to disk now, not in 30s
    if (f?.kind === "conversation") this.conversations.save(f.file);
    this.following = null;
  }

  private tick(f: Follow): Promise<void> {
    return f.kind === "agent" ? this.tickAgent(f) : this.tickConversation(f);
  }

  private async tickAgent(f: AgentFollow): Promise<void> {
    if (this.following !== f || f.busy) return;
    f.busy = true;
    try {
      const info = await stat(f.file).catch(() => null);
      if (!info || fileMark(info) === f.mark) return;
      const found = this.find(f.key, f.id);
      if (!found) return;
      const state = await this.timeline(f.file, false);
      if (!state || this.following !== f) return;
      f.mark = fileMark(info);
      const drop = finalTexts(state);
      const from = firstChange(f.sent, state.steps, [...f.drop, ...drop]);
      const { key: _k, id: _i, steps, prompt: _p, ...head } = await this.build(f.key, found, state);
      if (this.following !== f) return;
      f.sent = state.steps;
      f.drop = drop;
      this.opts.onSteps?.({
        key: f.key,
        id: f.id,
        gen: f.gen,
        from,
        steps: steps.filter((s) => s.n >= from),
        head,
      });
    } catch (e) {
      log.warn("agent tail of", f.file, e);
    } finally {
      f.busy = false;
    }
  }

  dispose(): void {
    this.unfollow();
  }

  /** a session's agents, by the Agent call that started each: what makes an Agent step a link */
  private started(key: SessionKey): Map<string, string> {
    return new Map(
      (this.opts.snapshot(key)?.agents ?? []).flatMap((a) =>
        a.toolUseId ? [[a.toolUseId, a.id] as const] : [],
      ),
    );
  }

  /** a session's transcript, only ever from the index */
  private transcript(key: SessionKey): string | null {
    if (typeof key !== "string") return null;
    return this.opts.transcript?.(key) ?? null;
  }

  /**
   * a session's own conversation on screen: every turn now, then what it writes, pushed as it
   * lands - from the first turn that changed, and the newest turn's work from its first changed
   * step. the same poller as an agent's: whichever was on screen before stops.
   */
  async followConversation(
    key: SessionKey | null,
    find = "",
  ): Promise<{
    gen: number;
    conversation: ConversationView;
    found?: { n: number; step?: number };
  } | null> {
    if (key === null) {
      if (this.following?.kind === "conversation") this.unfollow();
      return null;
    }
    this.unfollow();
    const gen = ++this.gen;
    const file = this.transcript(key);
    if (!file) return null;
    const read = await this.conversations.read(file);
    if (!read || gen !== this.gen) return null;
    const { state, mark } = read;
    const conversation = conversationView(key, state, {
      running: this.opts.running?.(key) ?? false,
      started: this.started(key),
    });
    const n = state.items.length - 1;
    const last = state.items[n];
    const f: ConversationFollow = {
      kind: "conversation",
      key,
      file,
      gen,
      sent: state.items,
      live:
        last?.kind === "turn"
          ? { n, steps: last.work.steps, answer: answerSteps(last.work) }
          : null,
      mark,
      timer: setInterval(() => void this.tick(f), this.opts.tailMs ?? TAIL_MS),
      busy: false,
    };
    f.timer.unref?.();
    this.following = f;
    const found = find ? findTurn(state, tokenize(find), find) : undefined;
    return { gen, conversation, ...(found ? { found } : {}) };
  }

  private async tickConversation(f: ConversationFollow): Promise<void> {
    if (this.following !== f || f.busy) return;
    f.busy = true;
    try {
      const info = await stat(f.file).catch(() => null);
      if (!info || fileMark(info) === f.mark) return;
      const read = await this.conversations.read(f.file);
      if (!read || this.following !== f) return;
      const { state, mark } = read;
      f.mark = mark;
      const from = firstChange(f.sent, state.items, []);
      const n = state.items.length - 1;
      const last = state.items[n];
      let live: ConversationTurns["live"];
      let next: ConversationFollow["live"] = null;
      if (last?.kind === "turn") {
        const answer = answerSteps(last.work);
        next = { n, steps: last.work.steps, answer };
        // a text that moved in or out of the answer changes the lines without changing a step
        const at =
          f.live?.n === n
            ? firstChange(f.live.steps, last.work.steps, [...f.live.answer, ...answer])
            : 0;
        if (f.live?.n !== n || at < last.work.steps.length || f.live.steps.length > at) {
          live = {
            n,
            from: at,
            steps: turnSteps(last, this.started(f.key)).filter((s) => s.n >= at),
          };
        }
      }
      f.sent = state.items;
      f.live = next;
      if (from >= state.items.length && !live) return;
      this.opts.onTurns?.({
        key: f.key,
        gen: f.gen,
        from,
        items: state.items.slice(from).map((item, i) => entryView(item, from + i)),
        head: conversationHead(state),
        ...(live ? { live } : {}),
      });
    } catch (e) {
      log.warn("conversation tail of", f.file, e);
    } finally {
      f.busy = false;
    }
  }

  /** one turn's work, opened */
  async conversationSteps(key: SessionKey, n: number) {
    const file = this.transcript(key);
    if (!file || typeof n !== "number") return null;
    const read = await this.conversations.read(file);
    const turn = read?.state.items[n];
    return turn?.kind === "turn" ? turnSteps(turn, this.started(key)) : null;
  }

  /** one step of the conversation opened. the only place a whole tool result is read. */
  async conversationStep(key: SessionKey, stepId: string): Promise<StepDetail | null> {
    const file = this.transcript(key);
    if (!file || typeof stepId !== "string") return null;
    const read = await this.conversations.read(file);
    for (const item of read?.state.items ?? []) {
      if (item.kind !== "turn") continue;
      const step = item.work.steps.find((s) => s.kind === "tool" && s.id === stepId);
      if (step?.kind === "tool") return readToolDetail(file, step);
    }
    return null;
  }

  /** one step opened. the only place a whole tool result is read. */
  async step(key: SessionKey, agentId: string, stepId: string): Promise<StepDetail | null> {
    const found = this.find(key, agentId);
    if (!found || typeof stepId !== "string") return null;
    const state = await this.timeline(found.file, found.agent.state === "done");
    const step = state?.steps.find((s) => s.kind === "tool" && s.id === stepId);
    if (step?.kind !== "tool") return null;
    return readToolDetail(found.file, step);
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

/**
 * where a search landed inside an agent: the first step holding the most of its words. the prompt
 * and the result are on screen when the detail opens, so a match only there lands nowhere.
 */
export function findStep(state: TimelineState, tokens: readonly string[]): number | undefined {
  if (tokens.length === 0) return undefined;
  const result = new Set(finalTexts(state));
  let best: number | undefined;
  let most = 0;
  state.steps.forEach((s, n) => {
    if (result.has(n) || s.kind === "thinking") return;
    const hay = (s.kind === "tool" ? `${s.name}\n${s.target}\n${s.input}` : s.text).toLowerCase();
    const count = tokens.filter((t) => hay.includes(t)).length;
    if (count > most) {
      most = count;
      best = n;
    }
  });
  return best;
}

/** the steps the view lifts out as the result: the text of a final message that calls no tool */
function finalTexts(state: TimelineState): number[] {
  const last = state.last;
  return last && !last.tool && !last.error ? last.texts : [];
}

/**
 * the first fold index a push has to send again. steps are replaced, never changed in place, so
 * the first one that is not the same object is where the news starts - and a text that moved in
 * or out of the result changes what the view shows without changing the step.
 */
export function firstChange(
  sent: readonly unknown[],
  next: readonly unknown[],
  moved: readonly number[],
): number {
  let i = 0;
  const n = Math.min(sent.length, next.length);
  while (i < n && sent[i] === next[i]) i++;
  return Math.min(i, ...moved);
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
