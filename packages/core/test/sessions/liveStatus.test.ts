import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  drainStatusEvents,
  EVENT_MAX_BYTES,
  lastParagraph,
  needsYou,
  parseStatusEvent,
  parseTruncatedEvent,
  reduceAgentRuns,
  reduceStatus,
  STATUS_HOOK_EVENTS,
  type StatusEvent,
  statusHookCommand,
  syncStatusHooks,
  watchStatusHooks,
  withStatusHooks,
} from "../../src/sessions/liveStatus.ts";
import type { LiveStatus } from "../../src/types.ts";
import { makeSandbox } from "../helpers/transcript.ts";

const SID = "aaaaaaaa-0000-4000-8000-000000000001";

/** a real fs.watch is behind these: poll rather than guess at a delay */
async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function run(events: Array<Partial<StatusEvent> & { event: string; at: number }>) {
  let s: LiveStatus | undefined;
  const trail: Array<string | undefined> = [];
  for (const e of events) {
    s = reduceStatus(s, { sessionId: SID, ...e });
    trail.push(s?.state);
  }
  return { s, trail };
}

describe("session status from hook events", () => {
  it("a turn: running, asks for permission, runs again, then it is your turn", () => {
    const { s, trail } = run([
      { event: "UserPromptSubmit", at: 1_000 },
      { event: "PostToolUse", at: 2_000, toolName: "Read" },
      { event: "PermissionRequest", at: 3_000, toolName: "Bash" },
      { event: "Notification", at: 9_000, notificationType: "permission_prompt" },
      { event: "PostToolUse", at: 20_000, toolName: "Bash" },
      { event: "Stop", at: 91_000, message: "all green,\n  pushed it" },
    ]);
    expect(trail).toEqual(["running", "running", "permission", "permission", "running", "waiting"]);
    expect(s).toMatchObject({ state: "waiting", turnMs: 90_000, detail: "all green, pushed it" });
    expect(needsYou(s)).toBe(true);
  });

  it("a subagent's tool calls do not wake a finished session, but its own do", () => {
    const done = run([
      { event: "UserPromptSubmit", at: 1 },
      { event: "Stop", at: 2 },
      { event: "PostToolUse", at: 3, agentId: "agent-1" },
    ]);
    expect(done.s?.state).toBe("waiting");
    expect(done.s?.lastEventAt).toBe(3);
    // a background task finishing starts a turn with no prompt
    const woke = run([
      { event: "UserPromptSubmit", at: 1 },
      { event: "Stop", at: 2 },
      { event: "PostToolUse", at: 5 },
    ]);
    expect(woke.s).toMatchObject({ state: "running", turnStart: 5 });
  });

  it("a subagent starting or stopping never moves the session's own state", () => {
    const { s, trail } = run([
      { event: "UserPromptSubmit", at: 1_000 },
      { event: "SubagentStart", at: 2_000, agentId: "agent-1", agentType: "Explore" },
      { event: "Stop", at: 3_000, message: "kicked off the survey" },
      // the agent outlives the turn, and its closing words are its own, not the session's
      {
        event: "SubagentStop",
        at: 60_000,
        agentId: "agent-1",
        agentType: "Explore",
        message: "found 12 call sites",
      },
    ]);
    expect(trail).toEqual(["running", "running", "waiting", "waiting"]);
    expect(s).toMatchObject({
      state: "waiting",
      detail: "kicked off the survey",
      lastEventAt: 60_000,
    });
  });

  it("the agent lifecycle is kept beside the session, and goes with it", () => {
    const ev = (event: string, at: number, extra: Partial<StatusEvent> = {}): StatusEvent => ({
      sessionId: SID,
      event,
      at,
      ...extra,
    });
    let runs = reduceAgentRuns(undefined, ev("SubagentStart", 10, { agentId: "a1" }));
    runs = reduceAgentRuns(
      runs,
      ev("SubagentStart", 20, { agentId: "a2", agentType: "long-task" }),
    );
    // every tool call inside an agent carries its id too, and says nothing about its lifecycle
    runs = reduceAgentRuns(runs, ev("PostToolUse", 25, { agentId: "a1", toolName: "Read" }));
    runs = reduceAgentRuns(runs, ev("SubagentStop", 30, { agentId: "a1" }));
    expect(runs).toEqual({
      a1: { startedAt: 10, stoppedAt: 30 },
      a2: { startedAt: 20, agentType: "long-task" },
    });
    // a stop with no start is all we know about an agent that began before the app was watching
    expect(reduceAgentRuns(undefined, ev("SubagentStop", 5, { agentId: "a9" }))).toEqual({
      a9: { stoppedAt: 5 },
    });
    expect(reduceAgentRuns(runs, ev("SessionEnd", 40))).toBeUndefined();
    expect(reduceAgentRuns(runs, ev("Stop", 40))).toBe(runs);
  });

  it("says what a permission prompt would do, and which agent asked, while it asks", () => {
    const ev = parseStatusEvent(
      {
        session_id: SID,
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "cd /work/api && pnpm test --filter api" },
        cwd: "/work/api",
        agent_id: "a1",
      },
      1,
    );
    expect(ev).toMatchObject({ toolName: "Bash", toolTarget: "pnpm test --filter api" });
    const asking = reduceStatus(undefined, ev!);
    expect(asking).toMatchObject({
      state: "permission",
      detail: "Bash",
      target: "pnpm test --filter api",
      agentId: "a1",
    });
    // the notification that follows says nothing new, and keeps what the request said
    const still = reduceStatus(asking, {
      sessionId: SID,
      event: "Notification",
      notificationType: "permission_prompt",
      message: "Claude needs your permission to use Bash",
      at: 2,
    });
    expect(still).toMatchObject({ target: "pnpm test --filter api", agentId: "a1" });
    // answered: running again, and the agent that asked is not asking any more
    const answered = reduceStatus(still, { sessionId: SID, event: "PostToolUse", at: 3 });
    expect(answered?.state).toBe("running");
    expect(answered?.agentId).toBeUndefined();
    expect(answered?.target).toBeUndefined();
  });

  it("keeps the end of the message a turn stopped on: the question is in its last paragraph", () => {
    const message = `Pieces 1-3 are committed.\n\n- the fold skips duplicates\n- the view is virtual\n\nWant me to push the branch, or wait for the review?`;
    const { s } = run([
      { event: "UserPromptSubmit", at: 1 },
      { event: "Stop", at: 2, message },
    ]);
    expect(s?.detail).toMatch(/^Pieces 1-3 are committed/);
    expect(s?.question).toBe("Want me to push the branch, or wait for the review?");
    expect(lastParagraph(`intro\n\n${"word ".repeat(200)}the end?`, 40)).toMatch(/^….*the end\?$/);
    expect(lastParagraph(`intro\n\n${"word ".repeat(200)}the end?`, 40).length).toBeLessThanOrEqual(
      40,
    );
  });

  it("a payload cut short still says which command wanted permission", () => {
    const cut = parseTruncatedEvent(
      `{"session_id":"${SID}","hook_event_name":"PermissionRequest","cwd":"/work/api","tool_name":"Write","tool_input":{"file_path":"/work/api/src/a.ts","content":"aaaa`,
    );
    expect(parseStatusEvent(cut, 1)).toMatchObject({ toolName: "Write", toolTarget: "src/a.ts" });
  });

  it("an API error, the end of a session, and seen", () => {
    expect(run([{ event: "StopFailure", at: 1, message: "overloaded" }]).s).toMatchObject({
      state: "failed",
      detail: "overloaded",
    });
    expect(
      run([
        { event: "Stop", at: 1 },
        { event: "SessionEnd", at: 2 },
      ]).s,
    ).toBeUndefined();
    const seen: LiveStatus = { state: "waiting", at: 1, lastEventAt: 1, seen: true };
    expect(needsYou(seen)).toBe(false);
    expect(needsYou(reduceStatus(seen, { sessionId: SID, event: "Stop", at: 5 }))).toBe(true);
    expect(needsYou({ state: "running", at: 1, lastEventAt: 1 })).toBe(false);
  });

  it("our hooks go in next to someone's own, and come out without touching them", () => {
    const theirs = { Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }] };
    const added = withStatusHooks(theirs, "echo x # grove-status");
    expect(added.Stop).toHaveLength(2);
    expect(Object.keys(added)).toEqual(
      expect.arrayContaining([
        "UserPromptSubmit",
        "PermissionRequest",
        "PostToolUse",
        "SessionEnd",
      ]),
    );
    // running it again replaces ours rather than stacking a second copy
    expect(withStatusHooks(added, "echo y # grove-status").Stop).toHaveLength(2);
    expect(withStatusHooks(added, null)).toEqual(theirs);
  });

  it("a settings file that is not JSON is left byte for byte", async () => {
    const dir = makeSandbox("grove-hooks-");
    const file = path.join(dir, "settings.json");
    writeFileSync(file, "{ nope");
    const r = await syncStatusHooks(file, path.join(dir, "events"), true);
    expect(r.status).toBe("skipped-invalid-json");
    expect(readFileSync(file, "utf8")).toBe("{ nope");

    const fresh = path.join(dir, "fresh.json");
    expect((await syncStatusHooks(fresh, path.join(dir, "events"), true)).status).toBe("created");
    expect((await syncStatusHooks(fresh, path.join(dir, "events"), true)).status).toBe("unchanged");
    writeFileSync(
      fresh,
      JSON.stringify({ model: "x", ...JSON.parse(readFileSync(fresh, "utf8")) }),
    );
    expect((await syncStatusHooks(fresh, path.join(dir, "events"), false)).status).toBe("written");
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({ model: "x" });
  });

  it("a session that puts the old hooks back is repaired, and repairing does not loop", async () => {
    const dir = path.join(makeSandbox("grove-hooks-"), ".claude");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.local.json");
    const events = path.join(dir, "events");
    expect((await syncStatusHooks(file, events, true)).status).toBe("created");

    const seen: string[] = [];
    const watcher = watchStatusHooks(file, events, {
      debounceMs: 30,
      onSync: (status) => seen.push(status),
    });
    expect(watcher).not.toBeNull();
    try {
      // fs.watch on a directory goes through FSEvents on macOS, and the stream starts on another
      // thread: a write can land before the watch is live. touch the file with its own bytes until
      // one comes back, so what follows is testing the repair and not the startup window.
      const asWritten = readFileSync(file, "utf8");
      for (let i = 0; i < 50 && seen.length === 0; i++) {
        writeFileSync(file, asWritten);
        await new Promise((r) => setTimeout(r, 200));
      }
      // an already-correct file is never rewritten, whichever touch got through
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((status) => status === "unchanged")).toBe(true);
      seen.length = 0;

      // what a session started before the upgrade writes back: the settings it loaded at startup,
      // without the two subagent events. not an atomic write - this is somebody else's write.
      const old = withStatusHooks({}, statusHookCommand(events));
      delete old.SubagentStart;
      delete old.SubagentStop;
      writeFileSync(file, JSON.stringify({ hooks: old }, null, 2));

      const hooks = () => Object.keys(JSON.parse(readFileSync(file, "utf8")).hooks);
      await until(() => hooks().length === STATUS_HOOK_EVENTS.length);
      expect(hooks()).toEqual(expect.arrayContaining(["SubagentStart", "SubagentStop"]));

      // our own repair comes back through the same watcher. it has to settle there: every write
      // renames a new file in, so a stable inode is proof that nothing wrote again.
      const settled = statSync(file).ino;
      await new Promise((r) => setTimeout(r, 300));
      expect(statSync(file).ino).toBe(settled);
      expect(seen.filter((s) => s === "written")).toEqual(["written"]);
      expect(seen.at(-1)).toBe("unchanged");
    } finally {
      watcher?.dispose();
    }
  });

  it("the hook command drops its stdin into the events dir, even with a quote in the path", async () => {
    const dir = path.join(makeSandbox("grove-hooks-"), "it's here", "events");
    const payload = JSON.stringify({ session_id: SID, hook_event_name: "Stop" });
    execFileSync("/bin/sh", ["-c", statusHookCommand(dir)], { input: payload });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    const events = await drainStatusEvents(dir);
    expect(events).toEqual([{ sessionId: SID, event: "Stop", at: expect.any(Number) }]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a huge payload is cut to its head, and the status still reads from what is left", async () => {
    const dir = path.join(makeSandbox("grove-hooks-"), "events");
    const payload = JSON.stringify({
      session_id: SID,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { stdout: "x".repeat(2_000_000) },
    });
    execFileSync("/bin/sh", ["-c", statusHookCommand(dir)], { input: payload });
    const [file] = readdirSync(dir);
    expect(statSync(path.join(dir, file!)).size).toBe(EVENT_MAX_BYTES);
    expect(await drainStatusEvents(dir)).toEqual([
      { sessionId: SID, event: "PostToolUse", toolName: "Bash", at: expect.any(Number) },
    ]);
  });

  it("events are read oldest first by mtime, and junk is dropped", async () => {
    const dir = makeSandbox("grove-events-");
    mkdirSync(dir, { recursive: true });
    const write = (name: string, body: string, secs: number) => {
      writeFileSync(path.join(dir, name), body);
      utimesSync(path.join(dir, name), secs, secs);
    };
    write("9-1.json", JSON.stringify({ session_id: SID, hook_event_name: "Stop" }), 200);
    write(
      "1-9.json",
      JSON.stringify({ session_id: SID, hook_event_name: "UserPromptSubmit" }),
      100,
    );
    write("5-5.json", "not json", 150);
    write("7-7.tmp", "still being written", 150);
    const events = await drainStatusEvents(dir);
    expect(events.map((e) => e.event)).toEqual(["UserPromptSubmit", "Stop"]);
    expect(readdirSync(dir)).toEqual(["7-7.tmp"]);
  });
});
