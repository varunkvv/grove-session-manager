import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LiveStatus } from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  expireInterruptions,
  INTERRUPTED_EXPIRY_MS,
  INTERRUPTED_FILE,
  type Interruption,
  parseInterruptions,
  vanished,
} from "../../src/main/services/interrupted.ts";
import { LiveService, RUNNING_STALE_MS } from "../../src/main/services/live.ts";
import { interruptedView } from "../../src/main/services/sessions.ts";

const SID = {
  cut: "aaaaaaaa-0000-4000-8000-000000000001",
  other: "bbbbbbbb-0000-4000-8000-000000000002",
};

const running = (s: Partial<LiveStatus> = {}): LiveStatus => ({
  state: "running",
  at: 1,
  lastEventAt: 1,
  ...s,
});

describe("what counts as interrupted", () => {
  it("running before a registry pass, gone after, and no process left", () => {
    const before = new Map<string, LiveStatus>([
      ["gone", running()],
      ["idle", running({ source: "registry" })],
      ["stays", running()],
      ["done", { state: "waiting", at: 1, lastEventAt: 1 }],
    ]);
    const after = new Map<string, LiveStatus>([["stays", running()]]);
    // "idle" went quiet but its process is still up: a turn that ended, not a lost one
    expect(vanished(before, after, new Set(["idle"]))).toEqual(["gone"]);
  });

  it("a week on, nobody is coming back to it", () => {
    const now = 10 * INTERRUPTED_EXPIRY_MS;
    const m = new Map<string, Interruption>([
      ["old", { at: now - INTERRUPTED_EXPIRY_MS - 1 }],
      ["new", { at: now - 1000 }],
    ]);
    expect(expireInterruptions(m, now)).toBe(true);
    expect([...m.keys()]).toEqual(["new"]);
  });

  it("the file is read defensively", () => {
    expect(parseInterruptions({ a: { at: 5 }, b: { at: "x" }, c: 3 })).toEqual(
      new Map([["a", { at: 5 }]]),
    );
    expect(parseInterruptions(null).size).toBe(0);
    expect(parseInterruptions([1]).size).toBe(0);
  });

  it("the supervisor's word decides for a session it knows", () => {
    const mark = { at: 5 };
    expect(interruptedView(mark, undefined)).toEqual({ why: "gone", at: 5 });
    expect(interruptedView(undefined, undefined)).toBeUndefined();
    // running in the background now, or stopped on purpose: neither was cut off
    expect(interruptedView(mark, { sessionId: "s", pid: 1, state: "working" })).toBeUndefined();
    expect(interruptedView(mark, { sessionId: "s", state: "stopped" })).toBeUndefined();
    expect(interruptedView(undefined, { sessionId: "s", state: "failed" })).toEqual({
      why: "failed",
    });
    expect(interruptedView(undefined, { sessionId: "s", state: "done" })).toBeUndefined();
  });
});

describe("the interrupted fact survives a restart", () => {
  const services: LiveService[] = [];
  afterEach(() => {
    for (const s of services.splice(0)) s.dispose();
  });

  function machine() {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-interrupted-")));
    const stateDir = path.join(dir, "state");
    const events = path.join(stateDir, "events");
    const registryDir = path.join(dir, "claude", "sessions");
    mkdirSync(events, { recursive: true });
    mkdirSync(registryDir, { recursive: true });
    let n = 0;
    const event = (sessionId: string, name: string, agoMs = 0) => {
      const file = path.join(events, `${process.pid}-${++n}`);
      writeFileSync(
        `${file}.tmp`,
        JSON.stringify({ session_id: sessionId, hook_event_name: name, cwd: "/x" }),
      );
      const when = new Date(Date.now() - agoMs + n);
      utimesSync(`${file}.tmp`, when, when);
      renameSync(`${file}.tmp`, `${file}.json`);
    };
    // this test process stands in for every pid: alive is all the registry checks
    const register = (name: string, sessionId: string) =>
      writeFileSync(
        path.join(registryDir, `${name}.json`),
        JSON.stringify({ pid: process.pid, sessionId, status: "busy", kind: "interactive" }),
      );
    const start = async (now?: number) => {
      let seen: ReadonlyMap<string, Interruption> = new Map();
      const live = new LiveService({
        stateDir,
        claudeSettingsFile: path.join(dir, "claude", "settings.json"),
        registryDir,
        onChange: () => {},
        onNeedsYou: () => {},
        onInterrupted: (m) => {
          seen = new Map(m);
        },
        ...(now !== undefined ? { now: () => now } : {}),
      });
      services.push(live);
      await live.start();
      return { live, seen: () => seen };
    };
    const file = () => JSON.parse(readFileSync(path.join(stateDir, INTERRUPTED_FILE), "utf8"));
    /** dispose writes what it holds without waiting on it, as quitting does */
    const stop = async (live: LiveService) => {
      live.dispose();
      await new Promise((r) => setTimeout(r, 100));
    };
    return { event, register, registryDir, start, file, stop };
  }

  it("a running session whose process went away is marked, kept on disk, and cleared when it speaks", async () => {
    const m = machine();
    m.register("1", SID.cut);
    m.register("2", SID.other);
    m.event(SID.cut, "UserPromptSubmit");
    const first = await m.start();
    expect(first.live.list().get(SID.cut)?.state).toBe("running");
    expect(first.seen().size).toBe(0);
    await m.stop(first.live);

    // the window closed on it mid-turn: no Stop, no SessionEnd, the process is just gone
    rmSync(path.join(m.registryDir, "1.json"));
    const second = await m.start();
    expect(second.live.list().has(SID.cut)).toBe(false);
    expect([...second.seen().keys()]).toEqual([SID.cut]);
    await m.stop(second.live);
    expect(Object.keys(m.file())).toEqual([SID.cut]);

    // an app restart later, it is still there - after a reboot is when it matters
    const third = await m.start();
    expect([...third.live.interruptions().keys()]).toEqual([SID.cut]);
    await m.stop(third.live);

    // it speaks again from a new process: it was picked up somewhere
    m.register("3", SID.cut);
    m.event(SID.cut, "UserPromptSubmit");
    const fourth = await m.start();
    expect(fourth.live.interruptions().size).toBe(0);
    await m.stop(fourth.live);
    expect(m.file()).toEqual({});
  });

  it("ending mid-turn counts, ending after the turn does not", async () => {
    const m = machine();
    m.event(SID.cut, "UserPromptSubmit");
    m.event(SID.cut, "SessionEnd");
    m.event(SID.other, "UserPromptSubmit");
    m.event(SID.other, "Stop");
    m.event(SID.other, "SessionEnd");
    const { seen } = await m.start();
    expect([...seen().keys()]).toEqual([SID.cut]);
  });

  it("a running session quiet past the stale mark when the app comes up was cut off too", async () => {
    const m = machine();
    m.event(SID.cut, "UserPromptSubmit");
    const first = await m.start();
    await m.stop(first.live);
    // the machine rebooted overnight: no process anywhere, the registry is empty
    const later = await m.start(Date.now() + RUNNING_STALE_MS + 60_000);
    expect(later.live.list().has(SID.cut)).toBe(false);
    expect([...later.seen().keys()]).toEqual([SID.cut]);
  });

  it("grove handing it to the supervisor clears it", async () => {
    const m = machine();
    m.event(SID.cut, "UserPromptSubmit");
    m.event(SID.cut, "SessionEnd");
    const { live, seen } = await m.start();
    expect(seen().has(SID.cut)).toBe(true);
    live.clearInterrupted(SID.cut);
    expect(seen().has(SID.cut)).toBe(false);
  });
});
