import path from "node:path";
import {
  type AgentRun,
  type AgentSnapshot,
  assignCombos,
  type Combo,
  createSessionIndex,
  type Disposable,
  EMPTY_AGENT_SNAPSHOT,
  type LiveStatus,
  mapLimit,
  projectDirLabel,
  type SessionIndex,
  type SessionRecord,
  type SessionView,
  scanSessionAgents,
  textSnippet,
  tokenize,
  watchProjects,
} from "@grove/core";
import { rowHaystack } from "../../shared/haystack.ts";
import type { IndexStatus, SearchHit, SessionKey, SessionRow } from "../../shared/ipc.ts";
import { log } from "../log.ts";
import { diffRows, PatchCoalescer } from "../patchCoalescer.ts";

const PATCH_INTERVAL_MS = 150;
const FLUSH_DEBOUNCE_MS = 2000;
const PERIODIC_RESCAN_MS = 5 * 60_000;
const FOCUS_RESCAN_MS = 30_000;

export interface SessionServiceOptions {
  projectsDir: string;
  cacheDir: string;
  maxParsed?: number;
  emitPatch: (patch: { upserts: SessionRow[]; removes: SessionKey[]; replace: boolean }) => void;
  emitStatus: (status: IndexStatus) => void;
  /** a fresh look at one session's subagents, for whoever wants to say more about them */
  onAgents?: (key: SessionKey, snapshot: AgentSnapshot) => void;
}

function basename(p: string | undefined): string | undefined {
  return p ? path.basename(p) : undefined;
}

/** one pass over the records instead of a scan per row: this runs on every batch of a cold scan */
function labelsByProjectDir(records: readonly SessionRecord[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const r of records) {
    if (labels.has(r.projectDirName)) continue;
    labels.set(r.projectDirName, projectDirLabel(r.projectDirName, records));
  }
  return labels;
}

function toRow(
  record: SessionRecord & { comboName?: string },
  labels: ReadonlyMap<string, string>,
  live: ReadonlyMap<string, LiveStatus>,
  agents: ReadonlyMap<SessionKey, AgentSnapshot>,
  archived: ReadonlySet<string>,
): SessionRow {
  const cwd = record.relocatedCwd ?? record.cwd;
  const view = record as SessionView;
  const row: SessionRow = {
    key: record.path,
    sessionId: record.sessionId,
    projectLabel: labels.get(record.projectDirName) ?? record.projectDirName,
    activityMs: record.activityMs,
    parsed: record.parsed,
  };
  if (record.title) row.title = record.title;
  if (record.titleSource) row.titleSource = record.titleSource;
  if (record.firstPrompt) row.firstPrompt = record.firstPrompt;
  if (record.lastPrompt) row.lastPrompt = record.lastPrompt;
  if (cwd) {
    row.cwd = cwd;
    row.cwdBase = basename(cwd);
  }
  if (record.gitBranch) row.gitBranch = record.gitBranch;
  if (view.comboName) row.comboName = view.comboName;
  if (view.comboRelation) row.comboRelation = view.comboRelation;
  if (record.tag) row.tag = record.tag;
  if (record.pr) {
    row.prNumber = record.pr.number;
    if (record.pr.repo) row.prRepo = record.pr.repo;
  }
  if (record.entrypoint) row.entrypoint = record.entrypoint;
  if (record.usage) row.usage = record.usage;
  // by session id, so the same conversation reads as archived wherever its transcript ended up
  if (archived.has(record.sessionId)) row.archived = true;
  const status = live.get(record.sessionId);
  if (status) row.live = status;
  const found = agents.get(record.path);
  if (found && found.agents.length > 0) row.agents = found.agents;
  return row;
}

/**
 * the session index, plus everything that has to happen around it in a long-lived process:
 * coalesced patches to the renderer, a debounced cache write, and the directory watch that makes
 * a brand-new session show up without anyone asking.
 */
export class SessionService {
  private readonly index: SessionIndex;
  private readonly opts: SessionServiceOptions;
  private readonly patches: PatchCoalescer<SessionRow>;
  private rows = new Map<SessionKey, SessionRow>();
  private combos: Combo[] = [];
  private live: ReadonlyMap<string, LiveStatus> = new Map();
  private archived: ReadonlySet<string> = new Set();
  private runs: ReadonlyMap<string, Readonly<Record<string, AgentRun>>> = new Map();
  /** sessions with a process still running, busy or idle, whether or not a hook reports them */
  private alive: ReadonlySet<string> = new Set();
  /** every session's subagents, by transcript path. a session without any has no entry. */
  private agents = new Map<SessionKey, AgentSnapshot>();
  private scanning = new Set<SessionKey>();
  private watcher: Disposable | null = null;
  private periodic: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private again = false;
  private lastRescan = 0;
  private disposed = false;

