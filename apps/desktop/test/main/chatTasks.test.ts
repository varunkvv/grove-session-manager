import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatTasks } from "../../src/main/services/chatTasks.ts";

/**
 * the probe's live run (2026-10-26, claude 2.1.310): a background Bash, two Monitors (one stopped
 * with stopTask), a ScheduleWakeup that fired 2 minutes later, and every Stop hook's input. only
 * the task frames, tool calls and results are kept
 */
const recording = readFileSync(join(__dirname, "../fixtures/chat-tasks.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { at: number; frame?: unknown; stop?: unknown });

const t0 = recording[0]!.at;

/** the list as it stood at each second of the run */
function replay(until: number) {
  const tasks = new ChatTasks();
  for (const r of recording) {
    if (r.at - t0 > until * 1000) break;
    if (r.frame) tasks.take(r.frame, r.at);
    if (r.stop) tasks.stop(r.stop, r.at);
  }
  return tasks.tasks;
}

const row = (t: { kind: string; monitor?: boolean; description: string }) =>
  `${t.kind}${t.monitor ? "/monitor" : ""}: ${t.description}`;

describe("a chat's background tasks, from its stream", () => {
  it("each shows as its frame comes, and leaves as it ends", () => {
    expect(replay(0).map(row)).toEqual([]);
    // the Bash, 0.1s after its call
    expect(replay(1).map(row)).toEqual(["command: Run delayed echo in background"]);
    expect(replay(1)[0]).toMatchObject({ command: "sleep 40; echo done" });
    // both Monitors, and the wake-up from its tool result: no Stop yet
    expect(replay(8).map(row)).toEqual([
      "command: Run delayed echo in background",
      "command/monitor: ticker",
      "command/monitor: forever",
      "schedule: probe wake: reply with just the word awake",
    ]);
    // stopTask on the persistent Monitor: gone in the same ms
    expect(replay(28).map(row)).toEqual([
      "command: Run delayed echo in background",
      "command/monitor: ticker",
      "schedule: probe wake: reply with just the word awake",
    ]);
    expect(replay(38).map(row)).toEqual([
      "command: Run delayed echo in background",
      "schedule: probe wake: reply with just the word awake",
    ]);
    expect(replay(44).map(row)).toEqual(["schedule: probe wake: reply with just the word awake"]);
    // the wake-up firing takes it, before its turn's Stop
    expect(replay(130).map(row)).toEqual([]);
  });

  it("a wake-up keeps when it was first seen and when it fires through the Stop's crons", () => {
    const before = replay(9).find((t) => t.kind === "schedule")!;
    const after = replay(60).find((t) => t.kind === "schedule")!;
    expect(after.since).toBe(before.since);
    expect(after.wakesAt).toBe(before.wakesAt);
    // the Stop's own id, from session_crons
    expect(after.id).toBe("8a43fcd6");
  });

  it("an ended task never comes back from a late task_started", () => {
    const tasks = new ChatTasks();
    tasks.take(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "ls" } }],
        },
      },
      1,
    );
    tasks.take({ type: "system", subtype: "background_tasks_changed", tasks: [] }, 2);
    tasks.take(
      {
        type: "system",
        subtype: "task_started",
        task_id: "b1",
        tool_use_id: "u1",
        task_type: "local_bash",
      },
      3,
    );
    expect(tasks.tasks).toEqual([]);
  });

  it("a subagent is not one of them, and a cut Stop payload is unknown, not none", () => {
    const tasks = new ChatTasks();
    tasks.take(
      {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "a1", task_type: "local_agent", description: "Explore" },
          { task_id: "b1", task_type: "local_bash", description: "build" },
        ],
      },
      1,
    );
    tasks.stop(
      { session_crons: [{ id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "check" }] },
      2,
    );
    expect(tasks.tasks.map((t) => t.id)).toEqual(["b1", "c1"]);
    expect(tasks.stop({}, 3)).toBe(false);
    expect(tasks.tasks.map((t) => t.id)).toEqual(["b1", "c1"]);
    // a repeating cron firing stays
    tasks.take(
      { type: "command_lifecycle", state: "started", wakeup_source: "cron", scheduled_for: 5 },
      5,
    );
    expect(tasks.tasks.map((t) => t.id)).toEqual(["b1", "c1"]);
    expect(tasks.clear()).toBe(true);
    expect(tasks.tasks).toEqual([]);
  });
});
