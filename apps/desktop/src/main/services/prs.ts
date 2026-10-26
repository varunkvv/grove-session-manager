import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import {
  checksQuery,
  chunk,
  type FailingCheck,
  type PrInfo,
  type PrRef,
  type PrStatus,
  parseFailingChecks,
  parsePrInfo,
  parsePrResponse,
  parsePrUrl,
  prInfoQuery,
  prQuery,
  writeFileAtomic,
} from "@grove/core";
import { log } from "../log.ts";
import { type ClaudeRun, type RunClaude, runClaude } from "./background.ts";

/** a chunk of 20 takes 2-4s. a gh that takes this long is not going to answer */
const RUN_TIMEOUT_MS = 30_000;
export const WORKING_MS = 60_000;
export const IDLE_MS = 5 * 60_000;
export const MAX_MS = 30 * 60_000;
/** a new link is asked about this soon after it shows */
export const NEW_LINK_MS = 2000;
/** focus asks again at most this often */
const FOCUS_MS = 30_000;
/** no gh, or logged out: focus looks again at most this often */
export const RECHECK_OFF_MS = 10 * 60_000;

export type RunGh = RunClaude;

export interface PrEntry extends PrStatus {
  checkedAt: number;
}

/** a link one of the listed sessions has, and whether that session is at work */
export interface PrWant {
  url: string;
  working: boolean;
}

export interface PrServiceOptions {
  stateFile: string;
  ghBin: () => Promise<string>;
  env: () => Promise<NodeJS.ProcessEnv>;
  /** off in a test root unless a stub gh is named */
  enabled: () => boolean;
  /** paused while no grove window shows */
  visible: () => boolean;
  /** the links on rows that are live or active in the last week */
  wanted: () => PrWant[];
  onChange: () => void;
  run?: RunGh;
  now?: () => number;
}

/** where gh usually is, for an app opened from Finder. else a bare `gh` and the PATH's luck */
export async function resolveGhBin(configured?: string): Promise<string> {
  for (const candidate of [configured, "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
    if (!candidate) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // not there
    }
  }
  return "gh";
}

/** why gh cannot be used at all, or undefined when it is something that may pass */
export function offReason(out: ClaudeRun): string | undefined {
  const text = `${out.stderr}\n${out.stdout}`;
  if (out.code === null && /ENOENT/.test(text)) return "no gh";
  if (out.code === 4 || /HTTP 401|Bad credentials|gh auth login/i.test(text)) return "logged out";
  return undefined;
}

/** the hosts gh is logged in to. null when it could not say */
export function parseHosts(stdout: string): Set<string> | null {
  try {
    const parsed = JSON.parse(stdout) as { hosts?: Record<string, Array<{ state?: string }>> };
    if (!parsed.hosts || typeof parsed.hosts !== "object") return null;
    return new Set(
      Object.entries(parsed.hosts)
        .filter(
          ([, accounts]) => Array.isArray(accounts) && accounts.some((a) => a.state === "success"),
        )
        .map(([host]) => host),
    );
  } catch {
    return null;
  }
}

const done = (e?: PrEntry) => e?.state === "merged" || e?.state === "closed";

/**
 * what github says of the PRs the sessions linked, through the person's own gh. asked for open
 * PRs on recent rows only: every minute while one of them works, every five otherwise, never
 * while no window shows. merged and closed are never asked again. a PR never moves a row
 */
export class PrService {
  private readonly opts: PrServiceOptions;
  private readonly run: RunGh;
  private readonly now: () => number;
  private statuses = new Map<string, PrEntry>();
  /** github says they are not there, for this login. not asked again this run */
  private gone = new Set<string>();
  private checks = new Map<string, { rollup?: string; list: FailingCheck[] }>();
  private asking = new Map<string, Promise<FailingCheck[]>>();
  private infoAsking = new Map<string, Promise<PrInfo | null>>();
  private hosts: Set<string> | null = null;
  private off: { why: string; at: number } | null = null;
  private failures = 0;
  private lastTick = 0;
  private lastProblem = "";
  private timer: NodeJS.Timeout | null = null;
  private due = 0;
  private ticking: Promise<void> | null = null;