  constructor(opts: SessionServiceOptions) {
    this.opts = opts;
    this.index = createSessionIndex({
      projectsDir: opts.projectsDir,
      cacheDir: opts.cacheDir,
      maxParsed: opts.maxParsed,
      persist: "always",
      usage: true,
      fullText: true,
    });
    this.patches = new PatchCoalescer<SessionRow>({
      intervalMs: PATCH_INTERVAL_MS,
      keyOf: (row) => row.key,
      emit: (patch) => opts.emitPatch(patch),
    });
  }

  /** the cache only. gives the first window something to draw before any directory is walked. */
  async loadCached(combos: Combo[]): Promise<SessionRow[]> {
    this.combos = combos;
    try {
      await this.index.load();
    } catch (e) {
      log.warn("session cache unreadable:", e);
    }
    this.rebuild();
    return [...this.rows.values()];
  }

  start(): void {
    this.watcher = watchProjects(this.opts.projectsDir, {
      onTranscript: (file) => void this.refreshFile(file),
      onSubagents: (file) => void this.refreshAgents(file),
      onRescan: () => void this.refresh(),
      onError: (e) => log.warn("session watch:", e),
    });
    this.periodic = setInterval(() => void this.refresh(), PERIODIC_RESCAN_MS);
    this.periodic.unref?.();
  }

  /** window focus and wake-ups. cheap enough to call often, so it is throttled rather than queued. */
  refreshThrottled(): void {
    if (Date.now() - this.lastRescan < FOCUS_RESCAN_MS) return;
    void this.refresh();
  }

  /** one refresh at a time. a request that arrives during one runs again after it. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.lastRescan = Date.now();
    this.refreshing = this.runRefresh().finally(() => {
      this.refreshing = null;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  private async runRefresh(): Promise<void> {
    this.opts.emitStatus({ phase: "scanning", done: 0, total: this.rows.size });
    try {
      const stats = await this.index.refresh({ onBatch: () => this.rebuild() });
      this.rebuild();
      // fs.watch coalesces and drops, so the periodic pass and window focus re-read them too
      await this.refreshAllAgents();
      this.opts.emitStatus({
        phase: this.index.health() === "degraded" ? "degraded" : "idle",
        done: stats.files - stats.unparsed,
        total: stats.files,
        ...(stats.unparsed > 0 ? { message: `${stats.unparsed} not parsed yet` } : {}),
      });
      this.scheduleFlush();
    } catch (e) {
      log.error("session refresh:", e);
      this.opts.emitStatus({ phase: "error", done: 0, total: this.rows.size, message: String(e) });
    }
  }

  private async refreshFile(file: string): Promise<void> {
    if (this.disposed) return;
    try {
      const { changed } = await this.index.refreshFile(file);
      // a metadata-only append moves the mtime but nothing a row shows. leave the list alone.
      if (changed) {
        this.rebuild();
        this.scheduleFlush();
      }
    } catch (e) {
      log.warn("session refresh of", file, e);
    }
  }

  /** somebody archived or un-archived something, or hand-edited archived.json */
  setArchived(ids: ReadonlySet<string>): void {
    this.archived = new Set(ids);
    this.rebuild();
  }

  /** combos changed: the same sessions, possibly in a different combo */
  reattribute(combos: Combo[]): void {
    this.combos = combos;
    this.rebuild();
  }

  /**
   * hook-reported status by session id, and the sessions whose process is still up. a session
   * resumed in two places shows on both rows.
   */
  setLive(
    live: ReadonlyMap<string, LiveStatus>,
    runs: ReadonlyMap<string, Readonly<Record<string, AgentRun>>> = new Map(),
    alive: ReadonlySet<string> = new Set(),
  ): void {
    const was = { live: this.live, runs: this.runs, alive: this.alive };
    this.live = new Map(live);
    this.runs = new Map(runs);
    this.alive = new Set(alive);
    this.rebuild();
    for (const row of this.rows.values()) {
      const id = row.sessionId;
      const wasLive = was.live.has(id) || was.alive.has(id);
      // a session that stopped has nothing running inside it any more, and one that started may
      // have. a subagent hook moved. the watcher covers everything else.
      if (wasLive !== this.isLive(id) || this.runs.get(id) !== was.runs.get(id)) {
        void this.refreshAgents(row.key);
      }
    }
  }

  /**
   * whether anything of this session can still be running. a hook status is not enough on its
   * own: a session no hook covers can sit idle while a background agent it started keeps working,
   * and only the live process registry sees that.
   */
  private isLive(sessionId: string): boolean {
    return this.live.has(sessionId) || this.alive.has(sessionId);
  }

