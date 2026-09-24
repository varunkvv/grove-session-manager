import { existsSync, type FSWatcher, watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type AgentRun,
  applyBackground,
  applyRegistry,
  type BackgroundEntry,
  type Disposable,
  drainStatusEvents,
  isObject,
  type LiveStatus,
  needsYou,
  type RegistryEntry,
  readJsonGuarded,
  readRegistry,
  reduceAgentRuns,
  reduceStatus,
  statusEventsDir,
  syncStatusHooks,
  watchStatusHooks,
  writeFileAtomic,
} from "@grove/core";
import { log } from "../log.ts";
import {
  expireInterruptions,
  INTERRUPTED_FILE,
  type Interruption,
  parseInterruptions,
  vanished,
} from "./interrupted.ts";

const POLL_MS = 10_000;
const PERSIST_DEBOUNCE_MS = 1000;
/** the registry dir appears the first time a session starts. wait for it, never make it. */
const REGISTRY_RETRY_MS = 30_000;
/** a session that went quiet this long while "running" has probably been closed without a goodbye */
export const RUNNING_STALE_MS = 45 * 60_000;
/** nobody is coming back to a "your turn" from last week */
export const WAITING_EXPIRY_MS = 3 * 24 * 3_600_000;

export interface LiveServiceOptions {
  stateDir: string;
  /** Claude Code's user settings file. only touched when tracking every session is switched on. */
  claudeSettingsFile: string;
  /** `<claudeConfigDir>/sessions`, where every live process keeps a file. read-only. */
  registryDir: string;
  onChange: (
    statuses: ReadonlyMap<string, LiveStatus>,
    agentRuns: ReadonlyMap<string, Readonly<Record<string, AgentRun>>>,
    /** sessions whose process is up, busy or idle. never a state of its own - see applyRegistry. */
    alive: ReadonlySet<string>,
  ) => void;
  /** a session just started needing someone */
  onNeedsYou: (sessionId: string, status: LiveStatus) => void;
  /**
   * a background session's process came, went, or changed its status. the registry cannot say
   * what it is doing - only `claude agents --json` can - so this is when to ask it.
   */
  onBackgroundMoved?: () => void;
  /** sessions whose process went away mid-turn, and when grove noticed. kept across restarts. */
  onInterrupted?: (interrupted: ReadonlyMap<string, Interruption>) => void;
  now?: () => number;
  /** the user settings watch's debounce. only a test passes anything else. */
  hookDebounceMs?: number;
}

/**
 * drops what is too old to be true any more. pure, so it is testable without a clock. a running
 * session gone quiet this long has most likely lost its process: `onStale` hears about each one.
 */
export function expireStatuses(
  statuses: Map<string, LiveStatus>,
  now: number,
  onStale?: (sessionId: string) => void,
): boolean {
  let changed = false;
  for (const [id, s] of statuses) {
    // a registry entry is a live process, not a guess with a shelf life. it goes when the pid does.
    // the supervisor's word goes when the supervisor says otherwise.
    if (s.source) continue;
    const stale =
      s.state === "running"
        ? now - s.lastEventAt > RUNNING_STALE_MS
        : now - s.at > WAITING_EXPIRY_MS;
    if (stale) {
      if (s.state === "running") onStale?.(id);
      statuses.delete(id);
      changed = true;
    }
  }
  return changed;
}

/**
 * what each live session is doing, from the hook events Claude Code drops into `.grove/events/`.
 * the events are the source, this map is only their sum, persisted so a restart keeps the inbox.
 */
export class LiveService {
  private readonly opts: LiveServiceOptions;
  private readonly eventsDir: string;
  private readonly stateFile: string;
  private statuses = new Map<string, LiveStatus>();
  /** by session id: what the subagent hooks said about each of its agents. never persisted. */
  private runs = new Map<string, Record<string, AgentRun>>();
  /** session ids with a live process, from the last registry read */
  private alive = new Set<string>();
  /** the last registry read, by session id: who holds each live session */
  private holders = new Map<string, RegistryEntry>();
  /** background processes and their statuses, as of the last registry read */
  private backgroundKey = "";
  /** the first word from the supervisor lands without a notification, like events from before start */
  private backgroundRead = false;
  /** sessions last seen running whose process went away. a quiet marker, never the inbox. */
  private interrupted = new Map<string, Interruption>();
  private readonly interruptedFile: string;
  private watcher: FSWatcher | null = null;
  private registryWatcher: FSWatcher | null = null;
  private registryRetry: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private disposed = false;
  /** whether our hooks belong in Claude Code's own settings.json: the setting, as last applied */
  private tracking = false;
  private userHooks: Disposable | null = null;

