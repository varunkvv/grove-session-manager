import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentSnapshot, agentDigest, readTail, squash } from "@grove/core";
import type { SessionKey } from "../../shared/ipc.ts";
import { log } from "../log.ts";

/**
 * the two numbers worth tuning, together: how often a running agent's line is rewritten, and how
 * much of its transcript is read to write it. everything below is bounded by these.
 */
const REFRESH_MS = 30_000;
const TAIL_BYTES = 16_384;

const TIMEOUT_MS = 20_000;
/** this spends the person's own Claude auth, so it never fans out */
const CONCURRENCY = 2;
const MODEL = "claude-haiku-4-5-20251001";
const SUMMARY_MAX = 90;

/**
 * verified by hand on 2026-09-22 with claude 2.1.278, and written down in docs/claude-code-facts.md.
 * each flag earns its place:
 *   --no-session-persistence  no transcript on disk, so the summariser never shows up as a session
 *   --restricted              settings files are ignored, so our own status hooks never fire for it
 *   --strict-mcp-config       none of the person's MCP servers start
 *   --permission-prompts none nothing can sit waiting for a decision
 *   --tools ""                the call reads a prompt and writes a line. it needs nothing else.
 */
export function summaryArgs(model = MODEL): string[] {
  return [
    "-p",
    "--model",
    model,
    "--no-session-persistence",
    "--restricted",
    "--strict-mcp-config",
    "--permission-prompts",
    "none",
    "--tools",
    "",
  ];
}

export function summaryPrompt(agentType: string, description: string | undefined, digest: string) {
  const asked = description ? `It was asked to: ${description}\n` : "";
  return (
    `Below is the tail of a log written by a "${agentType}" coding agent.\n${asked}` +
    "Reply with one lowercase phrase of at most 10 words saying what it is doing right now. " +
    "No preamble, no quotes, no full stop.\n\n" +
    digest
  );
}

export type SummarySpawn = (
  bin: string,
  args: readonly string[],
  input: string,
  cwd: string,
) => Promise<string | null>;

/** never a repo: a temp dir skips the workspace trust prompt and loads nobody's CLAUDE.md */
export function summaryCwd(stateDir: string): string {
  return path.join(tmpdir(), `grove-summary-${path.basename(stateDir)}`);
}

const defaultSpawn: SummarySpawn = (bin, args, input, cwd) =>
  new Promise((resolve) => {
    const child = execFile(
      bin,
      [...args],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        // silent to the person, but a warn is the only trace of expired auth or a moved flag
        if (error) log.warn("agent summary:", error.message, stderr.split("\n")[0] ?? "");
        resolve(error ? null : stdout);
      },
    );
    child.stdin?.end(input);
  });

export interface AgentSummariesOptions {
  /** where the throwaway cwd goes. only used to keep test roots apart. */
  stateDir: string;
  claudeBin: () => Promise<string>;
  /** the setting, read fresh: it can be switched off while the app is open */
  enabled: () => boolean;
  /** nobody reads a hidden window, so a hidden window pays for nothing */
  visible: () => boolean;
  onSummary: (key: SessionKey, agentId: string, summary: string, at: number) => void;
  spawn?: SummarySpawn;
  now?: () => number;
  /** REFRESH_MS. only a test ever passes anything else. */
  refreshMs?: number;
}

/**
 * one short line per running agent, written by a cheap model reading the agent's own transcript.
 * the orchestrating session is never interrupted and never asked - asking it would cost a whole
 * turn on its full context.
 *
 * failures are silent: the row keeps its last tool and shows no summary.
 */
export class AgentSummaries {
  private readonly opts: AgentSummariesOptions;
  private readonly spawn: SummarySpawn;
  private readonly refreshMs: number;
  /** the last scan per session, so waking the window can act without waiting for the next one */
  private latest = new Map<SessionKey, AgentSnapshot>();
  /** agent id -> the file mark it was summarised at, and when */
  private done = new Map<string, { mark: string; at: number }>();
  private queue: Array<{ key: SessionKey; id: string; file: string; mark: string }> = [];
  private queued = new Set<string>();
  private running = 0;
  private disposed = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: AgentSummariesOptions) {
    this.opts = opts;
    this.spawn = opts.spawn ?? defaultSpawn;
    this.refreshMs = opts.refreshMs ?? REFRESH_MS;
    // an agent that writes once and then thinks for a minute gets no rescan, so the cadence cannot
    // be driven by writes alone
    this.timer = setInterval(() => this.wake(), this.refreshMs);
    this.timer.unref?.();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** a fresh scan of one session's agents. cheap and synchronous: it only decides what to ask for. */
  note(key: SessionKey, snapshot: AgentSnapshot): void {
    this.latest.set(key, snapshot);
    if (snapshot.agents.length === 0) this.latest.delete(key);
    this.pump(key, snapshot);
  }

  /** the window came back. nothing was refreshed while it was hidden, so catch up now. */
  wake(): void {
    for (const [key, snapshot] of this.latest) this.pump(key, snapshot);
  }

  private pump(key: SessionKey, snapshot: AgentSnapshot): void {
    if (this.disposed || !this.opts.enabled() || !this.opts.visible()) return;
    const now = this.now();
    for (const agent of snapshot.agents) {
      if (agent.state !== "running" || this.queued.has(agent.id)) continue;
      const read = snapshot.reads[agent.id];
      if (!read) continue;
      const was = this.done.get(agent.id);
      // nothing new was written, so there is nothing new to say
      if (was?.mark === read.mark) continue;
      if (was && now - was.at < this.refreshMs) continue;
      this.queued.add(agent.id);
      this.queue.push({ key, id: agent.id, file: read.file, mark: read.mark });
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.running < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      void this.run(job).finally(() => {
        this.running--;
        this.queued.delete(job.id);
        if (this.queue.length > 0) void this.drain();
      });
    }
  }

  private async run(job: { key: SessionKey; id: string; file: string; mark: string }) {
    // claimed before the call, so a failure still waits out the cadence instead of retrying at once
    this.done.set(job.id, { mark: job.mark, at: this.now() });
    const agent = this.latest.get(job.key)?.agents.find((a) => a.id === job.id);
    if (!agent) return;
    try {
      const tail = await readTail(job.file, TAIL_BYTES);
      const digest = agentDigest(tail.text);
      if (!digest) return;
      const bin = await this.opts.claudeBin();
      const cwd = summaryCwd(this.opts.stateDir);
      await mkdir(cwd, { recursive: true });
      const out = await this.spawn(
        bin,
        summaryArgs(),
        summaryPrompt(agent.agentType, agent.description, digest),
        cwd,
      );
      const line = out
        ?.split("\n")
        .map((l) => l.trim())
        .find(Boolean);
      if (!line) return;
      // the agent may have finished while the model was thinking. that result is no longer news.
      const still = this.latest.get(job.key)?.agents.find((a) => a.id === job.id);
      if (still?.state !== "running") return;
      this.opts.onSummary(job.key, job.id, squash(line, SUMMARY_MAX), this.now());
    } catch (e) {
      log.warn("agent summary:", e);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
    this.queued.clear();
  }
}
