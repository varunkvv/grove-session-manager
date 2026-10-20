import { type LiveStatus, type SessionTasks, TASK_MIN_MS } from "@grove/core";
import { describe, expect, it } from "vitest";
import {
  keepAwake,
  leftRunningCount,
  runningCount,
  watchingCount,
} from "../../src/main/keepAwake.ts";
import { RUNNING_STALE_MS } from "../../src/main/services/live.ts";

const status = (state: LiveStatus["state"]): LiveStatus => ({ state, at: 1, lastEventAt: 1 });

describe("keeping the mac awake", () => {
  it("counts the turns in flight, and not a session that waits on a person", () => {
    expect(runningCount(new Map(), 1)).toBe(0);
    expect(
      runningCount(
        new Map([
          ["a", status("waiting")],
          ["b", status("permission")],
          ["c", status("failed")],
        ]),
        1,
      ),
    ).toBe(0);
    expect(
      runningCount(
        new Map([
          ["a", status("waiting")],
          ["b", status("running")],
          ["c", status("running")],
        ]),
        1,
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
    expect(runningCount(statuses, NOW)).toBe(1);
    // the hold does not wait for the minute: a watcher started seconds before its turn ended
    // keeps the mac up from that Stop on, with no gap after the turn
    expect(leftRunningCount(tasks, statuses, NOW)).toBe(3);
    expect(leftRunningCount(new Map(), statuses, NOW)).toBe(0);
  });

  it("counts a turn that ended with a background agent working, until the agent goes quiet", () => {
    const NOW = 100 * 60_000;
    const ended: LiveStatus = {
      state: "waiting",
      at: NOW - 10 * 60_000,
      lastEventAt: NOW - 1_000,
      agentsLeft: 1,
    };
    // it is a person's turn, and the agent's tool calls still come in
    const statuses = new Map([["a", ended]]);
    expect(runningCount(statuses, NOW)).toBe(1);
    // with a wake-up left too it is counted once
    const tasks = new Map<string, SessionTasks>([
      ["a", { at: 0, tasks: [{ id: "t", kind: "schedule", description: "poll", since: 0 }] }],
    ]);
    expect(watchingCount(tasks, statuses, NOW)).toBe(0);
    expect(leftRunningCount(tasks, statuses, NOW)).toBe(0);
    // nothing from the agent for as long as a running session goes stale: a restart after it died
    // must not hold the mac for days
    const quiet = new Map([["a", { ...ended, lastEventAt: NOW - RUNNING_STALE_MS }]]);
    expect(runningCount(quiet, NOW)).toBe(0);
    expect(watchingCount(tasks, quiet, NOW)).toBe(1);
    expect(leftRunningCount(tasks, quiet, NOW)).toBe(1);
    // a turn that ended with no agent left never counted
    expect(runningCount(new Map([["a", { ...ended, agentsLeft: undefined }]]), NOW)).toBe(0);
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
