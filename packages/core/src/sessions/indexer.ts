import { readFile } from "node:fs/promises";
import { isObject, mapLimit } from "../fsx.ts";
import { parseTranscript } from "../transcript/parse.ts";
import { readHeadTail } from "../transcript/reader.ts";
import { pickTitle } from "../transcript/title.ts";
import type { ParsedMeta, SessionRecord } from "../types.ts";
import { type CacheEntry, cacheKey, loadCache, saveCache, sweepOldCaches } from "./cache.ts";
import { type FileStat, scanProjects, sidecarTitlePath, statTranscript } from "./scan.ts";

export interface SessionIndexOptions {
  projectsDir: string;
  /** null disables the cache file */
  cacheDir: string | null;
  /** parse work per refresh. cache hits do not count. files over the cap stay listed, unparsed. */
  maxParsed?: number;
  concurrency?: number;
  /** 'if-cold': write only after a refresh that had to parse a lot. keeps one writer in steady state. */
  persist?: "always" | "if-cold" | "never";
}

export interface RefreshStats {
  files: number;
  cacheHits: number;
  parsed: number;
  unparsed: number;
  removed: number;
}

export interface RefreshOptions {
  signal?: AbortSignal;
  /** called with the stat-only + cached listing first, then as parsed batches land */
  onBatch?: (records: SessionRecord[]) => void;
}

export type IndexHealth = "ok" | "degraded" | "empty";

const COLD_THRESHOLD = 20;

function toRecord(s: FileStat, meta: ParsedMeta | null): SessionRecord {
  const m: ParsedMeta = meta ?? { recognized: 0 };
  return {
    ...m,
    ...pickTitle(m),
    path: s.path,
    projectDirName: s.projectDirName,
    sessionId: m.sessionId ?? s.stem,
    mtimeMs: s.mtimeMs,
    size: s.size,
    parsed: meta !== null,
    activityMs: m.lastActivityMs ?? s.mtimeMs,
  };
}

async function readSidecarTitle(s: FileStat): Promise<string | undefined> {
  if (!s.sidecarMtimeMs) return undefined;
  try {
    const v: unknown = JSON.parse(await readFile(sidecarTitlePath(s.path), "utf8"));
    return isObject(v) && typeof v.customTitle === "string" ? v.customTitle : undefined;
  } catch {
    return undefined;
  }
}

async function parseFile(s: FileStat): Promise<ParsedMeta | null> {
  try {
    const { head, tail } = await readHeadTail(s.path);
    return parseTranscript(head, tail, await readSidecarTitle(s));
  } catch {
    return null;
  }
}

/** fields a row shows or searches. a metadata-only append changes mtime but none of these. */
function displayKey(r: SessionRecord): string {
  return JSON.stringify([
    r.title,
    r.titleSource,
    r.firstPrompt,
    r.lastPrompt,
    r.cwd,
    r.relocatedCwd,
    r.gitBranch,
    r.tag,
    r.pr?.number,
    r.activityMs,
    r.parsed,
    r.entrypoint,
  ]);
}

export class SessionIndex {
  readonly projectsDir: string;
  private readonly cacheDir: string | null;
  private readonly maxParsed: number;
  private readonly concurrency: number;
  private readonly persist: "always" | "if-cold" | "never";
  private cache = new Map<string, CacheEntry>();
  private records = new Map<string, SessionRecord>();
  private dirty = false;
  private saving: Promise<void> | null = null;

  constructor(opts: SessionIndexOptions) {
    this.projectsDir = opts.projectsDir;
    this.cacheDir = opts.cacheDir;
    this.maxParsed = opts.maxParsed ?? 5000;
    this.concurrency = opts.concurrency ?? 16;
    this.persist = opts.persist ?? "always";
  }

  /** cache only, no filesystem walk. lets a UI paint before the first refresh finishes. */
  async load(): Promise<void> {
    if (!this.cacheDir) return;
    this.cache = await loadCache(this.cacheDir, this.projectsDir);
    void sweepOldCaches(this.cacheDir);
  }

