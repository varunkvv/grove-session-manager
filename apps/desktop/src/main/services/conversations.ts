import { stat } from "node:fs/promises";
import {
  answerSteps,
  type ConversationItem,
  type ConversationState,
  conversationCacheDir,
  conversationTotals,
  fileMark,
  loadCachedConversation,
  type Mark,
  readConversation,
  saveCachedConversation,
  sweepTimelineCache,
  type Turn,
  turnNumbers,
} from "@grove/core";
import type {
  ConversationEntry,
  ConversationTurn,
  ConversationView,
  DetailStep,
} from "../../shared/ipc.ts";
import { log } from "../log.ts";
import { detailSteps } from "./detailSteps.ts";

/** folded conversations kept in memory. the 107MB transcript folds to ~4MB. */
const MEMORY = 6;
/** a running session writes all the time: its fold goes to disk at most this often */
export const SAVE_EVERY_MS = 30_000;

export interface ConversationsOptions {
  stateDir: string;
  now?: () => number;
}

/**
 * sessions' own conversations, folded when someone looks and kept: in memory, and in .grove keyed
 * by the transcript's mtime:size. unlike an agent's, a running session's fold is worth keeping on
 * disk too: it carries its offset and the transcript only grows, so it is still the right place to
 * start the next read from - and the 107MB one should never be folded from the top twice.
 */
export class Conversations {
  private readonly opts: ConversationsOptions;
  private readonly cacheDir: string;
  /** insertion order is recency: a hit is moved to the end */
  private readonly memory = new Map<string, { mark: string; state: ConversationState }>();
  /** one fold per file at a time */
  private readonly folding = new Map<
    string,
    Promise<{ mark: string; state: ConversationState } | null>
  >();
  /** the mark each transcript's fold was last written to disk at, and when */
  private readonly saved = new Map<string, { mark: string; at: number }>();

  constructor(opts: ConversationsOptions) {
    this.opts = opts;
    this.cacheDir = conversationCacheDir(opts.stateDir);
    const sweep = setTimeout(() => void sweepTimelineCache(this.cacheDir), 90_000);
    sweep.unref?.();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * one transcript folded: from memory, from the cache, or read - and only what was appended
   * since, when an older fold exists. null when the file is gone.
   */
  read(file: string): Promise<{ mark: string; state: ConversationState } | null> {
    const running = this.folding.get(file);
    if (running) return running;
    const job = this.fold(file).finally(() => this.folding.delete(file));
    this.folding.set(file, job);
    return job;
  }

  private async fold(file: string): Promise<{ mark: string; state: ConversationState } | null> {
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    const mark = fileMark(info);
    const held = this.memory.get(file);
    if (held?.mark === mark) {
      this.remember(file, held);
      return held;
    }
    let prev = held?.state;
    if (!prev) {
      const cached = await loadCachedConversation(this.cacheDir, file);
      if (cached) this.saved.set(file, { mark: cached.mark, at: 0 });
      if (cached?.mark === mark) {
        this.remember(file, cached);
        return cached;
      }
      prev = cached?.state;
    }
    const state = await readConversation(file, prev);
    const entry = { mark, state };
    this.remember(file, entry);
    const last = this.saved.get(file);
    if (!last || (last.mark !== mark && this.now() - last.at >= SAVE_EVERY_MS)) this.save(file);
    return entry;
  }

  /** what is in memory for this file goes to disk, unless it is there already */
  save(file: string): void {
    const held = this.memory.get(file);
    if (!held || this.saved.get(file)?.mark === held.mark) return;
    this.saved.set(file, { mark: held.mark, at: this.now() });
    void saveCachedConversation(this.cacheDir, file, held.mark, held.state).catch((e) =>
      log.warn("conversation cache:", e),
    );
  }

  private remember(file: string, entry: { mark: string; state: ConversationState }): void {
    this.memory.delete(file);
    this.memory.set(file, entry);
    while (this.memory.size > MEMORY) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      // a running session's last reading may not have gone to disk yet
      this.save(oldest);
      this.memory.delete(oldest);
    }
  }
}

