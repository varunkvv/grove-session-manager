import { isObject } from "../fsx.ts";
import type { LiveStatus } from "../types.ts";

/**
 * `claude agents --json --all`: what Claude Code's own supervisor says about the sessions it runs
 * in the background (`claude --bg`, `claude agents`). the registry file of such a session only
 * carries `kind: "bg"` and a status - its state and what it is waiting on come from here alone.
 *
 * the format is internal, like the transcript's: every field is optional, bad rows are dropped,
 * nothing here throws. interactive rows are dropped too: the live registry already has them.
 */
export interface BackgroundEntry {
  sessionId: string;
  /** the short id `claude attach`, `logs` and `stop` take */
  id?: string;
  /** `working` | `blocked` | `done` | `failed` | `stopped` as of 2.1.281. kept as is if new. */
  state?: string;
  /**
   * only while the supervisor holds a live worker for it. that, not the state, is what makes a
   * resume elsewhere refuse: a `done` session keeps its worker for about an hour.
   */
  pid?: number;
  /** `busy` | `waiting` | `idle`, while the process is alive */
  status?: string;
  /** what a waiting session is blocked on: `permission prompt`, `input needed`, ... */
  waitingFor?: string;
  name?: string;
  cwd?: string;
  startedAt?: number;
}

const STRINGS = ["id", "state", "status", "waitingFor", "name", "cwd"] as const;

/** `sessionId` and `kind: "background"` are what an entry needs. everything else is a bonus. */
export function parseBackgroundEntry(value: unknown): BackgroundEntry | null {
  if (!isObject(value) || value.kind !== "background") return null;
  const { sessionId, pid, startedAt } = value;
  if (typeof sessionId !== "string" || !sessionId) return null;
  const out: BackgroundEntry = { sessionId };
  for (const key of STRINGS) {
    const v = value[key];
    if (typeof v === "string" && v) out[key] = v;
  }
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) out.pid = pid;
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) out.startedAt = startedAt;
  return out;
}

/**
 * null when the output says nothing: not JSON, not a list, or an empty list. `--json` lists the
 * interactive sessions too, so a list holding only those is a real "nothing in the background",
 * while an empty one is as likely a claude that could not read its state. same rule as the
 * registry: never clear anything on the strength of an empty answer.
 */
export function parseBackgroundList(text: string): BackgroundEntry[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map(parseBackgroundEntry).filter((e): e is BackgroundEntry => e !== null);
}

/**
 * one entry per session. backgrounding a conversation twice gives it a second row, so the one
 * with a live worker wins, then the newest.
 */
export function backgroundBySession(
  entries: readonly BackgroundEntry[],
): Map<string, BackgroundEntry> {
  const out = new Map<string, BackgroundEntry>();
  for (const e of entries) {
    const was = out.get(e.sessionId);
    const better =
      !was ||
      (e.pid !== undefined && was.pid === undefined) ||
      ((e.pid !== undefined) === (was.pid !== undefined) &&
        (e.startedAt ?? 0) > (was.startedAt ?? 0));
    if (better) out.set(e.sessionId, e);
  }
  return out;
}

/** a blocked session, as the inbox shows it. a permission prompt reads as one, anything else is your turn. */
function blockedState(e: BackgroundEntry): LiveStatus["state"] {
  return e.waitingFor === "permission prompt" ? "permission" : "waiting";
}

/**
 * the supervisor's word on top of what the hooks said. a hook always wins: a background session
 * in a combo reports through its hooks like any other. this only speaks for one no hook covers,
 * and only to say it is blocked on someone - `blocked` is the one state worth a place in the inbox.
 * re-derived on every read, like the registry's. what someone already looked at stays looked at.
 */
export function applyBackground(
  statuses: Map<string, LiveStatus>,
  entries: ReadonlyMap<string, BackgroundEntry>,
  now: number,
): boolean {
  let changed = false;
  for (const [id, s] of statuses) {
    if (s.source === "agents" && entries.get(id)?.state !== "blocked") {
      statuses.delete(id);
      changed = true;
    }
  }
  for (const [id, e] of entries) {
    if (e.state !== "blocked") continue;
    const was = statuses.get(id);
    // a hook said something: it knows more than a list of states does
    if (was && !was.source) continue;
    const state = blockedState(e);
    if (was?.source === "agents" && was.state === state && was.detail === e.waitingFor) continue;
    statuses.set(id, {
      state,
      at: now,
      lastEventAt: now,
      ...(e.waitingFor ? { detail: e.waitingFor } : {}),
      source: "agents",
    });
    changed = true;
  }
  return changed;
}
