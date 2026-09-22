import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyRegistry,
  isProcessAlive,
  parseRegistryEntry,
  type RegistryEntry,
  readRegistry,
  sessionsRegistryDir,
} from "../../src/sessions/registry.ts";
import type { LiveStatus } from "../../src/types.ts";

// real `~/.claude/sessions/<pid>.json` files with the paths, ids and names replaced
const fixtures = path.join(import.meta.dirname, "../fixtures/sessions");

const SID = {
  busy: "aaaaaaaa-0000-4000-8000-000000000001",
  idle: "bbbbbbbb-0000-4000-8000-000000000002",
  torn: "cccccccc-0000-4000-8000-000000000003",
  dead: "dddddddd-0000-4000-8000-000000000004",
};

function entry(sessionId: string, status: string, pid = 1): RegistryEntry {
  return { pid, sessionId, status };
}

function status(s: Partial<LiveStatus> & { state: LiveStatus["state"] }): LiveStatus {
  return { at: 1000, lastEventAt: 1000, ...s };
}

describe("the live session registry", () => {
  it("keeps what it understands and refuses the rest", () => {
    expect(
      parseRegistryEntry({ pid: 7, sessionId: SID.busy, status: "busy", cwd: "/x", kind: 3 }),
    ).toEqual({ pid: 7, sessionId: SID.busy, status: "busy", cwd: "/x" });
    for (const bad of [
      null,
      "busy",
      [],
      {},
      { pid: 7, sessionId: SID.busy },
      { pid: 7, status: "busy" },
      { sessionId: SID.busy, status: "busy" },
      { pid: 0, sessionId: SID.busy, status: "busy" },
      { pid: -1, sessionId: SID.busy, status: "busy" },
      { pid: 7.5, sessionId: SID.busy, status: "busy" },
      { pid: "7", sessionId: SID.busy, status: "busy" },
      { pid: 7, sessionId: "", status: "busy" },
      { pid: 7, sessionId: SID.busy, status: "" },
    ]) {
      expect(parseRegistryEntry(bad), JSON.stringify(bad)).toBeNull();
    }
    // a status nobody has seen yet still proves the process is up
    expect(parseRegistryEntry({ pid: 7, sessionId: SID.busy, status: "dispatched" })).toMatchObject(
      {
        status: "dispatched",
      },
    );
  });

  it("reads the directory, confirms every pid, and never opens a .key file", async () => {
    const alive = new Set([41001, 41002]);
    const entries = await readRegistry(fixtures, (pid) => alive.has(pid));
    expect(entries.map((e) => e.sessionId).sort()).toEqual([SID.busy, SID.idle]);
    expect(entries.find((e) => e.sessionId === SID.busy)).toMatchObject({
      pid: 41001,
      status: "busy",
      cwd: "/Users/you/claude-ws/queue",
      name: "queue-2d",
      entrypoint: "claude-vscode",
      version: "2.1.278",
    });
    // 41003 is a torn write, 41004's process is gone, the .key is not a <pid>.json
    expect(entries).toHaveLength(2);
    expect(await readRegistry(path.join(fixtures, "nope"))).toEqual([]);
  });

  it("this process is alive, pid 1 belongs to root, and a made-up pid is not", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(1)).toBe(true);
    expect(isProcessAlive(0x7ffffff0)).toBe(false);
  });

  it("hook state wins: busy never overwrites a session that is asking for something", () => {
    const statuses = new Map<string, LiveStatus>([
      [SID.busy, status({ state: "permission", detail: "Bash" })],
      [SID.idle, status({ state: "waiting", detail: "done" })],
    ]);
    const changed = applyRegistry(
      statuses,
      [entry(SID.busy, "busy"), entry(SID.idle, "busy", 2)],
      5000,
    );
    expect(changed).toBe(false);
    expect(statuses.get(SID.busy)).toMatchObject({ state: "permission", detail: "Bash" });
    expect(statuses.get(SID.idle)).toMatchObject({ state: "waiting" });
  });

  it("a running session whose process is gone is not running", () => {
    const statuses = new Map<string, LiveStatus>([
      [SID.busy, status({ state: "running" })],
      [SID.dead, status({ state: "running" })],
      [SID.torn, status({ state: "permission" })],
    ]);
    expect(applyRegistry(statuses, [entry(SID.busy, "busy")], 5000)).toBe(true);
    expect(statuses.has(SID.dead)).toBe(false);
    expect(statuses.get(SID.busy)).toMatchObject({ state: "running" });
    // the plan stops at running: a permission prompt nobody can answer is still worth showing
    expect(statuses.get(SID.torn)).toMatchObject({ state: "permission" });
  });

  it("an empty read is a missing registry, not a machine with no sessions", () => {
    const statuses = new Map<string, LiveStatus>([[SID.busy, status({ state: "running" })]]);
    expect(applyRegistry(statuses, [], 5000)).toBe(false);
    expect(statuses.get(SID.busy)).toMatchObject({ state: "running" });
  });

  it("fills a session no hook covers, and retires it when the process goes quiet", () => {
    const statuses = new Map<string, LiveStatus>();
    expect(
      applyRegistry(
        statuses,
        [
          { pid: 41001, sessionId: SID.busy, status: "busy", statusUpdatedAt: 4000 },
          { pid: 41002, sessionId: SID.idle, status: "idle" },
        ],
        5000,
      ),
    ).toBe(true);
    // idle asks nothing of anyone, so it stays out of the list entirely
    expect([...statuses.keys()]).toEqual([SID.busy]);
    expect(statuses.get(SID.busy)).toEqual({
      state: "running",
      at: 4000,
      lastEventAt: 5000,
      source: "registry",
    });

    expect(applyRegistry(statuses, [entry(SID.idle, "idle")], 9000)).toBe(true);
    expect(statuses.size).toBe(0);
  });

  it("a real hook event takes a registry session over, and keeps it", () => {
    const statuses = new Map<string, LiveStatus>([
      [SID.busy, status({ state: "permission", detail: "Bash" })],
    ]);
    // the hook said permission; the process is still busy, which must not undo it
    expect(applyRegistry(statuses, [entry(SID.busy, "busy")], 5000)).toBe(false);
    expect(statuses.get(SID.busy)).toMatchObject({ state: "permission" });
    expect(statuses.get(SID.busy)?.source).toBeUndefined();
  });

  it("the directory sits next to projects/ in the config dir", () => {
    expect(sessionsRegistryDir("/Users/you/.claude")).toBe("/Users/you/.claude/sessions");
  });
});
