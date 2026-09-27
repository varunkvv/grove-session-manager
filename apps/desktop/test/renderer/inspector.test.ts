import type { SessionAgent } from "@grove/core/pure";
import { describe, expect, it } from "vitest";
import {
  agentLine,
  agentList,
  agentMeta,
  agentStatus,
  agentTitle,
  fanOut,
  LIST_MIN,
  laneGeometry,
  MAIN_ID,
  mainLine,
  mainMeta,
  PANE_MAX,
  PANE_MIN,
  paneLayout,
  sessionAgentSummary,
} from "../../src/renderer/logic/inspector.ts";
import type { AgentStats, SessionInspection } from "../../src/shared/ipc.ts";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const MIN = 60_000;

function agent(id: string, over: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id,
    agentType: "Explore",
    startedAt: NOW - 30 * MIN,
    lastActivityAt: NOW - 20 * MIN,
    state: "done",
    ...over,
  };
}

function inspection(
  agents: Record<string, Partial<AgentStats>>,
  workflows: SessionInspection["workflows"] = {},
): SessionInspection {
  return {
    key: "k",
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, s]) => [id, { id, toolCount: 0, tokens: 0, ...s }]),
    ),
    workflows,
  };
}

describe("where the pane goes", () => {
  it("beside the list while both fit, over it from the right when they do not", () => {
    // the default 1280px window, less the rail: half each
    expect(paneLayout(992)).toEqual({ mode: "side", width: 496 });
    expect(992 - 496).toBeGreaterThanOrEqual(LIST_MIN);
    // never narrower than a conversation can be read at, never wider than a line wants
    expect(paneLayout(900)).toEqual({ mode: "side", width: PANE_MIN });
    expect(paneLayout(2400)).toEqual({ mode: "side", width: PANE_MAX });
    // the old default 1180px window, and a 1000px one: the list would be crushed, so the pane
    // covers part of it instead
    expect(paneLayout(892)).toEqual({ mode: "overlay", width: PANE_MIN });
    expect(paneLayout(712)).toEqual({ mode: "overlay", width: PANE_MIN });
  });

  it("keeps the width it was dragged to, as far as the list lets it", () => {
    expect(paneLayout(1600, 700)).toEqual({ mode: "side", width: 700 });
    // the list keeps its 420px, the pane its 480px, whatever was asked
    expect(paneLayout(1000, 900)).toEqual({ mode: "side", width: 1000 - LIST_MIN });
    expect(paneLayout(1600, 200)).toEqual({ mode: "side", width: PANE_MIN });
    expect(paneLayout(2400, 5000)).toEqual({ mode: "side", width: PANE_MAX });
  });
});

describe("the fan-out", () => {
  it("spans the agents' own window, not the session's life", () => {
    const picture = fanOut(
      [
        agent("a", {
          startedAt: NOW - 2 * 24 * 60 * MIN,
          lastActivityAt: NOW - 2 * 24 * 60 * MIN + MIN,
        }),
        agent("b"),
      ],
      inspection({
        a: { startedAt: NOW - 40 * MIN, lastAt: NOW - 30 * MIN },
        b: { startedAt: NOW - 35 * MIN, lastAt: NOW - 20 * MIN },
      }),
      NOW,
    );
    expect(picture.start).toBe(NOW - 40 * MIN);
    expect(picture.end).toBe(NOW - 20 * MIN);
    expect(picture.bars.map((b) => [b.id, b.lane, b.left, b.width])).toEqual([
      ["a", 0, 0, 0.5],
      ["b", 1, 0.25, 0.75],
    ]);
    expect(picture.ticks).toEqual(["0:00", "10m", "20m"]);
  });

  it("a running agent reaches now, and one that died on an error says so", () => {
    const picture = fanOut(
      [agent("a", { state: "running" }), agent("b")],
      inspection({ b: { error: "API Error: overloaded" } }),
      NOW,
    );
    expect(picture.end).toBe(NOW);
    expect(Object.fromEntries(picture.bars.map((b) => [b.id, b.tone]))).toEqual({
      a: "running",
      b: "error",
    });
  });

  it("past a dozen, agents that never overlap share a lane, and it never grows past ~96px", () => {
    const serial = Array.from({ length: 30 }, (_, i) =>
      agent(`s${String(i).padStart(2, "0")}`, {
        startedAt: NOW - (60 - i * 2) * MIN,
        lastActivityAt: NOW - (59 - i * 2) * MIN,
      }),
    );
    expect(fanOut(serial, null, NOW).lanes).toBe(1);
    const parallel = serial.map((a) => ({ ...a, startedAt: NOW - 60 * MIN, lastActivityAt: NOW }));
    const lanes = fanOut(parallel, null, NOW).lanes;
    expect(lanes).toBe(30);
    const { pitch } = laneGeometry(lanes);
    expect(pitch * lanes).toBeLessThanOrEqual(96);
    expect(laneGeometry(3)).toEqual({ pitch: 12, bar: 4 });
  });
});

