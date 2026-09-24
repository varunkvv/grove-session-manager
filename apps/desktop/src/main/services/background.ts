import { execFile } from "node:child_process";
import os from "node:os";
import { type BackgroundEntry, backgroundBySession, parseBackgroundList } from "@grove/core";
import { log } from "../log.ts";

/** measured at ~170ms. a claude that takes longer than this is not going to answer. */
const READ_TIMEOUT_MS = 5000;

/** `--all` keeps a finished or stopped session in the list until someone `claude rm`s it */
export const AGENTS_ARGS = ["agents", "--json", "--all"] as const;
/** stopping waits for the worker to wind down. give it room, but not forever. */
const STOP_TIMEOUT_MS = 30_000;
/** after a stop, how long to wait for the supervisor to say the worker is gone */
export const RELEASE_TIMEOUT_MS = 10_000;

/**
 * `claude stop`, never `claude rm`: rm deletes the row and reasons about worktrees, and a
 * combo's working copies are linked worktrees. stop keeps the conversation.
 */
export function stopArgs(shortId: string): string[] {
  return ["stop", shortId];
}

/** dispatching starts the supervisor when none is up. it prints its line and returns. */
const DISPATCH_TIMEOUT_MS = 60_000;

/**
 * hands a session nothing is running to the supervisor, under its own id and transcript. the
 * prompt comes after `--`, so typed text starting with a dash can never become a flag. no
 * permission mode and no skip-permissions: a session that stops on a prompt shows up as blocked,
 * and attach is how it gets answered.
 */
export function continueArgs(sessionId: string, prompt: string): string[] {
  return ["--resume", sessionId, "--bg", "--", prompt];
}

/** a new background session. `--name=` in one argument, so a name can never read as a flag. */
export function newSessionArgs(prompt: string, name?: string): string[] {
  return ["--bg", ...(name ? [`--name=${name}`] : []), "--", prompt];
}

/**
 * since 2.1.281 a dispatch into a folder that never passed the CLI's trust prompt exits 1 with
 * "Workspace not trusted. Run `claude` in <dir> once and accept the trust prompt, then retry."
 * on stderr. a combo only ever used from VS Code has not.
 */
export function isNotTrusted(out: ClaudeRun): boolean {
  return out.code !== 0 && /not trusted/i.test(`${out.stderr}\n${out.stdout}`);
}

/** `backgrounded · d7b6bcc2`: the short id, from what the dispatch printed */
export function backgroundedId(stdout: string): string | undefined {
  return /backgrounded\s*\S\s*([A-Za-z0-9_-]+)/i.exec(stdout)?.[1];
}

export type Dispatched =
  | { ok: true; id?: string; out: ClaudeRun }
  | { ok: false; notTrusted: boolean; out: ClaudeRun };

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

  /** one claude command, with the binary and environment every call of this feature gets */
  async exec(args: readonly string[], o: { cwd: string; timeoutMs: number }): Promise<ClaudeRun> {
    const [bin, env] = await Promise.all([this.opts.claudeBin(), this.opts.env()]);
    return this.run(bin, args, { cwd: o.cwd, env, timeoutMs: o.timeoutMs });
  }

  /** `claude stop <id>`, then a fresh read so the row stops offering what no longer applies */
  async stop(shortId: string): Promise<ClaudeRun> {
    const out = await this.exec(stopArgs(shortId), {
      cwd: os.tmpdir(),
      timeoutMs: STOP_TIMEOUT_MS,
    });
    await this.read();
    return out;
  }

  /**
   * runs a `--bg` command in `cwd` (the session's own folder, so its CLAUDE.md and hooks load),
   * then reads the supervisor again so the row shows it. the short id comes from that read when
   * the session is known, and from the printed line otherwise.
   */
  async dispatch(
    args: readonly string[],
    o: { cwd: string; sessionId?: string },
  ): Promise<Dispatched> {
    const out = await this.exec(args, { cwd: o.cwd, timeoutMs: DISPATCH_TIMEOUT_MS });
    if (out.code !== 0) return { ok: false, notTrusted: isNotTrusted(out), out };
    const entries = await this.read();
    const known = o.sessionId ? entries?.get(o.sessionId)?.id : undefined;
    const id = known ?? backgroundedId(out.stdout);
    return { ok: true, ...(id ? { id } : {}), out };
  }

  /**
   * until the supervisor says it holds no worker for the session, read after read. a resume in
   * the editor before that is refused. false when it still holds one at the deadline.
   */
  async waitReleased(
    sessionId: string,
    timeoutMs = RELEASE_TIMEOUT_MS,
    everyMs = 400,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entries = await this.read();
      if (entries && entries.get(sessionId)?.pid === undefined) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, everyMs));
    }
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
    this.reading = this.readOnce()
      .catch((e) => {
        log.warn("claude agents --json:", e);
        return null;
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }

  private async readOnce(): Promise<ReadonlyMap<string, BackgroundEntry> | null> {
    if (!this.opts.enabled()) return null;
    const out = await this.exec(AGENTS_ARGS, { cwd: os.tmpdir(), timeoutMs: READ_TIMEOUT_MS });
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
