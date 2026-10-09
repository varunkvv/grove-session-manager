import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { isObject, readJsonGuarded, writeFileAtomic } from "../fsx.ts";
import { PARSER_VERSION } from "../transcript/parse.ts";
import type { DayTally } from "../transcript/usage.ts";
import type { ParsedMeta } from "../types.ts";
import type { SessionTallies } from "./usage.ts";

/**
 * what a usage scan keeps per file. an entry counted under another number is counted again from
 * the start of its transcript, once: 2 is the first with day buckets, the advisor's tokens, the
 * 5m / 1h cache split and working time
 */
export const USAGE_SCHEMA = 2;

export interface CacheEntry {
  key: string;
  meta: ParsedMeta;
  /**
   * token counts, with their own key: they are worked out in a later, slower pass, and a re-parse
   * of the head and tail must not throw away the offsets that make the next count incremental.
   */
  usage?: {
    /** USAGE_SCHEMA when it was counted */
    v?: number;
    key: string;
    files: SessionTallies;
    textChars?: number;
    /** per subagent tally key: the chars of its text kept, for the same check textChars is */
    agentText?: Record<string, number>;
  };
}

export interface CacheFile {
  projectsDir: string;
  entries: Record<string, CacheEntry>;
}

/**
 * a session whose transcript is gone: Claude Code deletes old ones, and so does deleting a
 * project. its day buckets stay, with what places it in a project (membership is by cwd)
 */
export interface RetiredEntry {
  sessionId: string;
  cwd?: string;
  projectDirName: string;
  /** per file under the session, as SessionTallies keys them */
  files: Record<string, Record<string, DayTally>>;
}

/**
 * its own file, with no parser version in the name: an index can be read again from the
 * transcripts, and this cannot. a new parser version must not sweep it away
 */
const RETIRED_FILE = "usage-retired.json";

/**
 * the parser version is in the filename. an installed extension and a newer app then keep
 * separate caches and never invalidate each other on every run.
 */
export function cacheFileName(version: number = PARSER_VERSION): string {
  return `session-index.v${version}.json`;
}

export function cacheKey(s: { mtimeMs: number; size: number; sidecarMtimeMs: number }): string {
  return `${s.mtimeMs}:${s.size}:${s.sidecarMtimeMs}`;
}

export async function loadCache(
  cacheDir: string,
  projectsDir: string,
): Promise<Map<string, CacheEntry>> {
  const read = await readJsonGuarded<CacheFile>(path.join(cacheDir, cacheFileName()));
  const map = new Map<string, CacheEntry>();
  if (read.status !== "ok" || !isObject(read.value)) return map;
  if (read.value.projectsDir !== projectsDir || !isObject(read.value.entries)) return map;
  for (const [file, entry] of Object.entries(read.value.entries)) {
    if (isObject(entry) && typeof entry.key === "string" && isObject(entry.meta)) {
      const e = entry as unknown as CacheEntry;
      // counted the old way: totals and an offset, so it would never be read again
      if (e.usage && e.usage.v !== USAGE_SCHEMA) delete e.usage;
      map.set(file, e);
    }
  }
  return map;
}

/** dropped when the projects dir differs, like the index */
export async function loadRetired(
  cacheDir: string,
  projectsDir: string,
): Promise<Map<string, RetiredEntry>> {
  const read = await readJsonGuarded<{ projectsDir: string; retired: unknown }>(
    path.join(cacheDir, RETIRED_FILE),
  );
  const map = new Map<string, RetiredEntry>();
  if (read.status !== "ok" || !isObject(read.value)) return map;
  if (read.value.projectsDir !== projectsDir || !isObject(read.value.retired)) return map;
  for (const [file, entry] of Object.entries(read.value.retired)) {
    if (isObject(entry) && typeof entry.sessionId === "string" && isObject(entry.files)) {
      map.set(file, entry as unknown as RetiredEntry);
    }
  }
  return map;
}

export async function saveRetired(
  cacheDir: string,
  projectsDir: string,
  retired: Map<string, RetiredEntry>,
): Promise<void> {
  const file = { projectsDir, retired: Object.fromEntries(retired) };
  await writeFileAtomic(path.join(cacheDir, RETIRED_FILE), JSON.stringify(file));
}

export async function saveCache(
  cacheDir: string,
  projectsDir: string,
  entries: Map<string, CacheEntry>,
): Promise<void> {
  const file: CacheFile = { projectsDir, entries: Object.fromEntries(entries) };
  await writeFileAtomic(path.join(cacheDir, cacheFileName()), JSON.stringify(file));
}

export async function sweepOldCaches(cacheDir: string): Promise<void> {
  try {
    const keep = cacheFileName();
    for (const name of await readdir(cacheDir)) {
      if (/^session-index(\.v\d+)?\.json$/.test(name) && name !== keep) {
        await unlink(path.join(cacheDir, name)).catch(() => {});
      }
    }
  } catch {
    // no cache dir yet
  }
}
