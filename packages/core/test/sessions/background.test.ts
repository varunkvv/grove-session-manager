import { describe, expect, it } from "vitest";
import {
  applyBackground,
  type BackgroundEntry,
  backgroundBySession,
  parseBackgroundEntry,
  parseBackgroundList,
} from "../../src/sessions/background.ts";
import type { LiveStatus } from "../../src/types.ts";

const SID = {
  a: "aaaaaaaa-0000-4000-8000-000000000001",
  b: "bbbbbbbb-0000-4000-8000-000000000002",
  c: "cccccccc-0000-4000-8000-000000000003",
};

// shaped like `claude agents --json --all` on 2.1.281: an interactive row, a background row with a
// live worker, and one the supervisor let go of
const REAL = JSON.stringify([
  {
    pid: 90982,
    cwd: "/ws/data-objects",
    kind: "interactive",
    startedAt: 1790198599644,
    sessionId: SID.c,
    name: "data-objects-42",
    status: "idle",
  },
  {
    pid: 4112,
    id: "d7b6bcc2",
    sessionId: SID.a,
    cwd: "/ws/chat-features",
    kind: "background",
    name: "fix the retry test",
    status: "waiting",
    state: "blocked",
    waitingFor: "permission prompt",
    startedAt: 1790198600000,
  },
  {
    id: "60221e3b",
    sessionId: SID.b,
    cwd: "/ws/chat-features",
    kind: "background",
    state: "stopped",
    startedAt: 1790198500000,
  },
]);

function status(s: Partial<LiveStatus> & { state: LiveStatus["state"] }): LiveStatus {
  return { at: 1000, lastEventAt: 1000, ...s };
}

const bySession = (...entries: BackgroundEntry[]) => backgroundBySession(entries);

