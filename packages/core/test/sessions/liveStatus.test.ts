import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  drainStatusEvents,
  EVENT_MAX_BYTES,
  needsYou,
  reduceStatus,
  type StatusEvent,
  statusHookCommand,
  syncStatusHooks,
  withStatusHooks,
} from "../../src/sessions/liveStatus.ts";
import type { LiveStatus } from "../../src/types.ts";
import { makeSandbox } from "../helpers/transcript.ts";

const SID = "aaaaaaaa-0000-4000-8000-000000000001";

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
