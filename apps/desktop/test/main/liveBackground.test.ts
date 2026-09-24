import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackgroundEntry, LiveStatus } from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import { expireStatuses, LiveService } from "../../src/main/services/live.ts";

const SID = {
  bg: "aaaaaaaa-0000-4000-8000-000000000001",
  panel: "bbbbbbbb-0000-4000-8000-000000000002",
};

const services: LiveService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

function machine() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-live-bg-")));
  const registryDir = path.join(dir, "claude", "sessions");
  mkdirSync(registryDir, { recursive: true });
  const moved: number[] = [];
  const needs: Array<{ id: string; status: LiveStatus }> = [];
  let last: ReadonlyMap<string, LiveStatus> = new Map();
  const live = new LiveService({
    stateDir: path.join(dir, "state"),
    claudeSettingsFile: path.join(dir, "claude", "settings.json"),
    registryDir,
    onChange: (statuses) => {
      last = new Map(statuses);
    },
    onNeedsYou: (id, status) => needs.push({ id, status }),
    onBackgroundMoved: () => moved.push(Date.now()),
  });
  services.push(live);
  // this test process stands in for every pid: it is alive, which is all the registry checks
  const register = (name: string, o: Record<string, unknown>) =>
    writeFileSync(
      path.join(registryDir, `${name}.json`),
      JSON.stringify({ pid: process.pid, ...o }),
    );
  return { live, registryDir, register, moved, needs, statuses: () => last };
}

const blocked = (waitingFor: string): ReadonlyMap<string, BackgroundEntry> =>
  new Map([[SID.bg, { sessionId: SID.bg, id: "d7b6bcc2", pid: 1, state: "blocked", waitingFor }]]);

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
}

describe("background sessions in the live service", () => {
  it("says who holds a session, and when a background process comes, changes or goes", async () => {
    const m = machine();
    m.register("1", {
      sessionId: SID.panel,
      status: "idle",
      kind: "interactive",
      entrypoint: "claude-vscode",
    });
    m.register("2", { sessionId: SID.bg, status: "busy", kind: "bg", entrypoint: "cli" });
    await m.live.start();
    expect(m.live.holder(SID.panel)).toMatchObject({
      kind: "interactive",
      entrypoint: "claude-vscode",
    });
    expect(m.live.holder(SID.bg)).toMatchObject({ kind: "bg" });
    expect(m.moved).toHaveLength(1);

    // an interactive session moving is none of the supervisor's business
    m.register("1", { sessionId: SID.panel, status: "busy", kind: "interactive" });
    await new Promise((r) => setTimeout(r, 300));
    expect(m.moved).toHaveLength(1);

    // the background one waiting on someone is worth asking about
    m.register("2", { sessionId: SID.bg, status: "waiting", kind: "bg" });
    await until(() => m.moved.length === 2);
    expect(m.moved).toHaveLength(2);

    rmSync(path.join(m.registryDir, "2.json"));
    await until(() => m.moved.length === 3);
    expect(m.moved).toHaveLength(3);
    expect(m.live.holder(SID.bg)).toBeUndefined();
  });

  it("a blocked one lands in the inbox, and only a change after the first read notifies", async () => {
    const m = machine();
    await m.live.start();
    m.live.applyBackground(blocked("permission prompt"));
    expect(m.statuses().get(SID.bg)).toMatchObject({ state: "permission", source: "agents" });
    // already blocked when the app came up: in the inbox, but no notification
    expect(m.needs).toEqual([]);
    m.live.applyBackground(new Map());
    expect(m.statuses().has(SID.bg)).toBe(false);
    m.live.applyBackground(blocked("input needed"));
    expect(m.needs.map((n) => [n.id, n.status.state, n.status.detail])).toEqual([
      [SID.bg, "waiting", "input needed"],
    ]);
    // looked at, then read again: still looked at, and no second notification
    m.live.markSeen([SID.bg]);
    m.live.applyBackground(blocked("input needed"));
    expect(m.statuses().get(SID.bg)?.seen).toBe(true);
    expect(m.needs).toHaveLength(1);
  });

  it("the supervisor's word has no shelf life and is never stored", () => {
    const now = 1e12;
    const m = new Map<string, LiveStatus>([
      [SID.bg, { state: "waiting", at: 0, lastEventAt: 0, source: "agents" }],
    ]);
    expect(expireStatuses(m, now)).toBe(false);
    expect(m.has(SID.bg)).toBe(true);
  });
});
