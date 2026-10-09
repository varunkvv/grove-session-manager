import type { Combo, DayTally, ModelCounts, UsageSource } from "@grove/core";
import { describe, expect, it } from "vitest";
import { buildUsageView } from "../../src/main/services/usage.ts";

const OPUS = "claude-opus-5-5";
const NOW = new Date(2026, 9, 9, 12).getTime();
const M = 1_000_000;

const counts = (c: Partial<ModelCounts>): ModelCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  messages: 1,
  ms: 0,
  ...c,
});
/** the slots as the scan keeps them: 288 bits in 9 words */
const slots = (...at: number[]) => {
  const words = new Array<number>(9).fill(0);
  for (const i of at) words[i >> 5] = ((words[i >> 5] ?? 0) | (1 << (i & 31))) >>> 0;
  return words;
};
const day = (models: Record<string, Partial<ModelCounts>>, rest: Partial<DayTally> = {}) => ({
  models: Object.fromEntries(Object.entries(models).map(([m, c]) => [m, counts(c)])),
  ...rest,
});
const source = (cwd: string, files: UsageSource["files"], n = 1): UsageSource => ({
  path: `/claude/projects/x/${n}.jsonl`,
  sessionId: `session-${n}`,
  cwd,
  projectDirName: "x",
  files,
});
const combos = [
  { name: "Auth SSO", root: "/ws/auth-sso", folders: [] },
  { name: "Billing", root: "/ws/billing", folders: [] },
] as unknown as Combo[];
const projectOf = new Map([
  ["Auth SSO", "auth-sso"],
  ["Billing", "billing"],
]);
const view = (
  sources: UsageSource[],
  progress = { counted: sources.length, total: sources.length },
) => buildUsageView({ sources, combos, projectOf, progress, now: NOW });

describe("the usage view", () => {
  it("a day is split by project and by model, priced, with the sessions in no project as one", () => {
    const v = view([
      source(
        "/ws/auth-sso",
        { "": { "2026-10-08": day({ [OPUS]: { output: M, ms: 60_000 } }) } },
        1,
      ),
      // a working copy inside the project is the project's
      source(
        "/ws/auth-sso/api",
        { "": { "2026-10-08": day({ [OPUS]: { input: M, cacheWrite: M, cacheWrite1h: M / 2 } }) } },
        2,
      ),
      source(
        "/ws/billing",
        { "": { "2026-10-08": day({ "claude-haiku-4-5": { cacheRead: M } }) } },
        3,
      ),
      source("/somewhere/else", { "": { "2026-10-08": day({ [OPUS]: { output: M / 2 } }) } }, 4),
    ]);
    expect(v.days).toHaveLength(1);
    const d = v.days[0]!;
    expect(d.day).toBe("2026-10-08");
    const by = new Map(d.projects.map((p) => [p.project, p]));
    // output $20, then input $4 + half a 5m write $2.50 + half a 1h write $4
    expect(by.get("auth-sso")).toMatchObject({ tokens: [M, M, 0, M / 2, M / 2], ms: 60_000 });
    expect(by.get("auth-sso")?.cost).toBeCloseTo(30.5);
    expect(by.get("billing")?.cost).toBeCloseTo(0.1);
    expect(by.get(null)?.cost).toBeCloseTo(10);
    expect(d.models.map((m) => [m.model, Math.round(m.cost * 100) / 100])).toEqual([
      [OPUS, 40.5],
      ["claude-haiku-4-5", 0.1],
    ]);
    expect(d.sessions).toHaveLength(4);
  });

  it("a session is one number across its days, and a subagent counts on the day it started", () => {
    const agent = "session-1/subagents/agent-a.jsonl";
    const v = view([
      source("/ws/auth-sso", {
        "": {
          "2026-10-07": day({ [OPUS]: { output: 10 } }),
          "2026-10-08": day({ [OPUS]: { output: 10 } }),
        },
        [agent]: {
          "2026-10-07": day({ [OPUS]: { output: 5 } }),
          "2026-10-08": day({ [OPUS]: { output: 5 } }),
        },
        // a workflow's journal is not an agent
        "session-1/subagents/workflows/wf/journal.jsonl": {
          "2026-10-08": day({ [OPUS]: { output: 1 } }),
        },
      }),
    ]);
    expect(v.days.map((d) => [d.day, d.sessions, d.subagents])).toEqual([
      ["2026-10-07", [0], 1],
      ["2026-10-08", [0], 0],
    ]);
  });

  it("the peak is the most files working in the same five minutes, and the longest turn is the day's largest", () => {
    const work = (at: number[], turn?: number) =>
      day({ [OPUS]: { output: 1, ms: 1 } }, { slots: slots(...at), ...(turn ? { turn } : {}) });
    const v = view([
      source(
        "/ws/auth-sso",
        {
          "": { "2026-10-08": work([120, 121, 287], 9_000) },
          "s/subagents/agent-a.jsonl": { "2026-10-08": work([121, 122]) },
          "s/subagents/agent-b.jsonl": { "2026-10-08": work([0, 121]) },
        },
        1,
      ),
      source("/ws/billing", { "": { "2026-10-08": work([122, 200], 12_000) } }, 2),
      // another day is another count
      source("/ws/billing", { "": { "2026-10-07": work([121], 1_000) } }, 3),
    ]);
    expect(v.days.map((d) => [d.day, d.peak, d.longest])).toEqual([
      ["2026-10-07", 1, 1_000],
      ["2026-10-08", 3, 12_000],
    ]);
  });

  it("a model with no price keeps its tokens and adds nothing to the cost", () => {
    const v = view([
      source("/ws/auth-sso", {
        "": { "2026-10-08": day({ "some-other-model": { input: 700, output: 300 } }) },
      }),
    ]);
    expect(v.days[0]).toMatchObject({ unpriced: 1000 });
    expect(v.days[0]?.projects[0]).toMatchObject({ tokens: [700, 300, 0, 0, 0], cost: 0 });
  });

  it("goes back 730 days, leaves out a day with nothing, and says how far the count has got", () => {
    const v = view(
      [
        source("/ws/auth-sso", {
          "": {
            "2024-10-08": day({ [OPUS]: { output: 10 } }),
            "2024-10-11": day({ [OPUS]: { output: 10 } }),
            // a response that was taken back out of its day leaves zeros
            "2026-10-01": day({ [OPUS]: { messages: 0 } }),
            "2026-10-09": day({ [OPUS]: { output: 10 } }),
          },
        }),
      ],
      { counted: 3, total: 10 },
    );
    expect(v.days.map((d) => d.day)).toEqual(["2024-10-11", "2026-10-09"]);
    expect(v).toMatchObject({ counted: 3, total: 10 });
  });
});
