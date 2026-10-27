import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ForkRead,
  forkOptions,
  KEEP_EVERY_MS,
  type KeepClock,
  keepDue,
  keepHours,
  readFork,
  sweepFork,
} from "../../src/main/services/cacheKeeper.ts";

const H = 3_600_000;
const T = 1_000_000_000;
const idle = (o: Partial<KeepClock> = {}): KeepClock => ({
  lastTurn: T,
  running: false,
  warming: false,
  off: false,
  context: 150_000,
  ...o,
});

describe("the cache keeper's rule", () => {
  it("forks ~55 minutes after the last turn, then ~55 after each fork, for N hours", () => {
    expect(keepDue(idle(), T + KEEP_EVERY_MS - 1, 3)).toBe(false);
    expect(keepDue(idle(), T + KEEP_EVERY_MS, 3)).toBe(true);
    const warm = T + KEEP_EVERY_MS;
    expect(keepDue(idle({ lastWarm: warm }), warm + KEEP_EVERY_MS - 1, 3)).toBe(false);
    expect(keepDue(idle({ lastWarm: warm }), warm + KEEP_EVERY_MS, 3)).toBe(true);
    // N hours after the last turn: done, however recent the last fork
    expect(keepDue(idle({ lastWarm: T + 2 * H }), T + 3 * H, 3)).toBe(false);
    expect(keepDue(idle({ lastWarm: T + 2 * H }), T + 3 * H, 4)).toBe(true);
  });

  it("skips one running, mid-fork, missed, small, never turned, or with the setting off", () => {
    const at = T + KEEP_EVERY_MS;
    expect(keepDue(idle({ running: true }), at, 3)).toBe(false);
    expect(keepDue(idle({ warming: true }), at, 3)).toBe(false);
    expect(keepDue(idle({ off: true }), at, 3)).toBe(false);
    expect(keepDue(idle({ context: 19_999 }), at, 3)).toBe(false);
    expect(keepDue(idle({ context: 20_000 }), at, 3)).toBe(true);
    expect(keepDue(idle({ lastTurn: undefined }), at, 3)).toBe(false);
    expect(keepDue(idle(), at, 0)).toBe(false);
  });

  it("reads the setting: absent is 3 hours, anything not hours is off", () => {
    expect(keepHours(undefined)).toBe(3);
    expect(keepHours(6)).toBe(6);
    expect(keepHours(0)).toBe(0);
    expect(keepHours(-1)).toBe(0);
    expect(keepHours("3")).toBe(0);
    expect(keepHours(Number.NaN)).toBe(0);
  });
});

describe("the cache keeper's fork", () => {
  it("resumes as a fork with no transcript and no hooks, on what the last turn ran on", () => {
    const o = forkOptions("s1", "f1", {
      model: "opus",
      effort: "xhigh",
      style: "Explanatory",
      ultracode: true,
      thinkingOff: true,
    });
    expect(o).toMatchObject({
      resume: "s1",
      forkSession: true,
      sessionId: "f1",
      persistSession: false,
      maxTurns: 1,
      model: "opus",
      effort: "xhigh",
      thinking: { type: "disabled" },
      settings: { disableAllHooks: true, outputStyle: "Explanatory", ultracode: true },
    });
    // nothing claude decides on its own is pinned
    const bare = forkOptions("s1", "f1", {});
    expect(bare).not.toHaveProperty("model");
    expect(bare).not.toHaveProperty("effort");
    expect(bare).not.toHaveProperty("thinking");
    expect(bare.settings).toEqual({ disableAllHooks: true });
  });

  it("denies any tool, in the hook and in canUseTool", async () => {
    const o = forkOptions("s1", "f1", {});
    const hook = o.hooks?.PreToolUse?.[0]?.hooks[0];
    const out = await hook?.({} as never, undefined, {
      signal: new AbortController().signal,
    } as never);
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const can = await o.canUseTool?.("Bash", {}, {} as never);
    expect(can?.behavior).toBe("deny");
  });

  it("passes over a replayed task notification and stops at the request's start", () => {
    const r: ForkRead = {};
    expect(readFork(r, { type: "system", subtype: "init", session_id: "fork-1" })).toBe(false);
    expect(r.fork).toBe("fork-1");
    // what the fork had pending plays first, with no request
    expect(
      readFork(r, {
        type: "result",
        origin: { kind: "task-notification" },
        usage: { input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    ).toBe(false);
    // a message_start with no usage yet
    expect(
      readFork(r, {
        type: "stream_event",
        event: { type: "message_start", message: { usage: {} } },
      }),
    ).toBe(false);
    expect(r.usage).toBeUndefined();
    expect(
      readFork(r, {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 80,
              cache_read_input_tokens: 148_904,
              cache_creation_input_tokens: 0,
            },
          },
        },
      }),
    ).toBe(true);
    expect(r.usage).toEqual({ read: 148_904, write: 0 });
  });

  it("ends at a result of its own even with no stream", () => {
    const r: ForkRead = {};
    expect(readFork(r, { type: "result", usage: { cache_creation_input_tokens: 30_000 } })).toBe(
      true,
    );
    expect(r.usage).toEqual({ read: 0, write: 30_000 });
  });

  it("removes what a fork leaves under its own id, and nothing that isn't an id", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-keeper-"));
    const fork = "8a6fde21-62c2-4f47-9192-57db3c7c2a89";
    for (const d of ["file-history", "session-env"]) {
      mkdirSync(path.join(dir, d, fork), { recursive: true });
      mkdirSync(path.join(dir, d, "other"), { recursive: true });
    }
    await sweepFork(dir, fork);
    await sweepFork(dir, "..");
    expect(existsSync(path.join(dir, "file-history", fork))).toBe(false);
    expect(existsSync(path.join(dir, "session-env", fork))).toBe(false);
    expect(existsSync(path.join(dir, "file-history", "other"))).toBe(true);
    expect(existsSync(path.join(dir, "file-history"))).toBe(true);
  });
});