  constructor(opts: LiveServiceOptions) {
    this.opts = opts;
    this.eventsDir = statusEventsDir(opts.stateDir);
    this.stateFile = path.join(opts.stateDir, "live-status.json");
    this.interruptedFile = path.join(opts.stateDir, INTERRUPTED_FILE);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    const read = await readJsonGuarded<Record<string, LiveStatus>>(this.stateFile);
    if (read.status === "ok" && isObject(read.value)) {
      for (const [id, s] of Object.entries(read.value)) {
        // a registry state is only true while the process is up. it is re-derived, never restored.
        if (isObject(s) && typeof s.state === "string" && typeof s.at === "number" && !s.source) {
          this.statuses.set(id, s as LiveStatus);
        }
      }
    }
    const kept = await readJsonGuarded(this.interruptedFile);
    if (kept.status === "ok") this.interrupted = parseInterruptions(kept.value);
    expireInterruptions(this.interrupted, this.now());
    // a session that was running when the app last looked, and has been quiet since: after a
    // reboot this is the only one of the three signals that is there
    expireStatuses(this.statuses, this.now(), (id) => this.interrupt([id]));
    await mkdir(this.eventsDir, { recursive: true }).catch(() => {});
    // events that arrived while the app was closed: they update state but do not notify
    await this.drain(false);
    // before the first paint, so a session that died while the app was closed never shows as running
    await this.syncRegistry();
    this.opts.onChange(this.statuses, this.runs, this.alive);
    this.opts.onInterrupted?.(this.interrupted);
    try {
      this.watcher = watch(this.eventsDir, () => void this.drain(true));
      this.watcher.on("error", (e) => log.warn("status watch:", e));
    } catch (e) {
      log.warn("status watch:", e);
    }
    this.watchRegistry();
    // FSEvents can coalesce or drop. the poll also ages out stale states.
    this.poll = setInterval(() => {
      const stale: string[] = [];
      const expired = expireStatuses(this.statuses, this.now(), (id) => stale.push(id));
      this.interrupt(stale);
      if (expireInterruptions(this.interrupted, this.now()) || expired) this.changed();
      void this.drain(true);
      void this.syncRegistry();
    }, POLL_MS);
    this.poll.unref?.();
  }

  /** the live processes, folded in under the hook state. see applyRegistry for who wins. */
  private async syncRegistry(): Promise<void> {
    const entries = await readRegistry(this.opts.registryDir).catch(() => []);
    // an idle process changes no status, but a background agent of its can still be working
    const alive = new Set(entries.map((e) => e.sessionId));
    const moved = alive.size !== this.alive.size || [...alive].some((id) => !this.alive.has(id));
    this.alive = alive;
    // an empty read clears nothing, same as applyRegistry: it means no registry, not no sessions
    if (entries.length > 0) this.holders = new Map(entries.map((e) => [e.sessionId, e]));
    const before = new Map(this.statuses);
    const applied = applyRegistry(this.statuses, entries, this.now());
    // running a moment ago and no process now: it did not end its turn, it lost its process
    const gone = vanished(before, this.statuses, alive);
    const back = [...alive].filter((id) => this.interrupted.has(id));
    this.interrupt(gone);
    this.resume(back);
    if (applied || moved || gone.length > 0 || back.length > 0) this.changed();
    const background = entries
      .filter((e) => e.kind === "bg")
      .map((e) => `${e.sessionId}:${e.status}`)
      .sort()
      .join(",");
    if (background !== this.backgroundKey) {
      this.backgroundKey = background;
      this.opts.onBackgroundMoved?.();
    }
  }

  /** the sessions whose process went away mid-turn */
  interruptions(): ReadonlyMap<string, Interruption> {
    return this.interrupted;
  }

  private interrupt(ids: readonly string[]): void {
    const at = this.now();
    for (const id of ids) this.interrupted.set(id, { at });
  }

  /** alive again: an event from it, a process, or grove handing it to the supervisor */
  private resume(ids: readonly string[]): boolean {
    let changed = false;
    for (const id of ids) changed = this.interrupted.delete(id) || changed;
    return changed;
  }

  /** grove just handed it to Claude Code's supervisor: not interrupted any more */
  clearInterrupted(sessionId: string): void {
    if (this.resume([sessionId])) this.changed();
  }

  /**
   * the live process holding a session, if any: an `interactive` one is a panel or a terminal,
   * a `bg` one is Claude Code's supervisor. from the last registry read, so a moment old.
   */
  holder(sessionId: string): RegistryEntry | undefined {
    return this.holders.get(sessionId);
  }

  /**
   * what `claude agents --json` said, by session id. only a real answer comes here - an unknown
   * one changes nothing. see applyBackground for who wins.
   */
  applyBackground(entries: ReadonlyMap<string, BackgroundEntry>): void {
    const notify = this.backgroundRead;
    this.backgroundRead = true;
    const before = new Map(this.statuses);
    if (!applyBackground(this.statuses, entries, this.now())) return;
    this.changed();
    if (notify) this.notifyEntered(before);
  }

  /** never creates the directory: nothing of ours goes inside Claude Code's config dir. */
  private watchRegistry(): void {
    if (this.disposed || this.registryWatcher) return;
    this.registryRetry = null;
    if (!existsSync(this.opts.registryDir)) {
      this.registryRetry = setTimeout(() => this.watchRegistry(), REGISTRY_RETRY_MS);
      this.registryRetry.unref?.();
      return;
    }
    try {
      this.registryWatcher = watch(this.opts.registryDir, () => void this.syncRegistry());
      this.registryWatcher.on("error", (e) => {
        log.warn("session registry watch:", e);
        this.registryWatcher?.close();
        this.registryWatcher = null;
      });
    } catch (e) {
      log.warn("session registry watch:", e);
    }
  }

