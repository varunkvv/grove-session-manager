import { cpSync, utimesSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_IDLE_DONE_MS,
  agentDigest,
  lastToolFromTail,
  parseAgentMeta,
  scanSessionAgents,
  subagentsDir,
} from "../../src/sessions/agents.ts";
import { makeSandbox } from "../helpers/transcript.ts";

// a real `<sessionId>/subagents/` tree with every string replaced (scratch of redact-fixture.ts):
// two top-level agents, one workflow agent one level deeper, one transcript with no meta file,
// and the workflow's own journal.jsonl.
const SID = "eeeeeeee-0000-4000-8000-000000000005";
const fixtures = path.join(import.meta.dirname, "../fixtures/agents");

const ID = {
  explore: "a1f0e9d8c7b6a5940",
  longTask: "a2e1d0c9b8a7f6350",
  workflow: "a3d2c1b0a9f8e7460",
  noMeta: "a4c3b2a1908f7e650",
};

const NOW = Date.parse("2026-09-22T18:00:00.000Z");

/**
 * the fixture's mtimes are whatever the checkout gave it, and every state rule here is about age.
 * so: a copy with the times set by hand.
 */
function sandbox(ages: Record<string, number> = {}): string {
  const dir = makeSandbox("grove-agents-");
  cpSync(fixtures, dir, { recursive: true });
  const transcript = path.join(dir, `${SID}.jsonl`);
  const subagents = subagentsDir(transcript);
  const files: Array<[string, number]> = [
    [path.join(subagents, `agent-${ID.explore}.jsonl`), ages[ID.explore] ?? 0],
    [path.join(subagents, `agent-${ID.longTask}.jsonl`), ages[ID.longTask] ?? 0],
    [path.join(subagents, `agent-${ID.noMeta}.jsonl`), 0],
    [
      path.join(subagents, "workflows", "wf_ax1b2c3d4-999", `agent-${ID.workflow}.jsonl`),
      ages[ID.workflow] ?? 0,
    ],
  ];
  for (const [file, age] of files) {
    const at = (NOW - age) / 1000;
    utimesSync(file, at, at);
  }
  return transcript;
}

