import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { isObject, readJsonGuarded, writeFileAtomic } from "../fsx.ts";
import { PARSER_VERSION } from "../transcript/parse.ts";
import type { ParsedMeta } from "../types.ts";
import type { SessionTallies } from "./usage.ts";

export interface CacheEntry {
  key: string;
  meta: ParsedMeta;
  /**
   * token counts, with their own key: they are worked out in a later, slower pass, and a re-parse
   * of the head and tail must not throw away the offsets that make the next count incremental.
   */
  usage?: { key: string; files: SessionTallies };
}

export interface CacheFile {
  projectsDir: string;
  entries: Record<string, CacheEntry>;
}

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
      map.set(file, entry as unknown as CacheEntry);
    }
  }
  return map;
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
