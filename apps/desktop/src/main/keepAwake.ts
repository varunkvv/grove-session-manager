// the mac and its display stay awake while an agent is mid-turn, and are let go when none is. it is
// what `caffeinate -d -i` takes, held by grove's own process: no child to start, and none to outlive us.
import type { LiveStatus } from "@grove/core";

/** electron's powerSaveBlocker, as far as this needs it */
export interface PowerBlocker {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): void;
}

/**
 * the turns in flight. a session working through a background subagent is still `running` (see
 * reduceStatus on Stop), and one that waits on a person is not: nothing moves until they answer
 */
export function runningCount(statuses: ReadonlyMap<string, LiveStatus>): number {
  let n = 0;
  for (const s of statuses.values()) if (s.state === "running") n++;
  return n;
}

export interface KeepAwake {
  set(on: boolean): void;
  /** when it was last told to stay awake. null while the mac may sleep */
  since(): number | null;
}

/**
 * holds the mac awake while told to, display included: a display kept on keeps the system up with
 * it. a laptop on battery with its lid shut still sleeps. quitting drops the assertion with the process.
 */
export function keepAwake(blocker: PowerBlocker, now: () => number = Date.now): KeepAwake {
  let held: { id: number; since: number } | null = null;
  return {
    set(on) {
      if (on === (held !== null)) return;
      if (held === null) held = { id: blocker.start("prevent-display-sleep"), since: now() };
      else {
        blocker.stop(held.id);
        held = null;
      }
    },
    since: () => held?.since ?? null,
  };
}
