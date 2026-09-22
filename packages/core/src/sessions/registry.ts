import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isObject } from "../fsx.ts";
import type { LiveStatus } from "../types.ts";

/**
 * every live Claude Code process writes `<claudeConfigDir>/sessions/<pid>.json` and keeps it
 * current as it works. `claude agents --json` is a view over the same directory, so reading the
 * files costs no subprocess and fs.watch works on them.
 *
 * the format is internal, like the transcript's: every field is optional, nothing here throws.
 */
export function sessionsRegistryDir(claudeConfigDir: string): string {
  return path.join(claudeConfigDir, "sessions");
}

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  /** `busy` and `idle` seen so far. an unknown value still proves the process is alive. */
  status: string;
  cwd?: string;
  name?: string;
  kind?: string;
  entrypoint?: string;
  version?: string;
  startedAt?: number;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

const STRINGS = ["cwd", "name", "kind", "entrypoint", "version"] as const;
const NUMBERS = ["startedAt", "updatedAt", "statusUpdatedAt"] as const;

/** `pid`, `sessionId` and `status` are what an entry needs. everything else is a bonus. */
export function parseRegistryEntry(value: unknown): RegistryEntry | null {
  if (!isObject(value)) return null;
  const { pid, sessionId, status } = value;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (typeof status !== "string" || !status) return null;
  const out: RegistryEntry = { pid, sessionId, status };
  for (const key of STRINGS) {
    const v = value[key];
    if (typeof v === "string" && v) out[key] = v;
  }
  for (const key of NUMBERS) {
    const v = value[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** EPERM means the pid belongs to someone else, which still makes it alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * the live sessions, confirmed. a file outlives a crash, so every pid is checked before its entry
 * counts. `<pid>.<hash>.key` files sit in the same directory and hold a peer token - never read one.
 */
export async function readRegistry(
  dir: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<RegistryEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    } catch {
      // half-written, or a shape that is no longer JSON
      continue;
    }
    const entry = parseRegistryEntry(value);
    if (entry && isAlive(entry.pid)) out.push(entry);
  }
  return out;
}

/**
 * the registry on top of what the hooks said. hook state always wins: it is the only source that
 * can tell a permission prompt from a tool call, and losing that would empty the "needs you" inbox.
 * so the registry may only do two things - fill in a session the hooks never covered, and retire a
 * `running` whose process is gone. an `idle` process adds nothing: nobody asked for anything.
 */
export function applyRegistry(
  statuses: Map<string, LiveStatus>,
  entries: readonly RegistryEntry[],
  now: number,
): boolean {
  // nothing read means no registry (an older Claude Code, an isolated config dir), not that every
  // session on the machine died. never clear anything on the strength of an empty directory.
  if (entries.length === 0) return false;
  const alive = new Set<string>();
  const busy = new Map<string, RegistryEntry>();
  for (const e of entries) {
    alive.add(e.sessionId);
    if (e.status === "busy") busy.set(e.sessionId, e);
  }
  let changed = false;
  for (const [id, s] of statuses) {
    if (s.source === "registry") {
      // ours, and it says nothing the registry does not: re-derived on every pass
      if (!busy.has(id)) {
        statuses.delete(id);
        changed = true;
      }
    } else if (s.state === "running" && !alive.has(id)) {
      statuses.delete(id);
      changed = true;
    }
  }
  for (const [id, e] of busy) {
    if (statuses.has(id)) continue;
    const at = e.statusUpdatedAt ?? e.updatedAt ?? e.startedAt ?? now;
    statuses.set(id, {
      state: "running",
      at: Math.min(at, now),
      lastEventAt: now,
      source: "registry",
    });
    changed = true;
  }
  return changed;
}