/** a tree as text: `@main`, then each row at its depth */
const shape = (items: ReturnType<typeof agentList>) =>
  items.map((i) =>
    i.type === "agent"
      ? `${i.id}:${i.depth}`
      : i.type === "workflow"
        ? `[${i.label}]:${i.depth}`
        : i.id,
  );

describe("the list of agents", () => {
  it("a tree under the session's own conversation, in the order they started", () => {
    const items = agentList(
      [
        agent("late", { startedAt: NOW - 5 * MIN }),
        agent("child", { startedAt: NOW - 20 * MIN, spawnDepth: 2 }),
        agent("parent", { startedAt: NOW - 25 * MIN }),
        agent("first", { startedAt: NOW - 30 * MIN }),
      ],
      inspection({ child: { parentId: "parent" } }),
    );
    // what the session sent out is one step in, an agent's own agents one more
    expect(shape(items)).toEqual([MAIN_ID, "first:1", "parent:1", "child:2", "late:1"]);
  });

  it("the root is there before the numbers are: no row moves when they arrive", () => {
    const agents = [agent("a"), agent("b", { startedAt: NOW - 10 * MIN })];
    expect(shape(agentList(agents, null))).toEqual([MAIN_ID, "a:1", "b:1"]);
    expect(shape(agentList(agents, inspection({})))).toEqual([MAIN_ID, "a:1", "b:1"]);
    // nested, but the parent's transcript never said so: as deep as Claude Code counted
    expect(shape(agentList([agent("n", { spawnDepth: 2 })], null))).toEqual([MAIN_ID, "n:2"]);
    expect(agentList([], null)).toEqual([]);
  });

  it("a workflow's agents stay together under its name, even when another agent ran between", () => {
    const items = agentList(
      [
        agent("w1", { workflow: "wf_1", startedAt: NOW - 30 * MIN }),
        agent("solo", { startedAt: NOW - 25 * MIN }),
        agent("w2", { workflow: "wf_1", startedAt: NOW - 20 * MIN }),
        agent("x1", { workflow: "wf_2", startedAt: NOW - 10 * MIN }),
      ],
      inspection({}, { wf_1: { name: "cdit-1249-derive" } }),
    );
    // the header sits in the tree at the depth of its agents, like a day header in a list
    expect(shape(items)).toEqual([
      MAIN_ID,
      "[cdit-1249-derive]:1",
      "w1:1",
      "w2:1",
      "solo:1",
      "[Workflow]:1",
      "x1:1",
    ]);
  });

  it("each row says what it was for, how big it got, and what came of it", () => {
    const wf = agent("w", { agentType: "workflow-subagent", workflow: "wf_1" });
    expect(agentTitle(wf, { id: "w", toolCount: 3, tokens: 0, asked: "Review the diff." })).toBe(
      "Review the diff.",
    );
    expect(agentMeta(wf, { id: "w", toolCount: 1, tokens: 71_212, model: "claude-sonnet-5" })).toBe(
      "sonnet 5 · 1 tool · 71k tokens",
    );
    expect(agentMeta(agent("e"), undefined)).toBe("Explore");

    const stats = (s: Partial<AgentStats>): AgentStats => ({
      id: "x",
      toolCount: 1,
      tokens: 1,
      ...s,
    });
    const running = agent("r", { state: "running", lastTool: "Grep" });
    // the haiku line first, then the last tool the transcript says, then the scan's
    expect(
      agentLine({ ...running, summary: "reading the queue" }, stats({ lastStep: "Read q.ts" })),
    ).toEqual({ text: "reading the queue", tone: "quiet" });
    expect(agentLine(running, stats({ lastStep: "Read q.ts" }))?.text).toBe("Read q.ts");
    expect(agentLine(running, undefined)?.text).toBe("Grep");
    expect(agentLine(agent("d"), stats({ outcome: "Found it." }))?.text).toBe("Found it.");
    // once someone looked, a model's line on what it found says it better
    expect(
      agentLine(agent("d", { found: "found the lease renewal bug" }), stats({ outcome: "Done." }))
        ?.text,
    ).toBe("found the lease renewal bug");
    expect(agentLine(agent("d"), stats({ error: "API Error: x" }))).toEqual({
      text: "API Error: x",
      tone: "error",
    });
    // interrupted: the first line says so. what it was doing then beats its cut-off last words
    expect(
      agentLine(
        agent("d"),
        stats({ interrupted: true, outcome: "half", lastStep: "Bash pnpm test" }),
      )?.text,
    ).toBe("Bash pnpm test");
    expect(agentLine(agent("d"), stats({ interrupted: true, outcome: "half" }))).toBeNull();
    expect(agentLine(agent("d"), stats({ gone: true }))?.text).toBe(
      "Claude Code deletes transcripts after 30 days",
    );
  });

  it("every row says how it stands in words: running, done, failed or interrupted", () => {
    const stats = (s: Partial<AgentStats>): AgentStats => ({
      id: "x",
      toolCount: 1,
      tokens: 1,
      ...s,
    });
    const running = agent("r", { state: "running", startedAt: NOW - 8 * MIN });
    expect(agentStatus(running, undefined, NOW)).toEqual({
      status: "running",
      word: "Running",
      time: "8m",
    });
    // finished: how long it took, from its own transcript's times once they are known
    expect(agentStatus(agent("d"), undefined, NOW)).toEqual({
      status: "done",
      word: "Done",
      time: "10m",
    });
    expect(
      agentStatus(agent("d"), stats({ startedAt: NOW - 30 * MIN, lastAt: NOW - 25 * MIN }), NOW),
    ).toMatchObject({ word: "Done", time: "5m" });
    expect(agentStatus(agent("d"), stats({ error: "API Error: x" }), NOW)).toMatchObject({
      status: "failed",
      word: "Failed",
    });
    expect(agentStatus(agent("d"), stats({ interrupted: true }), NOW)).toMatchObject({
      status: "interrupted",
      word: "Interrupted",
    });
    // an error wins over the scan's guess, like the bar's tone: it died, it is not running
    expect(agentStatus(running, stats({ error: "API Error: x" }), NOW).status).toBe("failed");
  });

  it("the session's line says how many run and adds up time and tokens across its agents", () => {
    const agents = [agent("a"), agent("b", { state: "running", startedAt: NOW - 4 * MIN })];
    expect(
      sessionAgentSummary(
        agents,
        inspection({ a: { tokens: 800_000 }, b: { tokens: 400_000 } }),
        NOW,
      ),
    ).toBe("1 running · 1 done · 14m of agent time · 1.2M tokens");
    // done is everything that is not running: a failed one counts there, its row says which
    expect(
      sessionAgentSummary([...agents, agent("c")], inspection({ c: { error: "API Error" } }), NOW),
    ).toMatch(/^1 running · 2 done · /);
    expect(sessionAgentSummary([agents[1] as SessionAgent], null, NOW)).toBe(
      "1 running · 4m of agent time",
    );
    // none running: the count, as it always was
    expect(sessionAgentSummary([agent("a")], null, NOW)).toBe("1 agent · 10m of agent time");
  });
});

