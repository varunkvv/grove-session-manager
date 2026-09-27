import { describe, expect, it } from "vitest";
import { agentsChip, agentsCount, agentsTooltip } from "../../src/renderer/logic/agents.ts";
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
  it("says which are still at it and which are done", () => {
    const agents = [
      agent({ id: "a1" }),
      agent({ id: "a2", agentType: "claude-code-guide", startedAt: NOW - 120_000 }),
      agent({ id: "a3", agentType: "long-task", state: "done" }),
    ];
    expect(agentsChip(agents)).toBe("2 running · 1 done");
    expect(agentsChip([...agents, agent({ id: "a4", state: "done" })])).toBe("2 running · 2 done");
    // all still at it: nothing is done yet
    expect(agentsChip([agent({ id: "a1" })])).toBe("1 running");
    // a narrow row keeps the part that changes: how many run
    expect(agentsCount(agents)).toBe("2 running");
  });

  it("all done: how many there were, as it always said. none: nothing", () => {
    const done = [agent({ id: "a1", state: "done" }), agent({ id: "a2", state: "done" })];
    expect(agentsChip(done)).toBe("2 agents");
    expect(agentsChip([agent({ id: "a1", state: "done" })])).toBe("1 agent");
    expect(agentsCount(done)).toBe("2 agents");
    expect(agentsChip([])).toBe("");
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
