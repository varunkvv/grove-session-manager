// the mac and its display stay awake while an agent is mid-turn, and are let go when none is. it is
// what `caffeinate -d -i` takes, held by grove's own process: no child to start, and none to outlive us.
import type { LiveStatus } from "@grove/core";

/** electron's powerSaveBlocker, as far as this needs it */
export interface PowerBlocker {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): void;
}

/**
 * a turn in flight somewhere. a session working through a background subagent is still `running`
 * (see reduceStatus on Stop), and one that waits on a person is not: nothing moves until they answer
 */
export function anyRunning(statuses: ReadonlyMap<string, LiveStatus>): boolean {
  for (const s of statuses.values()) if (s.state === "running") return true;
  return false;
}

/**
 * holds the mac awake while told to, display included: a display kept on keeps the system up with
 * it. a laptop on battery with its lid shut still sleeps. quitting drops the assertion with the process.
 */
export function keepAwake(blocker: PowerBlocker): (on: boolean) => void {
  let id: number | null = null;
  return (on) => {
    if (on === (id !== null)) return;
    if (id === null) id = blocker.start("prevent-display-sleep");
    else {
      blocker.stop(id);
      id = null;
    }
  };
}
