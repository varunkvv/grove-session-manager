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
import type { SessionTasks } from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  goneTasks,
  LiveService,
  parseTasks,
  TASKS_EXPIRY_MS,
  TASKS_GONE_MS,
} from "../../src/main/services/live.ts";
import { claudeTmpRoot, lastLine, taskOutputFile } from "../../src/main/services/taskOutput.ts";

const SID = {
  poll: "aaaaaaaa-0000-4000-8000-000000000001",
  other: "bbbbbbbb-0000-4000-8000-000000000002",
};
const SLUG = "-Users-you-claude-ws-chat-features";
const MIN = 60_000;

// what a real Stop lists (claude code 2.1.295). a Monitor comes as a shell
const WATCHER = {
  id: "br6y21j9k",
  type: "shell",
  status: "running",
  description: "tick watcher",
  command: "while true; do date; sleep 5; done",
};
const CRON = { id: "73e8c792", schedule: "*/5 * * * *", recurring: true, prompt: "say hi" };

const services: LiveService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

/**
 * a watch that was only just made can miss a write (docs/claude-code-facts.md, fs.watch): the
 * write is made again until what it should cause is there
 */
async function until(check: () => boolean, again: () => void) {
  for (let i = 0; i < 50 && !check(); i++) {
    again();
    await new Promise((r) => setTimeout(r, 100));
  }
}

