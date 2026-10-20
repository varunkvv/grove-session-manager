import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
}

/** a live service whose events dir already holds `events`, read at start without notifying */
async function machine(events: Array<Record<string, unknown>> = []) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-live-cards-")));
  const stateDir = path.join(dir, "state");
  const eventsDir = path.join(stateDir, "events");
  mkdirSync(eventsDir, { recursive: true });
  let n = 0;
  const hook = (e: Record<string, unknown>) =>
    writeFileSync(path.join(eventsDir, `${process.pid}-${++n}.json`), JSON.stringify(e));
  for (const e of events) hook(e);
  const needs: LiveStatus[] = [];
  const live = new LiveService({
    stateDir,
    claudeSettingsFile: path.join(dir, "claude", "settings.json"),
    registryDir: path.join(dir, "claude", "sessions"),
    onChange: () => {},
    onNeedsYou: (_id, status) => needs.push(status),
  });
  services.push(live);
  await live.start();
  return { live, needs, hook, eventsDir, stateFile: path.join(stateDir, "live-status.json") };
}

describe("a card grove chat draws that no hook announces", () => {
  it("asks over what the hooks say, is told once, and when it goes the hooks' status is back", async () => {
    const m = await machine([{ session_id: S, hook_event_name: "UserPromptSubmit" }]);
    const turn = m.live.list().get(S);
    expect(turn?.state).toBe("running");
    m.live.card(S, "linear asks");
    expect(m.live.list().get(S)).toMatchObject({ state: "permission", detail: "linear asks" });
    expect(m.needs).toMatchObject([{ state: "permission", detail: "linear asks" }]);
    // a second card while the first is up says what it asks, and is not a second notification
    const at = m.live.list().get(S)?.at;
    m.live.card(S, "Session paused");
    expect(m.live.list().get(S)).toMatchObject({ detail: "Session paused", at });
    expect(m.needs).toHaveLength(1);
    // looked at in its window
    m.live.markSeen([S]);
    expect(m.live.list().get(S)?.seen).toBe(true);
    m.live.card(S, null);
    expect(m.live.list().get(S)).toEqual(turn);
    expect(m.needs).toHaveLength(1);
    // never stored: it dies with the claude that holds it
    m.live.card(S, "linear asks");
    m.live.dispose();
    const stored = JSON.parse(readFileSync(m.stateFile, "utf8"))[S];
    expect(stored).toEqual(turn);
  });

  it("a hook ask that comes while a card is up waits under it, and is told when the card goes", async () => {
    const m = await machine([{ session_id: S, hook_event_name: "UserPromptSubmit" }]);
    m.live.card(S, "linear asks");
    m.hook({ session_id: S, hook_event_name: "PermissionRequest", tool_name: "Bash" });
    await until(() => readdirSync(m.eventsDir).length === 0);
    await new Promise((r) => setTimeout(r, 50));
    // the card is what shows, and it was told already
    expect(m.live.list().get(S)).toMatchObject({ state: "permission", detail: "linear asks" });
    expect(m.needs).toHaveLength(1);
    m.live.card(S, null);
    expect(m.live.list().get(S)).toMatchObject({ state: "permission", detail: "Bash" });
    expect(m.needs.map((s) => s.detail)).toEqual(["linear asks", "Bash"]);
  });

  it("a turn's end it covered comes back without a second notification", async () => {
    const m = await machine([
      { session_id: S, hook_event_name: "UserPromptSubmit" },
      { session_id: S, hook_event_name: "Stop", last_assistant_message: "Ship it?" },
    ]);
    const ended = m.live.list().get(S);
    m.live.card(S, "Auto mode");
    m.live.card(S, null);
    expect(m.live.list().get(S)).toEqual(ended);
    expect(m.needs.map((s) => s.detail)).toEqual(["Auto mode"]);
  });

  it("a card on a session no hook reports goes with the card", async () => {
    const m = await machine();
    m.live.card(S, "Session paused");
    expect(m.live.list().get(S)?.state).toBe("permission");
    m.live.card(S, null);
    expect(m.live.list().has(S)).toBe(false);
    m.live.card(S, null);
    expect(m.needs).toHaveLength(1);
  });
});
