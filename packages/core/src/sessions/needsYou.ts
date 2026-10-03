// pure, so the renderer and core/project can use it. liveStatus.ts re-exports it.
import type { LiveState, LiveStatus } from "../types.ts";

const NEEDS_YOU: ReadonlySet<LiveState> = new Set(["permission", "waiting", "failed"]);

export function needsYou(s: LiveStatus | undefined): boolean {
  return !!s && NEEDS_YOU.has(s.state) && !s.seen;
}