  async refresh(opts: RefreshOptions = {}): Promise<RefreshStats> {
    const stats = await scanProjects(this.projectsDir);
    const next = new Map<string, SessionRecord>();
    const misses: FileStat[] = [];
    let cacheHits = 0;

    for (const s of stats) {
      const hit = this.cache.get(s.path);
      if (hit && hit.key === cacheKey(s)) {
        next.set(s.path, toRecord(s, hit.meta));
        cacheHits++;
      } else {
        // listed straight away by time and path. the parse below upgrades it in place.
        next.set(s.path, toRecord(s, null));
        misses.push(s);
      }
    }

    const removed = [...this.records.keys()].filter((p) => !next.has(p)).length;
    for (const p of this.cache.keys()) {
      if (!next.has(p)) {
        this.cache.delete(p);
        this.dirty = true;
      }
    }
    this.records = next;
    opts.onBatch?.(this.list());

    // stats are newest first, so the cap spends its budget on the sessions people look for
    const toParse = misses.slice(0, this.maxParsed);
    let pending: SessionRecord[] = [];
    let lastEmit = Date.now();
    await mapLimit(toParse, this.concurrency, async (s) => {
      if (opts.signal?.aborted) return;
      const meta = await parseFile(s);
      if (meta) {
        this.cache.set(s.path, { key: cacheKey(s), meta });
        this.dirty = true;
      }
      const rec = toRecord(s, meta);
      this.records.set(s.path, rec);
      pending.push(rec);
      if (pending.length >= 50 || Date.now() - lastEmit > 100) {
        opts.onBatch?.(pending);
        pending = [];
        lastEmit = Date.now();
      }
    });
    if (pending.length) opts.onBatch?.(pending);

    const cold = toParse.length >= COLD_THRESHOLD;
    if (this.persist === "always" || (this.persist === "if-cold" && cold)) await this.flush();

    return {
      files: stats.length,
      cacheHits,
      parsed: toParse.length,
      unparsed: misses.length - toParse.length,
      removed,
    };
  }

  /** one file changed on disk. `changed` is false when nothing a row displays moved. */
  async refreshFile(file: string): Promise<{ changed: boolean; record?: SessionRecord }> {
    const s = await statTranscript(file);
    if (!s) return { changed: this.removeFile(file) };
    const before = this.records.get(file);
    const hit = this.cache.get(file);
    let meta: ParsedMeta | null;
    if (hit && hit.key === cacheKey(s)) {
      meta = hit.meta;
    } else {
      meta = await parseFile(s);
      if (meta) {
        this.cache.set(file, { key: cacheKey(s), meta });
        this.dirty = true;
      }
    }
    const record = toRecord(s, meta);
    this.records.set(file, record);
    return { changed: !before || displayKey(before) !== displayKey(record), record };
  }

  removeFile(file: string): boolean {
    const had = this.records.delete(file);
    if (this.cache.delete(file)) this.dirty = true;
    return had;
  }

  /** newest activity first */
  list(): SessionRecord[] {
    return [...this.records.values()].sort((a, b) => b.activityMs - a.activityMs);
  }

  get(file: string): SessionRecord | undefined {
    return this.records.get(file);
  }

  byId(sessionId: string): SessionRecord[] {
    return this.list().filter((r) => r.sessionId === sessionId);
  }

  /** 'degraded' when most parsed files gave us nothing: the transcript shape has probably moved. */
  health(): IndexHealth {
    const parsed = [...this.records.values()].filter((r) => r.parsed);
    if (parsed.length === 0) return this.records.size === 0 ? "empty" : "degraded";
    const blind = parsed.filter((r) => !r.cwd && !r.title && r.recognized === 0).length;
    return blind > parsed.length / 2 ? "degraded" : "ok";
  }

  async flush(): Promise<void> {
    if (!this.cacheDir || !this.dirty || this.persist === "never") return;
    if (this.saving) await this.saving;
    this.dirty = false;
    this.saving = saveCache(this.cacheDir, this.projectsDir, this.cache)
      .catch(() => {
        this.dirty = true;
      })
      .finally(() => {
        this.saving = null;
      });
    await this.saving;
  }
}

export function createSessionIndex(opts: SessionIndexOptions): SessionIndex {
  return new SessionIndex(opts);
}
