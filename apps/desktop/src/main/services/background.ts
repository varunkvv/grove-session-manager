import { execFile } from "node:child_process";
import os from "node:os";
import { type BackgroundEntry, backgroundBySession, parseBackgroundList } from "@grove/core";
import { log } from "../log.ts";

/** measured at ~170ms. a claude that takes longer than this is not going to answer. */
const READ_TIMEOUT_MS = 5000;

/** `--all` keeps a finished or stopped session in the list until someone `claude rm`s it */
export const AGENTS_ARGS = ["agents", "--json", "--all"] as const;

export interface ClaudeRun {
  /** null when it never ran, or was killed at the timeout */
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunClaude = (
  bin: string,
  args: readonly string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<ClaudeRun>;

/** argv, never a shell: a prompt is typed text. never rejects - a failure is a value. */
export const runClaude: RunClaude = (bin, args, o) =>
  new Promise((resolve) => {
    try {
      execFile(
        bin,
        [...args],
        { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, maxBuffer: 4 << 20, encoding: "utf8" },
        (error, stdout, stderr) => {
          const code = !error ? 0 : typeof error.code === "number" ? error.code : null;
          resolve({
            code,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") || (error && code === null ? error.message : ""),
          });
        },
      );
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: String(e) });
    }
  });

export interface BackgroundServiceOptions {
  claudeBin: () => Promise<string>;
  /** the environment every claude this feature runs gets */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** off in a test root unless a stub claude is named: a test never runs the real one */
  enabled: () => boolean;
  /** a real answer, by session id. an unknown one never comes here. */
  onEntries: (entries: ReadonlyMap<string, BackgroundEntry>) => void;
  run?: RunClaude;
}

/**
 * Claude Code's supervisor, as seen through its own commands. Grove never supervises anything:
 * it asks `claude agents --json` what is running in the background, when something suggests the
 * answer moved - never on a timer.
 */
export class BackgroundService {
  private readonly opts: BackgroundServiceOptions;
  private readonly run: RunClaude;
  private entries: ReadonlyMap<string, BackgroundEntry> = new Map();
  private reading: Promise<ReadonlyMap<string, BackgroundEntry> | null> | null = null;
  private queued: Promise<ReadonlyMap<string, BackgroundEntry> | null> | null = null;
  private lastProblem = "";

  constructor(opts: BackgroundServiceOptions) {
    this.opts = opts;
    this.run = opts.run ?? runClaude;
  }

  /** the last real answer for one session. undefined: not in the background, or not known yet. */
  get(sessionId: string): BackgroundEntry | undefined {
    return this.entries.get(sessionId);
  }

  /**
   * one read at a time. a call during one gets the read after it, which has started since the
   * call - what a caller that just ran a command needs. null is "unknown", never "none".
   */
  read(): Promise<ReadonlyMap<string, BackgroundEntry> | null> {
    if (this.reading) {
      this.queued ??= this.reading.then(() => {
        this.queued = null;
        return this.read();
      });
      return this.queued;
    }
    this.reading = this.readOnce().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async readOnce(): Promise<ReadonlyMap<string, BackgroundEntry> | null> {
    if (!this.opts.enabled()) return null;
    const [bin, env] = await Promise.all([this.opts.claudeBin(), this.opts.env()]);
    const out = await this.run(bin, AGENTS_ARGS, {
      cwd: os.tmpdir(),
      env,
      timeoutMs: READ_TIMEOUT_MS,
    });
    const list = out.code === 0 ? parseBackgroundList(out.stdout) : null;
    if (!list) {
      // once per kind of failure: a machine without claude would otherwise log on every focus
      const problem = `exit ${out.code}: ${(out.stderr || out.stdout).trim().slice(0, 200)}`;
      if (problem !== this.lastProblem) log.warn("claude agents --json:", problem);
      this.lastProblem = problem;
      return null;
    }
    this.lastProblem = "";
    this.entries = backgroundBySession(list);
    this.opts.onEntries(this.entries);
    return this.entries;
  }
}
