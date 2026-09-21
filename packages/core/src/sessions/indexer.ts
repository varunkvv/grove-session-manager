import { readFile } from "node:fs/promises";
import path from "node:path";
import { isObject, mapLimit } from "../fsx.ts";
import { parseTranscript } from "../transcript/parse.ts";
import { readHeadTail } from "../transcript/reader.ts";
import { pickTitle } from "../transcript/title.ts";
import { summarizeUsage } from "../transcript/usage.ts";
import type { ParsedMeta, SessionRecord } from "../types.ts";
import { type CacheEntry, cacheKey, loadCache, saveCache, sweepOldCaches } from "./cache.ts";
import { TextStore } from "./fulltext.ts";
import { type FileStat, scanProjects, sidecarTitlePath, statTranscript } from "./scan.ts";
import { type SessionTallies, scanSessionUsage } from "./usage.ts";

export interface SessionIndexOptions {
  projectsDir: string;
  /** null disables the cache file */
  cacheDir: string | null;
  /** parse work per refresh. cache hits do not count. files over the cap stay listed, unparsed. */
  maxParsed?: number;
  concurrency?: number;
  /** 'if-cold': write only after a refresh that had to parse a lot. keeps one writer in steady state. */
  persist?: "always" | "if-cold" | "never";
  /** count tokens per model. reads every transcript in full once, so it is opt-in. */
  usage?: boolean;
  /** keep the conversation text for search. rides on the usage pass, so it needs `usage`. */
  fullText?: boolean;
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

const USAGE_CONCURRENCY = 4;

function toRecord(s: FileStat, meta: ParsedMeta | null, usage?: SessionTallies): SessionRecord {
  const m: ParsedMeta = meta ?? { recognized: 0 };
  const models = usage ? summarizeUsage(Object.values(usage)) : [];
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
    ...(models.length ? { usage: models } : {}),
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
    r.usage,
  ]);
}

export class SessionIndex {
  readonly projectsDir: string;
  private readonly cacheDir: string | null;
  private readonly maxParsed: number;
  private readonly concurrency: number;
  private readonly persist: "always" | "if-cold" | "never";
  private readonly usage: boolean;
  private readonly text: TextStore | null;
  private readonly inflight = new Map<string, Promise<SessionRecord | undefined>>();
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
    this.usage = opts.usage ?? false;
    this.text =
      this.usage && opts.fullText
        ? new TextStore(opts.cacheDir ? path.join(opts.cacheDir, "text") : null)
        : null;
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
        next.set(s.path, toRecord(s, hit.meta, hit.usage?.files));
        cacheHits++;
      } else {
        // listed straight away by time and path. the parse below upgrades it in place.
        next.set(s.path, toRecord(s, null, hit?.usage?.files));
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
      const usage = this.cache.get(s.path)?.usage;
      if (meta) {
        this.cache.set(s.path, { key: cacheKey(s), meta, ...(usage ? { usage } : {}) });
        this.dirty = true;
      }
      const rec = toRecord(s, meta, usage?.files);
      this.records.set(s.path, rec);
      pending.push(rec);
      if (pending.length >= 50 || Date.now() - lastEmit > 100) {
        opts.onBatch?.(pending);
        pending = [];
        lastEmit = Date.now();
      }
    });
    if (pending.length) opts.onBatch?.(pending);

    if (this.usage) await this.countUsage(stats, opts);
    if (this.text && !opts.signal?.aborted) void this.text.sweep(stats.map((s) => s.path));

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

  /**
   * a second pass, after every row already has its title: reading whole files is the slow part,
   * and nobody should wait on it to see their sessions. newest first, like the parse.
   */
  private async countUsage(stats: FileStat[], opts: RefreshOptions): Promise<void> {
    const todo = stats.filter((s) => this.needsScan(s));
    let pending: SessionRecord[] = [];
    let lastEmit = Date.now();
    await mapLimit(todo, USAGE_CONCURRENCY, async (s) => {
      if (opts.signal?.aborted) return;
      const rec = await this.updateUsage(s);
      if (!rec) return;
      pending.push(rec);
      if (pending.length >= 50 || Date.now() - lastEmit > 250) {
        opts.onBatch?.(pending);
        pending = [];
        lastEmit = Date.now();
      }
    });
    if (pending.length) opts.onBatch?.(pending);
  }

  private needsScan(s: FileStat): boolean {
    const entry = this.cache.get(s.path);
    if (!this.usage || !entry) return false;
    if (entry.usage?.key !== cacheKey(s)) return true;
    // counted before search was kept: read once more to build the text
    return this.text !== null && entry.usage.textChars === undefined;
  }

  /**
   * subagent files are re-read when the session's own transcript changes, not on their own: the
   * watcher only sees top-level transcripts, and a subagent finishing always appends to its parent.
   */
  private async updateUsage(s: FileStat): Promise<SessionRecord | undefined> {
    // one scan per file at a time: two at once would both append the same text
    const running = this.inflight.get(s.path);
    if (running) await running.catch(() => undefined);
    const job = this.scanOne(s);
    this.inflight.set(s.path, job);
    try {
      return await job;
    } finally {
      if (this.inflight.get(s.path) === job) this.inflight.delete(s.path);
    }
  }

  private async scanOne(s: FileStat): Promise<SessionRecord | undefined> {
    const entry = this.cache.get(s.path);
    if (!entry) return undefined;
    let prev = entry.usage?.files;
    let sink: ReturnType<TextStore["sink"]> | undefined;
    if (this.text) {
      // the stored text has to be exactly what the offset says was read, or it is rebuilt from 0
      const have = await this.text.ensure(s.path);
      if (prev?.[""] && entry.usage?.textChars !== have) {
        const { "": _, ...subagents } = prev;
        prev = subagents;
      }
      sink = this.text.sink(s.path);
    }
    const files = await scanSessionUsage(s.path, prev, sink);
    // the file may have been removed or re-parsed meanwhile. only land on the entry we started from.
    if (this.cache.get(s.path) !== entry) return undefined;
    const textChars = sink && files[""] ? await sink.commit() : undefined;
    entry.usage = { key: cacheKey(s), files, ...(textChars !== undefined ? { textChars } : {}) };
    this.dirty = true;
    const rec = toRecord(s, entry.meta, files);
    if (this.records.has(s.path)) this.records.set(s.path, rec);
    return rec;
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
        this.cache.set(file, {
          key: cacheKey(s),
          meta,
          ...(hit?.usage ? { usage: hit.usage } : {}),
        });
        this.dirty = true;
      }
    }
    let record = toRecord(s, meta, hit?.usage?.files);
    this.records.set(file, record);
    if (this.needsScan(s)) {
      record = (await this.updateUsage(s)) ?? record;
    }
    return { changed: !before || displayKey(before) !== displayKey(record), record };
  }

  /** every session's conversation text, loaded from the cache dir on first use */
  async texts(): Promise<Map<string, { text: string; lower: string }>> {
    const out = new Map<string, { text: string; lower: string }>();
    if (!this.text) return out;
    const text = this.text;
    await mapLimit([...this.records.keys()], 16, async (p) => {
      const have = await text.ensure(p);
      const want = this.cache.get(p)?.usage?.textChars;
      // the text dir was cleared under a transcript that has not changed since: read it again
      if (want !== undefined && want !== have) {
        const s = await statTranscript(p);
        if (s) await this.updateUsage(s);
      }
    });
    for (const p of this.records.keys()) {
      const doc = this.text.get(p);
      if (doc) out.set(p, doc);
    }
    return out;
  }

  removeFile(file: string): boolean {
    void this.text?.remove(file);
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
