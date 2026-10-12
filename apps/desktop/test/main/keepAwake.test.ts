import { type LiveStatus, type SessionTasks, TASK_MIN_MS } from "@grove/core";
import { describe, expect, it } from "vitest";
import { keepAwake, runningCount, watchingCount } from "../../src/main/keepAwake.ts";

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

  it("counts the sessions between turns that left something running, once it counts", () => {
    const NOW = 10 * 60_000;
    const left = (kind: "command" | "schedule", since: number): SessionTasks => ({
      at: since,
      tasks: [{ id: "t", kind, description: "poll", since }],
    });
    const tasks = new Map([
      // a Monitor ten minutes in, its session waiting on a person: it still polls
      ["a", left("command", 0)],
      // mid-turn: that is runningCount's, not counted twice
      ["b", left("command", 0)],
      // a script started seconds ago is not a task yet
      ["c", left("command", NOW - TASK_MIN_MS + 1)],
      // a wake-up counts at once, and with no status at all: the session's turn ended long ago
      ["d", left("schedule", NOW)],
    ]);
    const statuses = new Map([
      ["a", status("waiting")],
      ["b", status("running")],
      ["c", status("waiting")],
    ]);
    expect(watchingCount(tasks, statuses, NOW)).toBe(2);
    // a second later the script is a minute old
    expect(watchingCount(tasks, statuses, NOW + 1)).toBe(3);
    expect(watchingCount(new Map(), statuses, NOW)).toBe(0);
    expect(runningCount(statuses)).toBe(1);
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
