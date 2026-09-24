import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

describe("search reaches what agents said", () => {
  it("finds a session by its agent's words, says which agent, and never by tool output", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-agent-search-")));
    const projectsDir = path.join(dir, "projects");
    const cwd = "/work/queue";
    const project = path.join(projectsDir, claudeProjectSlug(cwd));
    const sub = path.join(project, SID, "subagents");
    mkdirSync(sub, { recursive: true });
    const at = new Date(Date.now() - 3_600_000).toISOString();
    const line = (o: object) => `${JSON.stringify({ cwd, sessionId: SID, timestamp: at, ...o })}\n`;
    writeFileSync(
      path.join(project, `${SID}.jsonl`),
      line({ type: "user", message: { role: "user", content: "why do retries vanish" } }) +
        `${JSON.stringify({ type: "ai-title", aiTitle: "Retries vanish", sessionId: SID })}\n`,
    );
    writeFileSync(
      path.join(sub, "agent-a9.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Trace the lease", spawnDepth: 1 }),
    );
    writeFileSync(
      path.join(sub, "agent-a9.jsonl"),
      line({ type: "user", isSidechain: true, message: { role: "user", content: "Trace it." } }) +
        line({
          type: "assistant",
          isSidechain: true,
          message: {
            id: "m1",
            model: "claude-sonnet-5",
            usage: { output_tokens: 3 },
            content: [{ type: "text", text: "The lease is renewed only on success." }],
          },
        }) +
        line({
          type: "user",
          isSidechain: true,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t", content: "SECRET_TOOL_BODY" }],
          },
        }),
    );
    const service = new SessionService({
      projectsDir,
      cacheDir: path.join(dir, "state"),
      emitPatch: () => {},
      emitStatus: () => {},
    });
    services.push(service);
    await service.loadCached([]);
    await service.refresh();

    const hits = await service.search("renewed success");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ agent: "a9", agents: [{ id: "a9" }] });
    expect(hits[0]?.snippet).toMatch(/^in Explore: .*renewed only on success/);
    expect(await service.search("secret_tool_body")).toEqual([]);
    // what the session itself said is still a plain hit
    expect(await service.search("vanish retries")).toEqual([]);
    expect((await service.search("why vanish"))[0]?.agent).toBeUndefined();
  });
});

describe("an agent still writing after its session went quiet", () => {
  it("is searchable, and counted, as of what it wrote last", async () => {
    const service = machine();
    await service.loadCached([]);
    await service.refresh();
    expect(await service.search("quarantined")).toEqual([]);
    const agent = service.list()[0]?.key.replace(/\.jsonl$/, "/subagents/agent-a2.jsonl") ?? "";
    appendFileSync(
      agent,
      `${JSON.stringify({
        type: "assistant",
        isSidechain: true,
        timestamp: new Date().toISOString(),
        message: {
          id: "m9",
          model: "claude-sonnet-5",
          usage: { output_tokens: 7 },
          content: [{ type: "text", text: "The job was quarantined at 02:00." }],
        },
      })}\n`,
    );
    // the session's own transcript never moved. the agent scan sees the agent did.
    await service.refresh();
    await settle(service, () => false);
    const hits = await service.search("quarantined");
    expect(hits.map((h) => h.agent)).toEqual(["a2"]);
  });
});

describe("a session Claude Code runs in the background", () => {
  it("carries the supervisor's word on its row, without the pid", async () => {
    const service = machine();
    await service.loadCached([]);
    await service.refresh();
    expect(service.list()[0]?.background).toBeUndefined();
    service.setBackground(
      new Map([
        [
          SID,
          {
            sessionId: SID,
            id: "d7b6bcc2",
            pid: 4112,
            state: "blocked",
            waitingFor: "permission prompt",
          },
        ],
      ]),
    );
    expect(service.list()[0]?.background).toEqual({
      id: "d7b6bcc2",
      held: true,
      state: "blocked",
      waitingFor: "permission prompt",
    });
    // stopped: the row stays known to the supervisor, with nothing holding it
    service.setBackground(new Map([[SID, { sessionId: SID, id: "d7b6bcc2", state: "stopped" }]]));
    expect(service.list()[0]?.background).toEqual({
      id: "d7b6bcc2",
      held: false,
      state: "stopped",
    });
    service.setBackground(new Map());
    expect(service.list()[0]?.background).toBeUndefined();
  });
});
