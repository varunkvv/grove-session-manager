import path from "node:path";
import {
  assignCombos,
  type Combo,
  createSessionIndex,
  type Disposable,
  projectDirLabel,
  type SessionIndex,
  type SessionRecord,
  type SessionView,
  watchProjects,
} from "@grove/core";
import type { IndexStatus, SessionKey, SessionRow } from "../../shared/ipc.ts";
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

  /** combos changed: the same sessions, possibly in a different combo */
  reattribute(combos: Combo[]): void {
    this.combos = combos;
    this.rebuild();
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
    const next = views.map((v) => toRow(v, labels));
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
