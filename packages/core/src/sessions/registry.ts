import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isObject } from "../fsx.ts";
import type { LiveStatus } from "../types.ts";
import { answered } from "./liveStatus.ts";

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
  /** `busy`, `idle` and `waiting` seen so far. an unknown value still proves the process is alive. */
  status: string;
  /** what a `waiting` process waits on: "permission prompt", "input needed" */
  waitingFor?: string;
  cwd?: string;
  name?: string;
  kind?: string;
  entrypoint?: string;
  version?: string;
  startedAt?: number;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

const STRINGS = ["cwd", "name", "kind", "entrypoint", "version", "waitingFor"] as const;
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
 * what a waiting process waits on that is the person's to answer: a tool's permission prompt and
 * ExitPlanMode say "permission prompt", an AskUserQuestion "input needed" (claude 2.1.296)
 */
const ASKS: ReadonlySet<string> = new Set(["permission prompt", "input needed"]);

const asking = (e: RegistryEntry): boolean =>
  e.status === "waiting" && e.waitingFor !== undefined && ASKS.has(e.waitingFor);

/**
 * the registry on top of what the hooks said. hook state always wins: it is the only source that
 * can tell which tool asks, and losing that would empty the "needs you" inbox. so the registry may
 * only do two things - fill in a session the hooks never covered (busy is running, waiting on an
 * ask is a permission), and retire a `running` whose process is gone. an `idle` process adds
 * nothing: nobody asked for anything.
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
  /** what each session's process says that fills a session in: an ask, else busy */
  const says = new Map<string, RegistryEntry>();
  for (const e of entries) {
    alive.add(e.sessionId);
    const had = says.get(e.sessionId);
    if (asking(e) || (e.status === "busy" && !(had && asking(had)))) says.set(e.sessionId, e);
  }
  let changed = false;
  for (const [id, s] of statuses) {
    if (s.source === "registry") {
      // ours, and it says nothing the registry does not: re-derived on every pass
      const e = says.get(id);
      const want = e && fromRegistry(e, s, now);
      if (want === s) continue;
      if (want) statuses.set(id, want);
      else statuses.delete(id);
      changed = true;
    } else if (s.state === "running" && !alive.has(id)) {
      statuses.delete(id);
      changed = true;
    }
  }
  for (const [id, e] of says) {
    if (statuses.has(id)) continue;
    statuses.set(id, fromRegistry(e, undefined, now));
    changed = true;
  }
  return changed;
}

/** a session no hook covers, from its process alone. the same read again is `was` itself */
function fromRegistry(e: RegistryEntry, was: LiveStatus | undefined, now: number): LiveStatus {
  const at = Math.min(e.statusUpdatedAt ?? e.updatedAt ?? e.startedAt ?? now, now);
  if (asking(e)) {
    // the same ask, read again, keeps whether someone looked: else a dismissed one comes back
    if (was?.state === "permission" && was.at === at && was.detail === e.waitingFor) return was;
    return {
      state: "permission",
      at,
      lastEventAt: now,
      ...(e.waitingFor ? { detail: e.waitingFor } : {}),
      source: "registry",
    };
  }
  if (was?.state === "running") return was;
  return { state: "running", at, lastEventAt: now, source: "registry" };
}

/**
 * an ask approved with no hook to say so. claude's registry file says `waiting` while an ask is
 * open and `busy` from the moment it is approved, and no hook fires until the tool ends: minutes
 * for a build. a hook-made ask whose process went busy after the ask came in is answered. a busy
 * older than the ask is not: the async hook can land after a fast approval, and that one waits for
 * its PostToolUse as before. read after a registry read and after a drain, since either can come
 * first
 */
export function applyApprovals(
  statuses: Map<string, LiveStatus>,
  entries: Iterable<RegistryEntry>,
): boolean {
  let changed = false;
  for (const e of entries) {
    const s = statuses.get(e.sessionId);
    if (!s || s.source || s.state !== "permission" || e.status !== "busy") continue;
    if (e.statusUpdatedAt === undefined || e.statusUpdatedAt <= s.at) continue;
    statuses.set(e.sessionId, answered(s, { at: e.statusUpdatedAt }));
    changed = true;
  }
  return changed;
}
