import type { LiveStatus } from "@grove/core";
import { describe, expect, it } from "vitest";
import { keepAwake, runningCount } from "../../src/main/keepAwake.ts";

const status = (state: LiveStatus["state"]): LiveStatus => ({ state, at: 1, lastEventAt: 1 });

describe("keeping the mac awake", () => {
  it("counts the turns in flight, and not a session that waits on a person", () => {
    expect(runningCount(new Map())).toBe(0);
    expect(
      runningCount(
        new Map([
          ["a", status("waiting")],
          ["b", status("permission")],
          ["c", status("failed")],
        ]),
      ),
    ).toBe(0);
    expect(
      runningCount(
        new Map([
          ["a", status("waiting")],
          ["b", status("running")],
          ["c", status("running")],
        ]),
      ),
    ).toBe(2);
  });

  it("takes one assertion however often it is told, and gives that one back", () => {
    const calls: string[] = [];
    let next = 7;
    const awake = keepAwake({
      start: (type) => {
        calls.push(`start ${type}`);
        return next++;
      },
      stop: (id) => calls.push(`stop ${id}`),
    });
    awake.set(false);
    expect(calls).toEqual([]);
    awake.set(true);
    awake.set(true);
    expect(calls).toEqual(["start prevent-display-sleep"]);
    awake.set(false);
    awake.set(false);
    expect(calls).toEqual(["start prevent-display-sleep", "stop 7"]);
    awake.set(true);
    awake.set(false);
    expect(calls.slice(2)).toEqual(["start prevent-display-sleep", "stop 8"]);
  });

  it("says since when, from the first time it was told and not the last", () => {
    let now = 1000;
    const awake = keepAwake({ start: () => 1, stop: () => {} }, () => now);
    expect(awake.since()).toBeNull();
    awake.set(true);
    now = 5000;
    awake.set(true);
    expect(awake.since()).toBe(1000);
    awake.set(false);
    expect(awake.since()).toBeNull();
    awake.set(true);
    expect(awake.since()).toBe(5000);
  });
});
