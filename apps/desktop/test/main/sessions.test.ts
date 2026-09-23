import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProjectSlug, type LiveStatus } from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import { SessionService } from "../../src/main/services/sessions.ts";

const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const services: SessionService[] = [];

afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
});

/** a session with two subagents: one that went quiet an hour ago, one that wrote just now */
function machine() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-sessions-")));
  const projectsDir = path.join(dir, "projects");
  const cwd = "/work/queue";
  const project = path.join(projectsDir, claudeProjectSlug(cwd));
  const subagents = path.join(project, SID, "subagents");
  mkdirSync(subagents, { recursive: true });
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  writeFileSync(
    path.join(project, `${SID}.jsonl`),
    `${[
      {
        type: "user",
        cwd,
        sessionId: SID,
        timestamp: at,
        message: { role: "user", content: "fan out" },
      },
      { type: "ai-title", aiTitle: "Fanning out", sessionId: SID },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")}\n`,
  );
  for (const [id, ageMs] of [
    ["a1", 3_600_000],
    ["a2", 0],
  ] as const) {
    writeFileSync(
      path.join(subagents, `agent-${id}.meta.json`),
      JSON.stringify({ agentType: "Explore", description: `agent ${id}`, spawnDepth: 1 }),
    );
    const file = path.join(subagents, `agent-${id}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: "user", message: { content: "go" } })}\n`);
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(file, when, when);
  }
  const service = new SessionService({
    projectsDir,
    cacheDir: path.join(dir, "state"),
    emitPatch: () => {},
    emitStatus: () => {},
  });
  services.push(service);
  return service;
}

const states = (service: SessionService) =>
  Object.fromEntries((service.list()[0]?.agents ?? []).map((a) => [a.id, a.state]));

const running: LiveStatus = { state: "waiting", at: Date.now(), lastEventAt: Date.now() };

async function settle(service: SessionService, check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  await service.refresh();
}

describe("agents on every session", () => {
  it("a session nobody is running still lists what its agents were, all finished", async () => {
    const service = machine();
    await service.loadCached([]);
    await service.refresh();
    expect(states(service)).toEqual({ a1: "done", a2: "done" });
  });

  it("while the session is live, an agent that wrote just now is running", async () => {
    const service = machine();
    await service.loadCached([]);
    await service.refresh();
    service.setLive(new Map([[SID, running]]));
    await settle(service, () => states(service).a2 === "running");
    expect(states(service)).toEqual({ a1: "done", a2: "running" });

    // the session stopped: its agents stay listed, and none of them is running any more
    service.setLive(new Map());
    await settle(service, () => states(service).a2 === "done");
    expect(states(service)).toEqual({ a1: "done", a2: "done" });
  });

  it("a process that is up but idle still counts: a background agent outlives the turn", async () => {
    const service = machine();
    await service.loadCached([]);
    await service.refresh();
    // no hook covers this session, only the registry knows the process is there
    service.setLive(new Map(), new Map(), new Set([SID]));
    await settle(service, () => states(service).a2 === "running");
    expect(states(service).a2).toBe("running");
  });
});
