import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LiveStatus } from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import { LiveService } from "../../src/main/services/live.ts";

const S = "aaaaaaaa-0000-4000-8000-000000000001";

const services: LiveService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

/** the events watch can miss a write it was only just set up for: the 10s poll drains it then */
async function until(check: () => boolean) {
  for (let i = 0; i < 750 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
}

/** a machine with an events dir and claude's session registry, both written by the test */
function machine() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-live-registry-")));
  const stateDir = path.join(dir, "state");
  const eventsDir = path.join(stateDir, "events");
  const registryDir = path.join(dir, "claude", "sessions");
  mkdirSync(eventsDir, { recursive: true });
  mkdirSync(registryDir, { recursive: true });
  let n = 0;
  /** a hook event whose file is `agoMs` old: its mtime is its time */
  const hook = (e: Record<string, unknown>, agoMs: number) => {
    const file = path.join(eventsDir, `${process.pid}-${++n}`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ session_id: S, ...e }));
    const when = new Date(Date.now() - agoMs);
    utimesSync(`${file}.tmp`, when, when);
    // renamed in, as the hook does
    renameSync(`${file}.tmp`, `${file}.json`);
  };
  // this test process stands in for claude: it is alive, which is all the registry checks
  const register = (o: Record<string, unknown>) =>
    writeFileSync(
      path.join(registryDir, "1.json"),
      JSON.stringify({ pid: process.pid, sessionId: S, kind: "interactive", ...o }),
    );
  const needs: LiveStatus[] = [];
  const start = async () => {
    const live = new LiveService({
      stateDir,
      claudeSettingsFile: path.join(dir, "claude", "settings.json"),
      registryDir,
      onChange: () => {},
      onNeedsYou: (_id, status) => needs.push(status),
    });
    services.push(live);
    await live.start();
    // a watch only just made can miss a write: give it a moment, the 10s poll covers the rest
    await new Promise((r) => setTimeout(r, 200));
    return live;
  };
  return { hook, register, start, needs, eventsDir };
}

describe("the registry in the live service", () => {
  it("an ask the registry says was approved is running at start, read after the events", async () => {
    const m = machine();
    m.hook({ hook_event_name: "UserPromptSubmit" }, 20_000);
    m.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash" }, 10_000);
    m.register({ status: "busy", statusUpdatedAt: Date.now() - 5_000 });
    const live = await m.start();
    expect(live.list().get(S)?.state).toBe("running");
  });

  it("an ask drained after the registry said busy is cleared in the same drain, and never told", async () => {
    const m = machine();
    m.hook({ hook_event_name: "UserPromptSubmit" }, 20_000);
    m.register({ status: "busy", statusUpdatedAt: Date.now() - 5_000 });
    const live = await m.start();
    expect(live.list().get(S)?.state).toBe("running");
    // its async hook wrote the file before the approval, and grove reads it only now
    m.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash" }, 8_000);
    await until(() => readdirSync(m.eventsDir).length === 0);
    expect(readdirSync(m.eventsDir)).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(live.list().get(S)?.state).toBe("running");
    expect(m.needs).toEqual([]);
  }, 20_000);

  it("an ask from a session no hook covers is told once, and not on the first read", async () => {
    const m = machine();
    m.register({ status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: Date.now() });
    const live = await m.start();
    // already waiting when grove started: in needs-you, not told
    expect(live.list().get(S)).toMatchObject({ state: "permission", source: "registry" });
    expect(m.needs).toEqual([]);
    m.register({ status: "busy", statusUpdatedAt: Date.now() });
    await until(() => live.list().get(S)?.state === "running");
    expect(live.list().get(S)?.state).toBe("running");
    const at = Date.now();
    m.register({ status: "waiting", waitingFor: "input needed", statusUpdatedAt: at });
    await until(() => m.needs.length > 0);
    expect(m.needs).toMatchObject([{ state: "permission", detail: "input needed", at }]);
    // read again, the same ask is not told again
    m.register({ status: "waiting", waitingFor: "input needed", statusUpdatedAt: at, name: "x" });
    await new Promise((r) => setTimeout(r, 300));
    expect(m.needs).toHaveLength(1);
  }, 40_000);
});
