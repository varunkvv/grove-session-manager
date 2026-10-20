// pure, so the renderer and core/project can use it. liveStatus.ts re-exports it.
import type { LiveState, LiveStatus } from "../types.ts";

const NEEDS_YOU: ReadonlySet<LiveState> = new Set(["permission", "waiting", "failed"]);

/**
 * the status that needs the person: this one, or the one a turn claude started itself keeps
 * (`kept`). what the lists, the menu bar and the dock count say comes from here
 */
export function needing(s: LiveStatus | undefined): LiveStatus | undefined {
  if (!s) return undefined;
  if (NEEDS_YOU.has(s.state)) return s.seen ? undefined : s;
  return s.kept;
}

export function needsYou(s: LiveStatus | undefined): boolean {
  return !!needing(s);
}
