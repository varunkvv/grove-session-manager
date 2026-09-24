// a session whose process went away mid-turn. pure: the live service owns the map and the file.
import { isObject, type LiveStatus } from "@grove/core";

/**
 * where the fact lives: `.grove/interrupted.json`, beside `live-status.json`. it has to outlive
 * the app - after a reboot is exactly when it matters - and it has the same life as the status it
 * comes from: an observation of hooks and processes, restored at start, never a decision. so it
 * sits in the state dir with that status, not in `~/claude-ws/` with the decisions.
 */
export const INTERRUPTED_FILE = "interrupted.json";
/** the marker is quiet, so it can afford to wait out a week away. after that nobody is coming back. */
export const INTERRUPTED_EXPIRY_MS = 7 * 24 * 3_600_000;

export interface Interruption {
  /** when grove noticed the process was gone */
  at: number;
}

/**
 * sessions that were running before a registry pass and are gone after it with no process left:
 * a window closed mid-turn, a crash, a reboot. one that only went idle is still alive, so it is
 * not here - that is a turn that ended.
 */
export function vanished(
  before: ReadonlyMap<string, LiveStatus>,
  after: ReadonlyMap<string, LiveStatus>,
  alive: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const [id, s] of before) {
    if (s.state === "running" && !after.has(id) && !alive.has(id)) out.push(id);
  }
  return out;
}

export function expireInterruptions(m: Map<string, Interruption>, now: number): boolean {
  let changed = false;
  for (const [id, i] of m) {
    if (now - i.at > INTERRUPTED_EXPIRY_MS) {
      m.delete(id);
      changed = true;
    }
  }
  return changed;
}

/** the file is ours, but hand edits and old shapes are dropped quietly rather than trusted */
export function parseInterruptions(value: unknown): Map<string, Interruption> {
  const out = new Map<string, Interruption>();
  if (!isObject(value)) return out;
  for (const [id, v] of Object.entries(value)) {
    if (isObject(v) && typeof v.at === "number" && Number.isFinite(v.at)) out.set(id, { at: v.at });
  }
  return out;
}
