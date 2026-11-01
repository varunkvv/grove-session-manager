import type { SessionAgent } from "@grove/core";
import { describe, expect, it } from "vitest";
import { agentsView } from "../../src/main/services/projects.ts";

const agent = (over: Partial<SessionAgent> & { id: string }): SessionAgent => ({
  agentType: "Explore",
  startedAt: 1000,
  lastActivityAt: 2000,
  state: "running",
  ...over,
});

describe("agentsView", () => {
  it("has nothing for a session without agents", () => {
    expect(agentsView(undefined)).toBeUndefined();
    expect(agentsView([])).toBeUndefined();
  });

  it("counts running and done, and lists only the running ones", () => {
    const view = agentsView([
      agent({ id: "a", description: "map the router", requestShape: "background" }),
      agent({ id: "b", asked: "read the config" }),
      agent({ id: "c", state: "done" }),
    ]);
    expect(view).toEqual({
      running: 2,
      done: 1,
      lines: [
        { id: "a", kind: "Explore", text: "map the router", background: true, startedAt: 1000 },
        { id: "b", kind: "Explore", text: "read the config", startedAt: 1000 },
      ],
    });
  });

  it("leaves a workflow's own agents out of the count", () => {
    const view = agentsView([agent({ id: "a" }), agent({ id: "w", workflow: "run1" })]);
    expect(view?.running).toBe(1);
  });

  it("does not change while an agent writes: no activity time, no summary", () => {
    const at = (lastActivityAt: number) =>
      JSON.stringify(
        agentsView([
          agent({ id: "a", lastActivityAt, summary: `s${lastActivityAt}`, lastTool: "Read" }),
        ]),
      );
    expect(at(2000)).toBe(at(9000));
  });

  it("caps the lines but keeps the count", () => {
    const many = Array.from({ length: 11 }, (_, i) => agent({ id: `a${i}` }));
    const view = agentsView(many);
    expect(view?.running).toBe(11);
    expect(view?.lines).toHaveLength(3);
  });
});
