// the mac stays awake while an agent is mid-turn, and is let go when none is. it is the assertion
// `caffeinate -i` takes, held by grove's own process: no child to start, and none to outlive us.
import type { LiveStatus } from "@grove/core";

/** electron's powerSaveBlocker, as far as this needs it */
export interface PowerBlocker {
  start(type: "prevent-app-suspension"): number;
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
 * holds the mac awake while told to. idle sleep only: the display still sleeps, and so does a
 * laptop on battery with its lid shut. quitting drops the assertion with the process.
 */
export function keepAwake(blocker: PowerBlocker): (on: boolean) => void {
  let id: number | null = null;
  return (on) => {
    if (on === (id !== null)) return;
    if (id === null) id = blocker.start("prevent-app-suspension");
    else {
      blocker.stop(id);
      id = null;
    }
  };
}