/** a turn as the pane draws it before its work is opened */
export function turnView(turn: Turn, n: number): ConversationTurn {
  const numbers = turnNumbers(turn);
  const view: ConversationTurn = {
    kind: "turn",
    n,
    marks: turn.marks,
    tools: numbers.tools,
    filesEdited: numbers.filesEdited,
    agents: numbers.agents,
  };
  if (turn.prompt) view.prompt = turn.prompt;
  const answer = answerSteps(turn.work).flatMap((i) => {
    const s = turn.work.steps[i];
    return s?.kind === "text" ? [s.text] : [];
  });
  if (answer.length) view.answer = answer.join("\n\n");
  if (turn.output !== undefined) view.output = turn.output;
  if (turn.work.last?.error) view.error = turn.work.last.error;
  if (turn.apiError) view.apiError = turn.apiError;
  if (turn.work.interrupted) view.interrupted = true;
  if (numbers.startedAt !== undefined) view.startedAt = numbers.startedAt;
  if (numbers.endedAt !== undefined) view.endedAt = numbers.endedAt;
  if (numbers.durationMs !== undefined) view.durationMs = numbers.durationMs;
  return view;
}

export function entryView(item: ConversationItem, n: number): ConversationEntry {
  if (item.kind === "turn") return turnView(item, n);
  return { ...item, n };
}

/** a turn's work as lines: every step but the answer, which is drawn on its own */
export function turnSteps(turn: Turn, started: ReadonlyMap<string, string>): DetailStep[] {
  const answer = new Set(answerSteps(turn.work));
  const shown = answer.size ? turn.work.steps.filter((_, i) => !answer.has(i)) : turn.work.steps;
  return detailSteps(turn.work.steps, shown, started);
}

export function conversationHead(
  state: ConversationState,
): Omit<ConversationView, "key" | "items" | "live"> {
  const totals = conversationTotals(state);
  const head: Omit<ConversationView, "key" | "items" | "live"> = {
    tools: totals.tools,
    turns: totals.turns,
  };
  if (totals.model) head.model = totals.model;
  if (totals.startedAt !== undefined) head.startedAt = totals.startedAt;
  if (totals.lastAt !== undefined) head.lastAt = totals.lastAt;
  return head;
}

/**
 * the whole conversation as the pane first draws it: every turn, no steps - except the newest
 * turn's while the session runs, since that work is open from the start
 */
export function conversationView(
  key: string,
  state: ConversationState,
  opts: { running: boolean; started: ReadonlyMap<string, string> },
): ConversationView {
  const view: ConversationView = {
    key,
    items: state.items.map(entryView),
    ...conversationHead(state),
  };
  const n = state.items.length - 1;
  const last = state.items[n];
  if (opts.running && last?.kind === "turn")
    view.live = { n, steps: turnSteps(last, opts.started) };
  return view;
}

function marksText(marks: readonly Mark[]): string {
  return marks
    .map((m) =>
      m.kind === "plan"
        ? `${m.text}\n${m.said ?? ""}`
        : m.kind === "question"
          ? m.questions.map((q) => `${q.question}\n${q.picked ?? ""}`).join("\n")
          : m.text,
    )
    .join("\n");
}

/**
 * where a search landed in a conversation: the first turn holding the most of its words - in what
 * is always in sight (the prompt, the answer, a plan...) or, failing that, in a step of its work
 */
export function findTurn(
  state: ConversationState,
  tokens: readonly string[],
): { n: number; step?: number } | undefined {
  if (tokens.length === 0) return undefined;
  const count = (hay: string) => {
    const lower = hay.toLowerCase();
    return tokens.filter((t) => lower.includes(t)).length;
  };
  let best: { n: number; step?: number } | undefined;
  let most = 0;
  state.items.forEach((item, n) => {
    if (item.kind !== "turn") return;
    const answer = new Set(answerSteps(item.work));
    const seen = count(
      [
        item.prompt?.text ?? "",
        item.output ?? "",
        marksText(item.marks),
        ...[...answer].map((i) => {
          const s = item.work.steps[i];
          return s?.kind === "text" ? s.text : "";
        }),
      ].join("\n"),
    );
    if (seen > most) {
      most = seen;
      best = { n };
    }
    item.work.steps.forEach((s, i) => {
      if (answer.has(i) || s.kind === "thinking") return;
      const c = count(s.kind === "tool" ? `${s.name}\n${s.target}` : s.text);
      if (c > most) {
        most = c;
        best = { n, step: i };
      }
    });
  });
  return best;
}