  /**
   * one session's subagents, live or long finished - what the agents of a session from tuesday
   * did is a question worth an answer. the watcher, the live status and the periodic rescan all
   * land here.
   */
  private async refreshAgents(key: SessionKey): Promise<void> {
    if (this.disposed || this.scanning.has(key)) return;
    this.scanning.add(key);
    try {
      if (this.store(key, await this.scanAgents(key))) this.rebuild();
    } finally {
      this.scanning.delete(key);
    }
  }

  /**
   * every session at once, then one rebuild. not cached: the whole machine measured 11ms cold
   * (54 sessions, 76 agents), and a cache keyed on the session's transcript would go stale
   * exactly while a background agent is still writing and its parent is quiet.
   */
  private async refreshAllAgents(): Promise<void> {
    const keys = [...this.rows.keys()].filter((k) => !this.scanning.has(k));
    for (const k of keys) this.scanning.add(k);
    try {
      const scanned = await mapLimit(keys, 8, async (key) => ({
        key,
        snapshot: await this.scanAgents(key),
      }));
      let changed = false;
      for (const { key, snapshot } of scanned) changed = this.store(key, snapshot) || changed;
      if (changed) this.rebuild();
    } finally {
      for (const k of keys) this.scanning.delete(k);
    }
  }

  private async scanAgents(key: SessionKey): Promise<AgentSnapshot | null> {
    const row = this.rows.get(key);
    if (!row || this.disposed) return null;
    try {
      const runs = this.runs.get(row.sessionId);
      return await scanSessionAgents(key, {
        sessionLive: this.isLive(row.sessionId),
        prev: this.agents.get(key) ?? EMPTY_AGENT_SNAPSHOT,
        ...(runs ? { runs } : {}),
      });
    } catch (e) {
      log.warn("subagent scan of", key, e);
      return null;
    }
  }

  /** true when the rows need rebuilding. a session with no agents keeps no snapshot. */
  private store(key: SessionKey, snapshot: AgentSnapshot | null): boolean {
    if (!snapshot || this.disposed) return false;
    if (snapshot.agents.length === 0) {
      if (!this.agents.delete(key)) return false;
      this.opts.onAgents?.(key, snapshot);
      return true;
    }
    this.agents.set(key, snapshot);
    this.opts.onAgents?.(key, snapshot);
    return true;
  }

  /** the last scan of one session's agents, with the file each one writes to */
  agentSnapshot(key: SessionKey): AgentSnapshot | undefined {
    return this.agents.get(key);
  }

  /** one agent's summary. dropped when the agent finished while the model was still thinking. */
  applySummary(key: SessionKey, agentId: string, summary: string, at: number): void {
    const snapshot = this.agents.get(key);
    const agent = snapshot?.agents.find((a) => a.id === agentId);
    if (!snapshot || !agent || agent.state !== "running") return;
    this.agents.set(key, {
      ...snapshot,
      agents: snapshot.agents.map((a) => (a.id === agentId ? { ...a, summary, summaryAt: at } : a)),
    });
    this.rebuild();
  }

  byId(sessionId: string): SessionRow[] {
    return [...this.rows.values()].filter((r) => r.sessionId === sessionId);
  }

  /**
   * rows whose conversation holds every word, that the renderer's instant filter over titles and
   * prompts did not already find. a word may match the row's own fields or its text.
   */
  async search(query: string): Promise<SearchHit[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const texts = await this.index.texts();
    const hits: SearchHit[] = [];
    for (const row of this.rows.values()) {
      const hay = rowHaystack(row);
      const missing = tokens.filter((t) => !hay.includes(t));
      if (missing.length === 0) continue;
      const doc = texts.get(row.key);
      if (!doc || !missing.every((t) => doc.lower.includes(t))) continue;
      hits.push({ key: row.key, snippet: textSnippet(doc, missing) ?? "" });
    }
    return hits;
  }

  list(): SessionRow[] {
    return [...this.rows.values()];
  }

  get(key: SessionKey): SessionRow | undefined {
    return this.rows.get(key);
  }

  status(): IndexStatus {
    const health = this.index.health();
    return {
      phase: health === "degraded" ? "degraded" : "idle",
      done: this.rows.size,
      total: this.rows.size,
    };
  }

  private rebuild(): void {
    const records = this.index.list().filter((r) => !r.stub);
    const views = assignCombos(records, this.combos);
    const labels = labelsByProjectDir(records);
    const next = views.map((v) => toRow(v, labels, this.live, this.agents, this.archived));
    const { upserts, removes } = diffRows(this.rows, next, (row) => row.key);
    if (upserts.length === 0 && removes.length === 0) return;
    this.rows = new Map(next.map((row) => [row.key, row]));
    this.patches.upsert(upserts);
    this.patches.remove(removes);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.index.flush().catch((e) => log.warn("session cache write:", e));
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.watcher?.dispose();
    if (this.periodic) clearInterval(this.periodic);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.patches.dispose();
    await this.index.flush().catch(() => {});
  }
}
