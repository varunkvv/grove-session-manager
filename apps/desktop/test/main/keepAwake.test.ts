import type { LiveStatus } from "@grove/core";
import { describe, expect, it } from "vitest";
import { anyRunning, keepAwake } from "../../src/main/keepAwake.ts";

const status = (state: LiveStatus["state"]): LiveStatus => ({ state, at: 1, lastEventAt: 1 });

describe("keeping the mac awake", () => {
  it("counts a turn in flight, and not a session that waits on a person", () => {
    expect(anyRunning(new Map())).toBe(false);
    expect(
      anyRunning(
        new Map([
          ["a", status("waiting")],
          ["b", status("permission")],
          ["c", status("failed")],
        ]),
      ),
    ).toBe(false);
    expect(
      anyRunning(
        new Map([
          ["a", status("waiting")],
          ["b", status("running")],
        ]),
      ),
    ).toBe(true);
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
    awake(false);
    expect(calls).toEqual([]);
    awake(true);
    awake(true);
    expect(calls).toEqual(["start prevent-app-suspension"]);
    awake(false);
    awake(false);
    expect(calls).toEqual(["start prevent-app-suspension", "stop 7"]);
    awake(true);
    awake(false);
    expect(calls.slice(2)).toEqual(["start prevent-app-suspension", "stop 8"]);
  });
});
