import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LiveStatus, needing, needsYou } from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import { answeredAll, entered, LiveService } from "../../src/main/services/live.ts";

const S = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";

const services: LiveService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

const BG_DONE =
  "<task-notification>\n<task-id>bpkrrp69r</task-id>\n<status>completed</status>\n<summary>Background command done</summary>\n</task-notification>";

/** a live service over a fresh state dir, or `from`'s, as a restart has it */
async function machine(from?: { dir: string }) {
  const dir = from?.dir ?? realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-reply-only-")));
  const stateDir = path.join(dir, "state");
  const eventsDir = path.join(stateDir, "events");
  const registryDir = path.join(dir, "claude", "sessions");
  mkdirSync(eventsDir, { recursive: true });
  mkdirSync(registryDir, { recursive: true });
  const needs: LiveStatus[] = [];
  const live = new LiveService({
    stateDir,
    claudeSettingsFile: path.join(dir, "claude", "settings.json"),
    registryDir,
    onChange: () => {},
    onNeedsYou: (_id, status) => needs.push(status),
  });
  services.push(live);
  await live.start();
  let n = 0;
  /** one hook event, drained before the next */
  const hook = async (name: string, e: Record<string, unknown> = {}) => {
    writeFileSync(
      path.join(eventsDir, `${process.pid}-${String(++n).padStart(4, "0")}.json`),
      JSON.stringify({ session_id: S, hook_event_name: name, ...e }),
    );
    for (let i = 0; i < 100 && readdirSync(eventsDir).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 30));
  };
  const now = () => live.list().get(S);
  return { dir, live, needs, hook, now, registryDir };
}

describe("a needs-you leaves only on his reply or a dismiss", () => {
  it("claude's own turns keep it and never tell it again. his prompt answers it", async () => {
    const m = await machine();
    await m.hook("UserPromptSubmit", { prompt: "open the PRs" });
    await m.hook("Stop", { last_assistant_message: "Should I keep going?" });
    expect(m.needs).toHaveLength(1);
    const asked = m.now();

    // a background command's end wakes it: working, and still his
    await m.hook("UserPromptSubmit", { prompt: BG_DONE });
    expect(m.now()).toMatchObject({ state: "running", kept: asked });
    expect(needsYou(m.now())).toBe(true);
    await m.hook("PostToolUse", { tool_name: "Read" });
    expect(needing(m.now())).toEqual(asked);
    // the wake-up's end is a new one, told
    await m.hook("Stop", {
      last_assistant_message: "Done. Merge it?",
      session_crons: [
        { id: "c1", schedule: "5 15 * * *", recurring: false, prompt: "say: cron fired" },
      ],
    });
    expect(m.needs).toHaveLength(2);
    const merge = m.now();
    expect(merge).toMatchObject({ state: "waiting", woke: true });

    // the cron that Stop left fires its prompt: claude's, not his
    await m.hook("UserPromptSubmit", { prompt: "say: cron fired" });
    expect(m.now()).toMatchObject({ state: "running", kept: merge });
    await m.hook("Stop", { last_assistant_message: "cron fired", session_crons: [] });
    expect(m.needs).toHaveLength(3);

    // his own prompt
    await m.hook("UserPromptSubmit", { prompt: "yes, merge it" });
    expect(m.now()?.state).toBe("running");
    expect(needsYou(m.now())).toBe(false);
  });

  it("his reply in grove chat or a dismiss (markSeen) ends what claude's own turn kept, and the turn runs on", async () => {
    const m = await machine();
    await m.hook("UserPromptSubmit", { prompt: "open the PRs" });
    await m.hook("Stop", { last_assistant_message: "Should I keep going?" });
    await m.hook("UserPromptSubmit", { prompt: BG_DONE });
    m.live.markSeen([S]);
    expect(m.now()?.state).toBe("running");
    expect(m.now()?.kept).toBeUndefined();
    expect(needsYou(m.now())).toBe(false);
  });

  it("dismissing an agent's ask clears what it interrupted too: that does not come back when the ask ends", async () => {
    const m = await machine();
    await m.hook("UserPromptSubmit", { prompt: "go" });
    await m.hook("Stop", { last_assistant_message: "Should I keep going?" });
    await m.hook("PermissionRequest", { tool_name: "Bash", agent_id: "a1" });
    expect(m.now()?.state).toBe("permission");
    m.live.markSeen([S]);
    await m.hook("PostToolUse", { tool_name: "Bash", agent_id: "a1" });
    expect(m.now()?.state).toBe("waiting");
    expect(needsYou(m.now())).toBe(false);
  });

  it("the end of its session and a restart keep it. a process gone under claude's own turn gives it back", async () => {
    const m = await machine();
    await m.hook("UserPromptSubmit", { prompt: "go" });
    await m.hook("Stop", { last_assistant_message: "Should I keep going?" });
    const asked = m.now();
    // the editor tab closed on it
    await m.hook("SessionEnd");
    expect(m.now()).toEqual(asked);
    // a wake-up, then grove quits and its process is gone by the time grove is back
    await m.hook("UserPromptSubmit", { prompt: BG_DONE });
    expect(m.now()?.kept).toEqual(asked);
    m.live.dispose();
    // another session's process is up, so the registry is there and says this one is not
    writeFileSync(
      path.join(m.registryDir, "1.json"),
      JSON.stringify({ pid: process.pid, sessionId: OTHER, status: "idle" }),
    );
    const back = await machine({ dir: m.dir });
    expect(back.now()).toEqual(asked);
    expect(back.needs).toHaveLength(0);
  });
});

describe("what is new in needs-you", () => {
  const ended: LiveStatus = { state: "waiting", at: 10, lastEventAt: 10, question: "Go on?" };
  const woke: LiveStatus = { state: "running", at: 20, lastEventAt: 20, kept: ended };

  it("one claude's own turn keeps is not new, its turn's end is, and an agent's ask ending over it is not", () => {
    expect(entered(ended, woke)).toBe(false);
    expect(entered(woke, { ...woke, lastEventAt: 30 })).toBe(false);
    expect(entered(woke, { state: "waiting", at: 40, lastEventAt: 40 })).toBe(true);
    const ask: LiveStatus = { state: "permission", at: 25, lastEventAt: 25, resume: woke };
    expect(entered(woke, ask)).toBe(true);
    expect(entered(ask, { ...woke, lastEventAt: 26 })).toBe(false);
    // and it falling back to what it kept, at the end of its session
    expect(entered(woke, ended)).toBe(false);
  });

  it("answered or dismissed: nothing in the row needs him", () => {
    expect(answeredAll(woke)).toEqual({ state: "running", at: 20, lastEventAt: 20 });
    const ask: LiveStatus = { state: "permission", at: 25, lastEventAt: 25, resume: ended };
    expect(answeredAll(ask)).toEqual({ ...ask, seen: true, resume: { ...ended, seen: true } });
    expect(needsYou(answeredAll({ ...ask, resume: woke }).resume)).toBe(false);
  });
});
