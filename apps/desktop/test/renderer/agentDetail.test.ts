import { describe, expect, it } from "vitest";
import {
  type DetailItem,
  detailItems,
  detailMeta,
  exactDuration,
  hasThinking,
  itemOfStep,
  offsetLabel,
  runOfStep,
  runTargets,
  type ToolLine,
  webLink,
} from "../../src/renderer/logic/agentDetail.ts";
import type { AgentDetail, DetailStep } from "../../src/shared/ipc.ts";

const T0 = Date.parse("2026-09-23T12:00:00.000Z");

let n = 0;
const tool = (name: string, target: string, extra: Partial<ToolLine> = {}): DetailStep => {
  const i = n++;
  return {
    kind: "tool",
    n: i,
    id: `t${i}`,
    name,
    target,
    at: T0 + i * 1000,
    durationMs: 500,
    ...extra,
  };
};
const say = (text: string): DetailStep => ({ kind: "text", n: n++, text, at: T0 });
const think = (text: string): DetailStep => ({ kind: "thinking", n: n++, text, at: T0 });

function detail(steps: DetailStep[], over: Partial<AgentDetail> = {}): AgentDetail {
  return { key: "k", id: "a", tokens: 0, toolCount: steps.length, startedAt: T0, steps, ...over };
}

const shape = (items: DetailItem[]) =>
  items.map((i) =>
    i.type === "run"
      ? `run:${i.name}×${i.steps.length}${i.open ? ":open" : ""}`
      : i.type === "tool"
        ? `${i.nested ? "  " : ""}${i.step.name}`
        : i.type === "label"
          ? `[${i.label}]`
          : i.type,
  );

const closed = { thinking: false, openRuns: new Set<string>(), running: false };

describe("an agent's detail", () => {
  it("puts the result first, then what it was asked, then the steps", () => {
    n = 0;
    const items = detailItems(
      detail([tool("Read", "a.ts")], { result: "Found it.", prompt: "Look." }),
      closed,
    );
    expect(shape(items)).toEqual([
      "head",
      "[Result]",
      "result",
      "[Asked]",
      "asked",
      "[Steps]",
      "Read",
    ]);
  });

  it("folds a run of one tool into a line, and never folds what deserves its own", () => {
    n = 0;
    const steps = [
      tool("Read", "src/a.ts"),
      tool("Read", "src/b.ts"),
      tool("Read", "src/c.ts"),
      tool("Read", "src/d.ts", { failure: "error" }),
      tool("Read", "src/e.ts"),
      tool("Read", "src/f.ts"),
      tool("Agent", "Find the writers", { agentId: "child" }),
      tool("Grep", "x"),
      tool("Grep", "y"),
    ];
    const items = detailItems(detail(steps), closed);
    // a failure breaks the run so it keeps its colour, an Agent call keeps its link, two is no run
    expect(shape(items).slice(2)).toEqual([
      "run:Read×3",
      "Read",
      "Read",
      "Read",
      "Agent",
      "Grep",
      "Grep",
    ]);
    const run = items.find((i) => i.type === "run");
    expect(run?.type === "run" && runTargets(run.steps)).toBe("a.ts, b.ts, c.ts");

    const open = detailItems(detail(steps), { ...closed, openRuns: new Set([run?.id ?? ""]) });
    expect(shape(open).slice(2, 6)).toEqual(["run:Read×3:open", "  Read", "  Read", "  Read"]);
  });

  it("while it runs, the newest step keeps its own line: it is what the agent is doing now", () => {
    n = 0;
    const steps = [tool("Read", "a"), tool("Read", "b"), tool("Read", "c"), tool("Read", "d")];
    expect(shape(detailItems(detail(steps), closed)).slice(2)).toEqual(["run:Read×4"]);
    expect(shape(detailItems(detail(steps), { ...closed, running: true })).slice(2)).toEqual([
      "run:Read×3",
      "Read",
    ]);
  });

  it("thinking shows only when asked for, and a search hit finds its step inside a folded run", () => {
    n = 0;
    const steps = [
      say("Starting."),
      think("the queue first"),
      tool("Bash", "ls"),
      tool("Bash", "ls"),
      tool("Bash", "pwd"),
    ];
    const d = detail(steps);
    expect(hasThinking(d)).toBe(true);
    expect(hasThinking(detail([say("x")]))).toBe(false);
    expect(shape(detailItems(d, closed)).slice(2)).toEqual(["prose", "run:Bash×3"]);
    expect(shape(detailItems(d, { ...closed, thinking: true })).slice(2)).toEqual([
      "prose",
      "prose",
      "run:Bash×3",
    ]);
    const items = detailItems(d, closed);
    expect(runOfStep(items, 3)).toBe("run:2");
    expect(items[itemOfStep(items, 3)]?.type).toBe("run");
    expect(runTargets((items[itemOfStep(items, 3)] as { steps: ToolLine[] }).steps)).toBe(
      "ls, pwd",
    );
  });

  it("an agent with no steps says so, differently while it is still starting", () => {
    expect(detailItems(detail([]), closed).at(-1)).toMatchObject({ type: "quiet" });
    expect(detailItems(detail([]), { ...closed, running: true }).at(-1)).toMatchObject({
      text: "Nothing yet.",
    });
  });

  it("says when each step came, how long it ran and what it was", () => {
    expect(offsetLabel(T0 + 4_000, T0)).toBe("+0:04");
    expect(offsetLabel(T0 + 72_000, T0)).toBe("+1:12");
    expect(offsetLabel(T0 + 3_730_000, T0)).toBe("+1:02:10");
    expect(offsetLabel(T0, undefined)).toBe("");
    expect(exactDuration(148_653)).toBe("2m 29s");
    expect(exactDuration(45_000)).toBe("45s");
    expect(exactDuration(42 * 60_000)).toBe("42m");
    expect(exactDuration(72 * 60_000)).toBe("1h 12m");
    expect(
      detailMeta(
        { agentType: "Explore", state: "done" },
        detail([], {
          model: "claude-sonnet-5",
          lastAt: T0 + 148_653,
          toolCount: 26,
          tokens: 41_020,
        }),
        T0,
      ),
    ).toBe("Explore · sonnet 5 · 2m 29s · 26 tools · 41k tokens");
    // a workflow's agents all share one type, so the model is what tells them apart
    expect(
      detailMeta(
        { agentType: "workflow-subagent", state: "running" },
        detail([], { toolCount: 1 }),
        T0 + 5_000,
      ),
    ).toBe("5s · 1 tool");
  });

  it("only a web link is a link", () => {
    expect(webLink("https://example.com/x")).toBe("https://example.com/x");
    expect(webLink("javascript:alert(1)")).toBeNull();
    expect(webLink("file:///etc/passwd")).toBeNull();
    expect(webLink("/relative")).toBeNull();
    expect(webLink(undefined)).toBeNull();
  });
});