  constructor(opts: PrServiceOptions) {
    this.opts = opts;
    this.run = opts.run ?? runClaude;
    this.now = opts.now ?? Date.now;
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.opts.stateFile, "utf8")) as Record<
        string,
        PrEntry
      >;
      for (const [url, e] of Object.entries(saved)) {
        if (e && typeof e.state === "string") this.statuses.set(url, e);
      }
    } catch {
      // none yet
    }
  }

  get(url: string): (PrEntry & { stale?: true }) | undefined {
    const e = this.statuses.get(url);
    return e && this.failures > 0 && !done(e) ? { ...e, stale: true } : e;
  }

  /** focus or a wake from sleep: ask again soon, and look again at a gh that was not there */
  kick(): void {
    const now = this.now();
    if (this.off && now - this.off.at >= RECHECK_OFF_MS) {
      this.off = null;
      this.hosts = null;
    }
    this.schedule(Math.max(0, this.lastTick + FOCUS_MS - now));
  }

  /** the rows changed: a link nobody asked about yet is asked about in a moment */
  poke(): void {
    const fresh = this.open().some((w) => !this.statuses.has(w.url));
    if (fresh) this.schedule(NEW_LINK_MS);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** what is left to ask about: open, known to github, on a host gh is logged in to */
  private open(): PrWant[] {
    return this.opts
      .wanted()
      .filter((w) => !this.gone.has(w.url) && !done(this.statuses.get(w.url)))
      .filter((w) => parsePrUrl(w.url));
  }

  /** a timer sooner than one already set wins. a later one waits for it */
  private schedule(ms: number): void {
    const at = this.now() + ms;
    if (this.timer && this.due <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.due = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  /** one pass. exported for tests. one at a time */
  tick(): Promise<void> {
    this.ticking ??= this.tickOnce().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    if (!this.opts.enabled() || this.off || !this.opts.visible()) return;
    const want = this.open();
    if (!want.length) return;
    this.lastTick = this.now();
    const hosts = await this.loggedIn();
    if (!hosts) return;
    const refs = want.flatMap((w) => {
      const r = parsePrUrl(w.url);
      return r && hosts.has(r.host) ? [r] : [];
    });
    let changed = false;
    let failed = false;
    for (const host of new Set(refs.map((r) => r.host))) {
      for (const part of chunk(refs.filter((r) => r.host === host))) {
        const out = await this.ask(part, host);
        if (out === "off") return;
        if (!out) {
          failed = true;
          continue;
        }
        for (const [url, s] of out.found) {
          this.statuses.set(url, { ...s, checkedAt: this.now() });
          changed = true;
        }
        for (const url of out.missing) this.gone.add(url);
      }
    }
    const before = this.failures;
    this.failures = failed ? this.failures + 1 : 0;
    if (changed || before !== this.failures) {
      this.opts.onChange();
      void writeFileAtomic(
        this.opts.stateFile,
        JSON.stringify(Object.fromEntries(this.statuses)),
      ).catch((e) => log.warn("prs write:", e));
    }
    const working = want.some((w) => w.working);
    const every = working ? WORKING_MS : IDLE_MS;
    this.schedule(Math.min(every * 2 ** this.failures, MAX_MS));
  }

  private async exec(args: string[]): Promise<ClaudeRun> {
    const [bin, env] = await Promise.all([this.opts.ghBin(), this.opts.env()]);
    return this.run(bin, args, { cwd: os.tmpdir(), env, timeoutMs: RUN_TIMEOUT_MS });
  }

  private turnOff(why: string): void {
    this.off = { why, at: this.now() };
    this.problem(`off: ${why}`);
  }

  /** once per kind: a machine without gh would otherwise log on every focus */
  private problem(p: string): void {
    if (p !== this.lastProblem) log.warn("gh:", p);
    this.lastProblem = p;
  }

  private async loggedIn(): Promise<Set<string> | null> {
    if (this.hosts) return this.hosts;
    const out = await this.exec(["auth", "status", "--json", "hosts"]);
    const why = offReason(out);
    // an older gh has no --json here: logged in is all it can say, and github.com is the host
    const hosts = parseHosts(out.stdout) ?? (out.code === 0 ? new Set(["github.com"]) : null);
    if (why || !hosts?.size) {
      this.turnOff(why ?? "logged out");
      return null;
    }
    this.hosts = hosts;
    return hosts;
  }

  private async ask(
    refs: PrRef[],
    host: string,
  ): Promise<ReturnType<typeof parsePrResponse> | "off"> {
    const args = ["api", "graphql", "-f", `query=${prQuery(refs)}`];
    if (host !== "github.com") args.push("--hostname", host);
    const out = await this.exec(args);
    // a missing repo exits 1 with the others' data all the same
    const parsed = parsePrResponse(out.stdout, refs);
    if (parsed) {
      this.lastProblem = "";
      return parsed;
    }
    const why = offReason(out);
    if (why) {
      this.turnOff(why);
      return "off";
    }
    this.problem(`exit ${out.code}: ${(out.stderr || out.stdout).trim().slice(0, 200)}`);
    return null;
  }

  /**
   * the failed checks of a failing PR, for the panel. asked when the panel shows it, kept until
   * its rollup moves. never polled
   */
  async failingChecks(url: string): Promise<FailingCheck[]> {
    const e = this.statuses.get(url);
    const ref = parsePrUrl(url);
    if (!e || !ref || e.state !== "failing" || (e.rollup !== "FAILURE" && e.rollup !== "ERROR")) {
      return [];
    }
    const cached = this.checks.get(url);
    if (cached && cached.rollup === e.rollup) return cached.list;
    if (!this.opts.enabled() || this.off) return [];
    const pending = this.asking.get(url);
    if (pending) return pending;
    const p = (async () => {
      const args = ["api", "graphql", "-f", `query=${checksQuery(ref)}`];
      if (ref.host !== "github.com") args.push("--hostname", ref.host);
      const list = parseFailingChecks((await this.exec(args)).stdout);
      if (list) this.checks.set(url, { rollup: e.rollup, list });
      return list ?? [];
    })().finally(() => this.asking.delete(url));
    this.asking.set(url, p);
    return p;
  }

  /**
   * all the PR pane shows of one PR a session linked, asked fresh each time the pane asks (when it
   * opens, when the PR's rollup moves, when the window comes back). never polled. null: gh is off,
   * or did not answer
   */
  async info(url: string): Promise<PrInfo | null> {
    const ref = parsePrUrl(url);
    // only one a transcript linked: the renderer does not get to point gh anywhere
    if (!ref || !this.statuses.has(url) || !this.opts.enabled() || this.off) return null;
    const pending = this.infoAsking.get(url);
    if (pending) return pending;
    const p = (async () => {
      const args = ["api", "graphql", "-f", `query=${prInfoQuery(ref)}`];
      if (ref.host !== "github.com") args.push("--hostname", ref.host);
      const out = await this.exec(args);
      const info = parsePrInfo(out.stdout);
      if (!info)
        this.problem(
          `pr info exit ${out.code}: ${(out.stderr || out.stdout).trim().slice(0, 200)}`,
        );
      return info;
    })().finally(() => this.infoAsking.delete(url));
    this.infoAsking.set(url, p);
    return p;
  }
}
