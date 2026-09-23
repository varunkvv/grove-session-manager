import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STATUS_HOOK_EVENTS,
  statusEventsDir,
  statusHookCommand,
  withStatusHooks,
} from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import { LiveService } from "../../src/main/services/live.ts";

const services: LiveService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

function machine() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-user-hooks-")));
  const claudeDir = path.join(dir, "claude");
  mkdirSync(claudeDir);
  const settings = path.join(claudeDir, "settings.json");
  // somebody's own settings, which must come through every write untouched
  writeFileSync(settings, JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }));
  const stateDir = path.join(dir, "state");
  const live = new LiveService({
    stateDir,
    claudeSettingsFile: settings,
    registryDir: path.join(claudeDir, "sessions"),
    onChange: () => {},
    onNeedsYou: () => {},
    hookDebounceMs: 30,
  });
  services.push(live);
  return { settings, live, events: statusEventsDir(stateDir) };
}

const hookEvents = (file: string) =>
  Object.keys(JSON.parse(readFileSync(file, "utf8")).hooks ?? {}).sort();

/** what a session started before the hook set changed writes back: the old set, and nothing else of ours */
function revert(settings: string, events: string) {
  const old = withStatusHooks({}, statusHookCommand(events));
  delete old.SubagentStart;
  delete old.SubagentStop;
  const theirs = JSON.parse(readFileSync(settings, "utf8"));
  writeFileSync(settings, JSON.stringify({ ...theirs, hooks: old }, null, 2));
}

describe("the user-wide hooks", () => {
  it("are put back when a session outside any combo writes the old set over them", {
    timeout: 20_000,
  }, async () => {
    const { settings, live, events } = machine();
    await live.trackAllSessions(true);
    expect(hookEvents(settings)).toEqual([...STATUS_HOOK_EVENTS].sort());

    // FSEvents starts on another thread: a write can land before the watch is live, and then
    // nothing is delivered for it at all. revert until one repair comes back, so this is testing
    // the repair and not the startup window.
    const whole = () => hookEvents(settings).length === STATUS_HOOK_EVENTS.length;
    let repaired = false;
    for (let i = 0; i < 20 && !repaired; i++) {
      revert(settings, events);
      expect(whole()).toBe(false);
      for (let t = 0; t < 8 && !repaired; t++) {
        await new Promise((r) => setTimeout(r, 50));
        repaired = whole();
      }
    }
    expect(repaired).toBe(true);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash(ls)"] });

    // the repair comes back through the watch too, and settles there: nothing writes again
    const settled = statSync(settings).ino;
    await new Promise((r) => setTimeout(r, 300));
    expect(statSync(settings).ino).toBe(settled);
  });

  it("are left alone once tracking is off, and focus puts back what the watch missed", async () => {
    const { settings, live, events } = machine();
    await live.trackAllSessions(true);
    await live.trackAllSessions(false);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      model: "opus",
      permissions: { allow: ["Bash(ls)"] },
    });
    revert(settings, events);
    await new Promise((r) => setTimeout(r, 400));
    await live.syncUserHooks();
    // off means off: somebody's file, somebody's hooks
    expect(hookEvents(settings)).toHaveLength(STATUS_HOOK_EVENTS.length - 2);

    await live.trackAllSessions(true);
    revert(settings, events);
    await live.syncUserHooks();
    expect(hookEvents(settings)).toEqual([...STATUS_HOOK_EVENTS].sort());
  });
});