function machine(o: { registry?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-live-tasks-")));
  const stateDir = path.join(dir, "state");
  const events = path.join(stateDir, "events");
  const registryDir = path.join(dir, "claude", "sessions");
  const tmpRoot = path.join(dir, "tmp", "claude-501");
  mkdirSync(events, { recursive: true });
  // without it there is no registry at all: an older Claude Code, another config folder
  if (o.registry !== false) mkdirSync(registryDir, { recursive: true });
  let n = 0;
  /** a Stop as the hook drops it, `agoMs` old: a task's `since` is its file's mtime */
  const stop = (sessionId: string, tasks: unknown[], crons: unknown[], agoMs = 0) => {
    const file = path.join(events, `${process.pid}-${++n}`);
    writeFileSync(
      `${file}.tmp`,
      JSON.stringify({
        session_id: sessionId,
        transcript_path: `/Users/you/.claude/projects/${SLUG}/${sessionId}.jsonl`,
        hook_event_name: "Stop",
        last_assistant_message: "done",
        background_tasks: tasks,
        session_crons: crons,
      }),
    );
    const when = new Date(Date.now() - agoMs + n);
    utimesSync(`${file}.tmp`, when, when);
    renameSync(`${file}.tmp`, `${file}.json`);
  };
  // this test process stands in for every pid: alive is all the registry checks
  const register = (name: string, sessionId: string) =>
    writeFileSync(
      path.join(registryDir, `${name}.json`),
      JSON.stringify({ pid: process.pid, sessionId, status: "idle", kind: "interactive" }),
    );
  const output = (sessionId: string, taskId: string, text: string) => {
    const file = path.join(tmpRoot, SLUG, sessionId, "tasks", `${taskId}.output`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  let seen: ReadonlyMap<string, SessionTasks> = new Map();
  /** how far the service's clock runs ahead of the real one */
  let ahead = 0;
  const skip = (ms: number) => {
    ahead += ms;
  };
  const start = async () => {
    const live = new LiveService({
      stateDir,
      claudeSettingsFile: path.join(dir, "claude", "settings.json"),
      registryDir,
      tmpRoot,
      now: () => Date.now() + ahead,
      onChange: (_statuses, _runs, _alive, tasks) => {
        seen = new Map(tasks);
      },
      onNeedsYou: () => {},
    });
    services.push(live);
    await live.start();
    return live;
  };
  const ids = (sessionId: string) => seen.get(sessionId)?.tasks.map((t) => t.id);
  return { stateDir, registryDir, stop, register, output, start, skip, ids, tasks: () => seen };
}

describe("what a session left running, in the live service", () => {
  it("reaches the rows with the last line its command wrote, and goes when a Stop lists nothing", async () => {
    const m = machine();
    m.register("1", SID.poll);
    m.stop(SID.poll, [WATCHER], [CRON], 2 * MIN);
    m.output(
      SID.poll,
      WATCHER.id,
      "Mon Oct 12 14:08:21 CDT 2026\n\u001b[32mMon Oct 12 14:08:26\u001b[0m\n",
    );
    const live = await m.start();
    expect(m.tasks().get(SID.poll)).toMatchObject({ slug: SLUG });
    expect(m.ids(SID.poll)).toEqual(["br6y21j9k", "73e8c792"]);
    expect(live.tasks().get(SID.poll)?.tasks[0]).toMatchObject({
      kind: "command",
      description: "tick watcher",
    });
    expect(live.taskLine(WATCHER.id)).toBe("Mon Oct 12 14:08:26");
    // a wake-up writes nowhere
    expect(live.taskLine(CRON.id)).toBeUndefined();

    await until(
      () => !m.tasks().has(SID.poll),
      () => m.stop(SID.poll, [], []),
    );
    expect(m.tasks().has(SID.poll)).toBe(false);
    expect(live.taskLine(WATCHER.id)).toBeUndefined();
  });

  it("a command under a minute old is kept, and not read yet", async () => {
    const m = machine();
    m.register("1", SID.poll);
    m.stop(SID.poll, [WATCHER], []);
    m.output(SID.poll, WATCHER.id, "tick\n");
    const live = await m.start();
    expect(m.ids(SID.poll)).toEqual(["br6y21j9k"]);
    expect(live.taskLine(WATCHER.id)).toBeUndefined();
  });

  it("survives a restart: between two wake-ups an hour apart no event says it again", async () => {
    const m = machine();
    m.register("1", SID.poll);
    m.stop(SID.poll, [], [CRON], 5 * MIN);
    const first = await m.start();
    const since = first.tasks().get(SID.poll)?.tasks[0]?.since;
    expect(since).toBeLessThan(Date.now() - 4 * MIN);
    first.dispose();
    const kept = JSON.parse(readFileSync(path.join(m.stateDir, "live-tasks.json"), "utf8"));
    expect(kept[SID.poll].tasks).toEqual([
      {
        id: "73e8c792",
        kind: "schedule",
        description: "say hi",
        schedule: "*/5 * * * *",
        recurring: true,
        since,
      },
    ]);

    const second = await m.start();
    expect(
      second
        .tasks()
        .get(SID.poll)
        ?.tasks.map((t) => [t.id, t.since]),
    ).toEqual([["73e8c792", since]]);
    expect(m.ids(SID.poll)).toEqual(["73e8c792"]);
  });

  it("is dropped when its process is gone, so a session that crashed holds nothing", async () => {
    const m = machine();
    m.register("1", SID.poll);
    m.register("2", SID.other);
    m.stop(SID.poll, [], [CRON]);
    m.stop(SID.other, [WATCHER], []);
    await m.start();
    expect([...m.tasks().keys()].sort()).toEqual([SID.poll, SID.other]);
    // the other session is still up: an empty registry would say nothing at all
    rmSync(path.join(m.registryDir, "1.json"));
    // one read without it is not enough: it has to stay missing
    await until(
      () => !m.tasks().has(SID.poll),
      () => {
        m.skip(TASKS_GONE_MS);
        m.register("2", SID.other);
      },
    );
    expect([...m.tasks().keys()]).toEqual([SID.other]);
  });

  it("a read that misses a live session keeps its tasks: its file was being rewritten", () => {
    const left = new Map([[SID.poll, { at: 0, tasks: [] }]]);
    const missing = new Map<string, number>();
    const alive = new Set([SID.poll]);
    expect(goneTasks(left, new Set(), true, missing, 1000)).toEqual([]);
    expect(goneTasks(left, new Set(), true, missing, 1000 + TASKS_GONE_MS - 1)).toEqual([]);
    // back in the next read: the wait starts over
    expect(goneTasks(left, alive, true, missing, 1000 + TASKS_GONE_MS)).toEqual([]);
    expect(missing.size).toBe(0);
    expect(goneTasks(left, new Set(), true, missing, 2 * TASKS_GONE_MS)).toEqual([]);
    expect(goneTasks(left, new Set(), true, missing, 3 * TASKS_GONE_MS)).toEqual([SID.poll]);
    expect(missing.size).toBe(0);
  });

  it("after a reboot nothing is alive, and nothing is held: an empty registry that is there says so", async () => {
    const m = machine();
    m.register("1", SID.poll);
    m.stop(SID.poll, [], [CRON]);
    const first = await m.start();
    expect(m.ids(SID.poll)).toEqual(["73e8c792"]);
    first.dispose();
    // the machine went down with the session open: no Stop, no SessionEnd, and no process after
    rmSync(path.join(m.registryDir, "1.json"));
    const second = await m.start();
    expect(second.tasks().size).toBe(0);
    expect(m.tasks().size).toBe(0);
  });

  it("with no registry at all, is kept for a day after its last Stop and no longer", async () => {
    const m = machine({ registry: false });
    m.stop(SID.poll, [], [CRON], TASKS_EXPIRY_MS + MIN);
    m.stop(SID.other, [], [CRON], TASKS_EXPIRY_MS - MIN);
    await m.start();
    expect([...m.tasks().keys()]).toEqual([SID.other]);
  });

  it("the kept file is read defensively", () => {
    const task = { id: "t1", kind: "command", description: "watch", since: 5 };
    expect(
      parseTasks({
        a: { at: 9, slug: "s", tasks: [task, { id: "t2" }, "x", { ...task, kind: "agent" }] },
        b: { at: 9, tasks: [] },
        c: { tasks: [task] },
        d: 3,
      }),
    ).toEqual(new Map([["a", { at: 9, slug: "s", tasks: [task] }]]));
    expect(parseTasks(null).size).toBe(0);
    expect(parseTasks([1]).size).toBe(0);
  });
});

describe("the last line a background command wrote", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-task-output-")));
  const file = (name: string, text: string) => {
    const f = path.join(dir, name);
    writeFileSync(f, text);
    return f;
  };

  it("is plain text: colours stripped, the newline at the end not a line", async () => {
    const f = file(
      "a.output",
      "building\n\u001b[1m\u001b[32m✓\u001b[0m 12 passed \u001b[2m(3.1s)\u001b[22m\n\n",
    );
    expect(await lastLine(f)).toBe("✓ 12 passed (3.1s)");
    // a link and a title are sequences too
    const osc = file(
      "b.output",
      "\u001b]0;deploy\u0007\u001b]8;;https://x.test\u001b\\open\u001b]8;;\u001b\\ it\n",
    );
    expect(await lastLine(osc)).toBe("open it");
  });

  it("a progress bar that redraws its line: the last thing drawn", async () => {
    expect(await lastLine(file("c.output", "start\n 10%\r 55%\r 80%"))).toBe("80%");
  });

  it("reads the end of a long file, and cuts a long line", async () => {
    const f = file("d.output", `${"x".repeat(20_000)}\n${"y".repeat(500)}\n`);
    expect(await lastLine(f)).toBe("y".repeat(200));
  });

  it("a missing file, an empty one and a folder are no line, never an error", async () => {
    expect(await lastLine(path.join(dir, "nope.output"))).toBeUndefined();
    expect(await lastLine(file("e.output", ""))).toBeUndefined();
    expect(await lastLine(file("f.output", "\n\n"))).toBeUndefined();
    expect(await lastLine(dir)).toBeUndefined();
  });

  it("is looked for under Claude Code's temp folder, and never outside it", () => {
    expect(taskOutputFile("/tmp/claude-501", SLUG, SID.poll, "br6y21j9k")).toBe(
      `/tmp/claude-501/${SLUG}/${SID.poll}/tasks/br6y21j9k.output`,
    );
    expect(taskOutputFile("/tmp/claude-501", SLUG, SID.poll, "../../x")).toBeUndefined();
    expect(taskOutputFile("/tmp/claude-501", "..", SID.poll, "b1")).toBeUndefined();
    expect(taskOutputFile("/tmp/claude-501", SLUG, "a/b", "b1")).toBeUndefined();
    const uid = process.getuid?.() ?? 0;
    expect(claudeTmpRoot({})).toBe(`/tmp/claude-${uid}`);
    expect(claudeTmpRoot({ CLAUDE_CODE_TMPDIR: "/var/work" })).toBe(`/var/work/claude-${uid}`);
  });
});
