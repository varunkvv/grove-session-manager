import path from "node:path";
import { describe, expect, it } from "vitest";
import { reduceStatus } from "../../src/sessions/liveStatus.ts";
import {
  applyApprovals,
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

// probe8 (claude 2.1.296, sdk 0.3.296, a Bash ask approved after 3s): the ask at 6.15s and its
// PermissionRequest hook file at 6.18s, the registry `waiting` from 6.15s, `busy` from the approval
// at 9.15s, and no hook until PostToolUse at 15.5s
describe("an ask approved with no hook to say so", () => {
  const S = SID.busy;
  const ask = (): LiveStatus => ({
    state: "permission",
    at: 6180,
    lastEventAt: 6180,
    turnStart: 600,
    detail: "Bash",
    target: "curl -s https://example.com",
  });
  const reg = (status: string, statusUpdatedAt: number): RegistryEntry => ({
    pid: 1,
    sessionId: S,
    status,
    statusUpdatedAt,
  });

  it("goes on as running once the registry says busy after the ask", () => {
    const statuses = new Map([[S, ask()]]);
    expect(applyApprovals(statuses, [reg("waiting", 6150)])).toBe(false);
    expect(statuses.get(S)?.state).toBe("permission");
    expect(applyApprovals(statuses, [reg("busy", 9150)])).toBe(true);
    expect(statuses.get(S)).toEqual({
      state: "running",
      at: 9150,
      lastEventAt: 9150,
      turnStart: 600,
    });
  });

  it("a busy from before the ask is no answer: a fast approval waits for its PostToolUse", () => {
    const statuses = new Map([[S, ask()]]);
    // the turn's own busy, before the registry flipped to waiting
    expect(applyApprovals(statuses, [reg("busy", 600)])).toBe(false);
    // approved before the async hook's file landed
    expect(applyApprovals(statuses, [reg("busy", 6170)])).toBe(false);
    expect(statuses.get(S)).toEqual(ask());
  });

  it("a registry read before the ask's event is drained clears it after the drain", () => {
    const statuses = new Map<string, LiveStatus>([
      [S, { state: "running", at: 600, lastEventAt: 600, turnStart: 600 }],
    ]);
    const read = [reg("busy", 9150)];
    expect(applyApprovals(statuses, read)).toBe(false);
    const late = reduceStatus(statuses.get(S), {
      sessionId: S,
      event: "PermissionRequest",
      at: 6180,
      toolName: "Bash",
    });
    statuses.set(S, late as LiveStatus);
    expect(applyApprovals(statuses, read)).toBe(true);
    expect(statuses.get(S)).toMatchObject({ state: "running", at: 9150 });
  });

  it("an agent's ask after the turn ended goes back to the turn's end", () => {
    // probe8's background agent: the main Stop at 4.87s, its Bash ask at 5.32s, approved at 8.29s
    const ended: LiveStatus = {
      state: "waiting",
      at: 4870,
      lastEventAt: 4870,
      turnStart: 610,
      turnMs: 4260,
      agentsLeft: 1,
    };
    const asking = reduceStatus(ended, {
      sessionId: S,
      event: "PermissionRequest",
      at: 5320,
      toolName: "Bash",
      agentId: "a1",
    }) as LiveStatus;
    const statuses = new Map([[S, asking]]);
    expect(applyApprovals(statuses, [reg("busy", 8290)])).toBe(true);
    expect(statuses.get(S)).toEqual({ ...ended, lastEventAt: 8290 });
  });

  it("leaves alone what the registry or the supervisor said, and a session the read does not list", () => {
    const fromRegistry = { ...ask(), source: "registry" as const };
    const fromAgents = { ...ask(), source: "agents" as const };
    const statuses = new Map<string, LiveStatus>([
      [S, fromRegistry],
      [SID.idle, fromAgents],
      [SID.torn, ask()],
    ]);
    expect(
      applyApprovals(statuses, [reg("busy", 9150), { ...reg("busy", 9150), sessionId: SID.idle }]),
    ).toBe(false);
    expect([...statuses.values()]).toEqual([fromRegistry, fromAgents, ask()]);
  });
});

// probe8 and probe9 (claude 2.1.296, sdk 0.3.296, a folder with no hooks): a Bash ask and an
// ExitPlanMode wait on "permission prompt", an AskUserQuestion on "input needed". each is stamped
// when the ask opens and flips to busy at the answer
describe("an ask from a session no hook covers", () => {
  const S = SID.busy;
  const waiting = (statusUpdatedAt: number, waitingFor = "permission prompt"): RegistryEntry => ({
    pid: 1,
    sessionId: S,
    status: "waiting",
    waitingFor,
    statusUpdatedAt,
  });

  it("reads what the process waits for", () => {
    expect(
      parseRegistryEntry({ pid: 7, sessionId: S, status: "waiting", waitingFor: "input needed" }),
    ).toEqual({ pid: 7, sessionId: S, status: "waiting", waitingFor: "input needed" });
  });

  it("is a permission while the registry says it waits on an ask, running at busy, gone at idle", () => {
    const statuses = new Map<string, LiveStatus>();
    expect(applyRegistry(statuses, [{ ...entry(S, "busy"), statusUpdatedAt: 600 }], 1000)).toBe(
      true,
    );
    expect(applyRegistry(statuses, [waiting(6150)], 7000)).toBe(true);
    expect(statuses.get(S)).toEqual({
      state: "permission",
      at: 6150,
      lastEventAt: 7000,
      detail: "permission prompt",
      source: "registry",
    });
    expect(applyRegistry(statuses, [waiting(9000, "input needed")], 9500)).toBe(true);
    expect(statuses.get(S)).toMatchObject({ detail: "input needed", at: 9000 });
    expect(
      applyRegistry(statuses, [{ ...entry(S, "busy"), statusUpdatedAt: 12_000 }], 12_500),
    ).toBe(true);
    expect(statuses.get(S)).toMatchObject({ state: "running", at: 12_000, source: "registry" });
    expect(applyRegistry(statuses, [entry(S, "idle")], 20_000)).toBe(true);
    expect(statuses.has(S)).toBe(false);
    // a session that only ever waited is filled too
    expect(applyRegistry(statuses, [waiting(21_000)], 21_500)).toBe(true);
    expect(statuses.get(S)?.state).toBe("permission");
  });

  it("keeps whether someone looked while the same ask stands, and not past it", () => {
    const statuses = new Map<string, LiveStatus>();
    applyRegistry(statuses, [waiting(6150)], 7000);
    statuses.set(S, { ...(statuses.get(S) as LiveStatus), seen: true });
    expect(applyRegistry(statuses, [waiting(6150)], 17_000)).toBe(false);
    expect(statuses.get(S)?.seen).toBe(true);
    // the next ask is new
    applyRegistry(statuses, [waiting(30_000)], 30_500);
    expect(statuses.get(S)?.seen).toBeUndefined();
  });

  it("a hook status wins, and waiting on something else is no ask", () => {
    const hooked = status({ state: "running" });
    const statuses = new Map<string, LiveStatus>([[S, hooked]]);
    expect(applyRegistry(statuses, [waiting(6150)], 7000)).toBe(false);
    expect(statuses.get(S)).toBe(hooked);
    const none = new Map<string, LiveStatus>();
    expect(applyRegistry(none, [waiting(6150, "something new")], 7000)).toBe(false);
    expect(none.size).toBe(0);
  });
});
