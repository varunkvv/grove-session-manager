import { describe, expect, it } from "vitest";
import { agentsChip, agentsTooltip } from "../../src/renderer/logic/agents.ts";
import type { SessionAgent } from "../../src/shared/ipc.ts";

const NOW = Date.parse("2026-09-22T18:00:00.000Z");

function agent(partial: Partial<SessionAgent> & { id: string }): SessionAgent {
  return {
    agentType: "Explore",
    startedAt: NOW - 40_000,
    lastActivityAt: NOW - 1000,
    state: "running",
    ...partial,
  };
}

describe("the agents on a row", () => {
  it("a count, then the running ones and how long they have been at it", () => {
    const agents = [
      agent({ id: "a1" }),
      agent({ id: "a2", agentType: "claude-code-guide", startedAt: NOW - 120_000 }),
      agent({ id: "a3", agentType: "long-task", state: "done" }),
    ];
    expect(agentsChip(agents, NOW)).toBe("3 agents · Explore 40s · claude-code-guide 2m");
    // past two, the rest are a number: the row has one line
    expect(agentsChip([...agents, agent({ id: "a4" }), agent({ id: "a5" })], NOW)).toBe(
      "5 agents · Explore 40s · claude-code-guide 2m · +2",
    );
  });

  it("all done, or only one, or none", () => {
    expect(agentsChip([agent({ id: "a1", state: "done" })], NOW)).toBe("1 agent");
    expect(agentsChip([agent({ id: "a1" })], NOW)).toBe("1 agent · Explore 40s");
    expect(agentsChip([], NOW)).toBe("");
  });

  it("the tooltip carries what the row had no room for", () => {
    const agents = [
      agent({ id: "a1", description: "Survey the queue service", lastTool: "Grep" }),
      agent({
        id: "a2",
        agentType: "long-task",
        state: "done",
        description: "Rewrite the retry policy",
        summary: "writing the backoff tests",
      }),
    ];
    expect(agentsTooltip(agents)).toBe(
      [
        "Explore: Survey the queue service",
        "  last tool: Grep",
        "long-task (done): Rewrite the retry policy",
        "  writing the backoff tests",
      ].join("\n"),
    );
    // a workflow agent's meta has no description at all
    expect(agentsTooltip([agent({ id: "a3", agentType: "workflow-subagent" })])).toBe(
      "workflow-subagent",
    );
  });
});