describe("claude agents --json", () => {
  it("keeps the background rows, with whatever fields they carry", () => {
    expect(parseBackgroundList(REAL)).toEqual([
      {
        sessionId: SID.a,
        id: "d7b6bcc2",
        pid: 4112,
        cwd: "/ws/chat-features",
        name: "fix the retry test",
        status: "waiting",
        state: "blocked",
        waitingFor: "permission prompt",
        startedAt: 1790198600000,
      },
      {
        sessionId: SID.b,
        id: "60221e3b",
        cwd: "/ws/chat-features",
        state: "stopped",
        startedAt: 1790198500000,
      },
    ]);
  });

  it("a row it cannot use is dropped, and a field it cannot use is left off", () => {
    for (const bad of [
      null,
      "background",
      [],
      {},
      { kind: "background" },
      { kind: "background", sessionId: "" },
      { kind: "background", sessionId: 7 },
      { kind: "interactive", sessionId: SID.a },
      { sessionId: SID.a, state: "working" },
    ]) {
      expect(parseBackgroundEntry(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(
      parseBackgroundEntry({
        kind: "background",
        sessionId: SID.a,
        pid: "4112",
        id: 7,
        state: "",
        startedAt: "yesterday",
        waitingFor: null,
      }),
    ).toEqual({ sessionId: SID.a });
    expect(parseBackgroundEntry({ kind: "background", sessionId: SID.a, pid: 0 })).toEqual({
      sessionId: SID.a,
    });
    // a state nobody has seen yet is still a state
    expect(
      parseBackgroundEntry({ kind: "background", sessionId: SID.a, state: "hibernating" }),
    ).toMatchObject({ state: "hibernating" });
  });

  it("output that says nothing is unknown, not an empty background", () => {
    for (const text of ["", "not json", "{}", '{"sessions":[]}', "null", "[]", "Error: nope"]) {
      expect(parseBackgroundList(text), text).toBeNull();
    }
    // interactive sessions only: a real answer, and the answer is none
    expect(
      parseBackgroundList(
        JSON.stringify([{ pid: 1, kind: "interactive", sessionId: SID.c, status: "busy" }]),
      ),
    ).toEqual([]);
    expect(parseBackgroundList(JSON.stringify([1, "x", null]))).toEqual([]);
  });

  it("a conversation backgrounded twice is the row with a live worker, else the newest", () => {
    const old = { sessionId: SID.a, id: "old", startedAt: 1 };
    const newer = { sessionId: SID.a, id: "new", startedAt: 2 };
    const live = { sessionId: SID.a, id: "live", pid: 9, startedAt: 0 };
    expect(bySession(old, newer).get(SID.a)?.id).toBe("new");
    expect(bySession(newer, old).get(SID.a)?.id).toBe("new");
    expect(bySession(live, newer).get(SID.a)?.id).toBe("live");
    expect(bySession(newer, live, old).get(SID.a)?.id).toBe("live");
  });
});

describe("a blocked background session in the inbox", () => {
  const blocked = (waitingFor?: string): BackgroundEntry => ({
    sessionId: SID.a,
    id: "d7b6bcc2",
    pid: 1,
    state: "blocked",
    ...(waitingFor ? { waitingFor } : {}),
  });

  it("a permission prompt reads as one, anything else is your turn, with what it waits on", () => {
    const m = new Map<string, LiveStatus>();
    expect(applyBackground(m, bySession(blocked("permission prompt")), 5000)).toBe(true);
    expect(m.get(SID.a)).toEqual({
      state: "permission",
      at: 5000,
      lastEventAt: 5000,
      detail: "permission prompt",
      source: "agents",
    });
    applyBackground(m, bySession(blocked("input needed")), 6000);
    expect(m.get(SID.a)).toMatchObject({ state: "waiting", detail: "input needed", at: 6000 });
    // blocked on its first prompt: nothing to name
    applyBackground(m, bySession(blocked()), 7000);
    expect(m.get(SID.a)).toEqual({
      state: "waiting",
      at: 7000,
      lastEventAt: 7000,
      source: "agents",
    });
  });

  it("a hook always wins: a combo's background session reports through its hooks", () => {
    const hook = status({ state: "running" });
    const m = new Map([[SID.a, hook]]);
    expect(applyBackground(m, bySession(blocked("permission prompt")), 5000)).toBe(false);
    expect(m.get(SID.a)).toBe(hook);
  });

  it("it does win over the registry, which only knew the process was busy", () => {
    const m = new Map([[SID.a, status({ state: "running", source: "registry" })]]);
    applyBackground(m, bySession(blocked("permission prompt")), 5000);
    expect(m.get(SID.a)).toMatchObject({ state: "permission", source: "agents" });
  });

  it("looked at stays looked at while it waits on the same thing", () => {
    const m = new Map<string, LiveStatus>();
    applyBackground(m, bySession(blocked("permission prompt")), 5000);
    m.set(SID.a, { ...(m.get(SID.a) as LiveStatus), seen: true });
    expect(applyBackground(m, bySession(blocked("permission prompt")), 9000)).toBe(false);
    expect(m.get(SID.a)).toMatchObject({ seen: true, at: 5000 });
    // a new question is a new reason to look
    applyBackground(m, bySession(blocked("input needed")), 9000);
    expect(m.get(SID.a)?.seen).toBeUndefined();
  });

  it("gone once it stops waiting, and only what it put there goes", () => {
    const hook = status({ state: "waiting" });
    const m = new Map<string, LiveStatus>([[SID.b, hook]]);
    applyBackground(m, bySession(blocked("permission prompt")), 5000);
    for (const state of ["working", "done", "failed", "stopped"]) {
      const next = new Map(m);
      expect(applyBackground(next, bySession({ ...blocked(), state }), 6000), state).toBe(true);
      expect(next.has(SID.a), state).toBe(false);
      expect(next.get(SID.b), state).toBe(hook);
    }
    // gone from the list altogether (`claude rm`)
    expect(applyBackground(m, new Map(), 6000)).toBe(true);
    expect([...m.keys()]).toEqual([SID.b]);
  });

  it("a working or finished session adds nothing: the inbox is for sessions waiting on someone", () => {
    const m = new Map<string, LiveStatus>();
    for (const state of ["working", "done", "failed", "stopped"]) {
      expect(applyBackground(m, bySession({ ...blocked(), state }), 5000)).toBe(false);
    }
    expect(m.size).toBe(0);
  });
});