describe("a session's subagents", () => {
  it("the meta file keeps what it understands", () => {
    expect(
      parseAgentMeta({
        agentType: "Explore",
        description: "Survey the queue service",
        toolUseId: "toolu_01",
        spawnDepth: 1,
        requestShape: "foreground",
        requestNonInteractive: true,
      }),
    ).toEqual({
      agentType: "Explore",
      description: "Survey the queue service",
      spawnDepth: 1,
      requestShape: "foreground",
    });
    // a workflow agent's meta has no description at all
    expect(parseAgentMeta({ agentType: "workflow-subagent", spawnDepth: 1 })).toEqual({
      agentType: "workflow-subagent",
      spawnDepth: 1,
    });
    // a shape that moved still counts as an agent: the file existing is the point
    expect(parseAgentMeta({})).toEqual({ agentType: "agent" });
    expect(parseAgentMeta(null)).toBeNull();
    expect(parseAgentMeta("Explore")).toBeNull();
    expect(parseAgentMeta([])).toBeNull();
  });

  it("the last tool comes off the end of the transcript, and a torn line is skipped", () => {
    const tail = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]},"timestamp":"2026-09-22T17:00:00.000Z"}',
      '{"type":"user","message":{"content":[{"type":"tool_result"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"thinking"},{"type":"tool_use","name":"Bash"}]},"timestamp":"2026-09-22T17:01:00.000Z"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_u',
    ].join("\n");
    expect(lastToolFromTail(tail)).toEqual({
      name: "Bash",
      at: Date.parse("2026-09-22T17:01:00.000Z"),
    });
    expect(lastToolFromTail("")).toBeNull();
    expect(lastToolFromTail('{"type":"assistant"}')).toBeNull();
    expect(lastToolFromTail("not json at all")).toBeNull();
  });

  it("every agent with a meta file, workflows included, and nothing without one", async () => {
    const transcript = sandbox();
    const { agents } = await scanSessionAgents(transcript, { now: NOW });
    expect(agents.map((a) => a.id).sort()).toEqual([ID.explore, ID.longTask, ID.workflow].sort());
    expect(agents.find((a) => a.id === ID.explore)).toMatchObject({
      agentType: "Explore",
      description: "Survey the queue service",
      requestShape: "foreground",
      spawnDepth: 1,
      state: "running",
    });
    expect(agents.find((a) => a.id === ID.workflow)).toMatchObject({
      agentType: "workflow-subagent",
      state: "running",
    });
    expect(agents.find((a) => a.id === ID.workflow)?.description).toBeUndefined();
    // journal.jsonl sits beside the workflow agent and is not one
    expect(agents.some((a) => a.id.includes("journal"))).toBe(false);
  });

  it("the last tool, when a single huge tool result has not pushed it out of the window", async () => {
    const transcript = sandbox();
    const { agents } = await scanSessionAgents(transcript, { now: NOW });
    const byId = new Map(agents.map((a) => [a.id, a]));
    expect(byId.get(ID.workflow)).toMatchObject({ lastTool: "Bash" });
    expect(byId.get(ID.workflow)?.lastToolAt).toBe(Date.parse("2026-08-31T19:28:48.825Z"));
    // 41KB of tool result sits between the end of this one and its last tool call
    expect(byId.get(ID.explore)?.lastTool).toBeUndefined();
  });

  it("quiet for two minutes reads as finished, and a stop event says so at once", async () => {
    const transcript = sandbox({ [ID.explore]: AGENT_IDLE_DONE_MS + 1000 });
    const { agents } = await scanSessionAgents(transcript, {
      now: NOW,
      runs: { [ID.longTask]: { startedAt: NOW - 90_000, stoppedAt: NOW - 1000 } },
    });
    const byId = new Map(agents.map((a) => [a.id, a]));
    expect(byId.get(ID.explore)?.state).toBe("done");
    expect(byId.get(ID.longTask)?.state).toBe("done");
    expect(byId.get(ID.longTask)?.startedAt).toBe(NOW - 90_000);
    expect(byId.get(ID.workflow)?.state).toBe("running");
  });

  it("nothing of a session that is not live is still running", async () => {
    const transcript = sandbox();
    const { agents } = await scanSessionAgents(transcript, { now: NOW, sessionLive: false });
    expect(agents.every((a) => a.state === "done")).toBe(true);
    // running first, then newest first - all done here, so it is purely by start time
    expect(agents.map((a) => a.startedAt)).toEqual(
      [...agents.map((a) => a.startedAt)].sort((a, b) => b - a),
    );
  });

  it("an unchanged transcript is not read twice, and a summary survives the rescan", async () => {
    const transcript = sandbox();
    const first = await scanSessionAgents(transcript, { now: NOW });
    const withSummary = {
      ...first,
      agents: first.agents.map((a) =>
        a.id === ID.workflow ? { ...a, summary: "running the test suite", summaryAt: NOW } : a,
      ),
    };
    const second = await scanSessionAgents(transcript, { now: NOW, prev: withSummary });
    const agent = second.agents.find((a) => a.id === ID.workflow);
    expect(agent).toMatchObject({ summary: "running the test suite", summaryAt: NOW });
    expect(agent?.lastTool).toBe("Bash");
    expect(second.reads[ID.workflow]).toEqual(first.reads[ID.workflow]);
    // the file is where the summariser reads from, and a workflow agent's is not next to the rest
    expect(second.reads[ID.workflow]?.file).toContain(`workflows${path.sep}wf_`);
  });

  it("the digest is what it called and what it last said, and nothing else", () => {
    const tail = [
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"long ramble"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/queue/retry.ts","limit":80}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"400 lines of file"}]}}',
      '{"type":"attachment","attachment":{"type":"pad","text":"noise"}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"pnpm  test\\n  retry"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"the backoff never resets"}]}}',
    ].join("\n");
    expect(agentDigest(tail)).toBe(
      ["Read: src/queue/retry.ts", "Bash: pnpm test retry", "said: the backoff never resets"].join(
        "\n",
      ),
    );
    // the end is what matters: an over-long digest loses its oldest lines
    expect(agentDigest(tail, 40)).toBe("said: the backoff never resets");
    expect(agentDigest("")).toBe("");
    expect(agentDigest('{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}')).toBe(
      "",
    );
  });

  it("a session with no subagents directory is not an error", async () => {
    const dir = makeSandbox("grove-agents-");
    expect(await scanSessionAgents(path.join(dir, "nope.jsonl"))).toEqual({
      agents: [],
      reads: {},
    });
  });
});