  list(): ReadonlyMap<string, LiveStatus> {
    return this.statuses;
  }

  /** the subagent starts and stops the hooks reported, by session id */
  agentRuns(): ReadonlyMap<string, Readonly<Record<string, AgentRun>>> {
    return this.runs;
  }

  markSeen(sessionIds: Iterable<string>): void {
    let changed = false;
    for (const id of sessionIds) {
      const s = this.statuses.get(id);
      if (s && needsYou(s)) {
        this.statuses.set(id, { ...s, seen: true });
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /**
   * hooks for every session on the machine, in Claude Code's own user settings. opt-in. while it
   * is on the file is watched: a session running outside any combo writes the settings it loaded
   * at startup back over ours, exactly as a combo's session does. only our marked entries are
   * ever touched - it is the one file under ~/.claude this app writes.
   */
  async trackAllSessions(enabled: boolean): Promise<void> {
    this.tracking = enabled;
    if (!enabled) {
      this.userHooks?.dispose();
      this.userHooks = null;
    }
    const r = await syncStatusHooks(this.opts.claudeSettingsFile, this.eventsDir, enabled);
    if (r.warning) throw new Error(r.warning.message);
    if (r.status === "skipped-unexpected-shape") {
      throw new Error(
        `${this.opts.claudeSettingsFile} has an unexpected shape, so it was left alone.`,
      );
    }
    this.watchUserHooks();
  }

  /** window focus: catches a revert the watch missed, or one made while the app was closed */
  async syncUserHooks(): Promise<void> {
    if (!this.tracking || this.disposed) return;
    await syncStatusHooks(this.opts.claudeSettingsFile, this.eventsDir, true).catch((e) =>
      log.warn("user status hooks:", e),
    );
    this.watchUserHooks();
  }

  /** idempotent. null until the config dir exists - the next sync tries again, nothing retries. */
  private watchUserHooks(): void {
    if (!this.tracking || this.disposed || this.userHooks) return;
    this.userHooks = watchStatusHooks(this.opts.claudeSettingsFile, this.eventsDir, {
      ...(this.opts.hookDebounceMs !== undefined ? { debounceMs: this.opts.hookDebounceMs } : {}),
      onError: (e) => log.warn("user status hook watch:", e),
    });
  }

  private drain(notify: boolean): Promise<void> {
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = this.runDrain(notify).finally(() => {
      this.draining = null;
      if (this.again) {
        this.again = false;
        void this.drain(notify);
      }
    });
    return this.draining;
  }

  private async runDrain(notify: boolean): Promise<void> {
    const events = await drainStatusEvents(this.eventsDir);
    if (events.length === 0) return;
    const before = new Map(this.statuses);
    for (const ev of events) {
      const prev = this.statuses.get(ev.sessionId);
      // the session ended mid-turn: a window closed on it. anything else it says means it lives.
      if (ev.event === "SessionEnd" && prev?.state === "running") this.interrupt([ev.sessionId]);
      else if (ev.event !== "SessionEnd") this.resume([ev.sessionId]);
      const next = reduceStatus(prev, ev);
      if (next) this.statuses.set(ev.sessionId, next);
      else this.statuses.delete(ev.sessionId);
      const runs = reduceAgentRuns(this.runs.get(ev.sessionId), ev);
      if (runs) this.runs.set(ev.sessionId, runs);
      else this.runs.delete(ev.sessionId);
    }
    expireStatuses(this.statuses, this.now());
    this.changed();
    if (notify) this.notifyEntered(before);
  }

  private notifyEntered(before: ReadonlyMap<string, LiveStatus>): void {
    for (const [id, s] of this.statuses) {
      const was = before.get(id);
      const entered = needsYou(s) && (!needsYou(was) || was?.state !== s.state || was.at !== s.at);
      if (entered) this.opts.onNeedsYou(id, s);
    }
  }

  private persistInterrupted(): Promise<void> {
    return writeFileAtomic(
      this.interruptedFile,
      JSON.stringify(Object.fromEntries(this.interrupted)),
    ).catch((e) => log.warn("interrupted write:", e));
  }

  /** only what a restart should believe. a registry state is re-read from the live processes. */
  private persistable(): string {
    return JSON.stringify(Object.fromEntries([...this.statuses].filter(([, s]) => !s.source)));
  }

  private changed(): void {
    this.opts.onChange(this.statuses, this.runs, this.alive);
    this.opts.onInterrupted?.(this.interrupted);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void writeFileAtomic(this.stateFile, this.persistable()).catch((e) =>
        log.warn("status write:", e),
      );
      void this.persistInterrupted();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.userHooks?.dispose();
    this.userHooks = null;
    this.watcher?.close();
    this.registryWatcher?.close();
    if (this.registryRetry) clearTimeout(this.registryRetry);
    if (this.poll) clearInterval(this.poll);
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      void writeFileAtomic(this.stateFile, this.persistable()).catch(() => {});
      void this.persistInterrupted();
    }
  }
}