describe("the session's own conversation, beside its agents", () => {
  const main = {
    model: "claude-opus-5",
    tools: 412,
    turns: 30,
    startedAt: NOW - 60 * MIN,
    lastAt: NOW - 2 * MIN,
    outcome: "Pieces 1-3 are committed.",
    lastStep: "Bash pnpm test",
    spans: [
      [NOW - 60 * MIN, NOW - 50 * MIN],
      [NOW - 40 * MIN, NOW - 25 * MIN],
      [NOW - 10 * MIN, NOW - 2 * MIN],
    ] as Array<[number, number]>,
  };

  it("is the root, and says what it is doing or what it said last", () => {
    const items = agentList([agent("a", {})], { ...inspection({}), main });
    expect(items.map((i) => i.id)).toEqual([MAIN_ID, "a"]);
    expect(mainMeta(main)).toBe("main · opus 5 · 412 tools");
    expect(mainLine(main, true)).toBe("Bash pnpm test");
    expect(mainLine(main, false)).toBe("Pieces 1-3 are committed.");
  });

  it("draws its turns on top of the fan-out, clipped to the agents' own window", () => {
    // one agent from 45 to 20 minutes ago: that is the axis
    const one = agent("a", { startedAt: NOW - 45 * MIN, lastActivityAt: NOW - 20 * MIN });
    const picture = fanOut([one], { ...inspection({}), main }, NOW);
    expect(picture.start).toBe(NOW - 45 * MIN);
    // the first turn ended before the agent started, the third began after it ended: only the
    // second is on the axis
    expect(picture.main?.segments).toEqual([{ left: 5 / 25, width: 15 / 25 }]);
    expect(picture.main?.running).toBe(false);
    // still running: the last turn reaches now, which the axis reaches too while an agent runs
    const running = agent("b", { startedAt: NOW - 45 * MIN, state: "running" });
    const live = fanOut([running], { ...inspection({}), main }, NOW, true);
    expect(live.main?.segments.at(-1)).toEqual({ left: 35 / 45, width: 10 / 45 });
    expect(live.main?.running).toBe(true);
  });
});
