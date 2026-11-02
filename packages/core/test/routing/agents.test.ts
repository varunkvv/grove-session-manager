import { describe, expect, it } from "vitest";
import {
  applyEdit,
  cleanEdits,
  listAgents,
  modelFamily,
  PROMPT_MAX,
  resetAgent,
  resolveAgents,
  validateAgent,
} from "../../src/routing/agents.ts";
import { DEFAULT_AGENTS } from "../../src/routing/defaults.ts";
import { AGENT_EFFORTS, AGENT_MODELS } from "../../src/routing/types.ts";

describe("the shipped agents", () => {
  const all = Object.entries(DEFAULT_AGENTS);

  it("are 21, each with a good name, model, effort and a short prompt", () => {
    expect(all).toHaveLength(21);
    for (const [name, a] of all) {
      expect(name, name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(AGENT_MODELS, name).toContain(a.model);
      expect(AGENT_EFFORTS, name).toContain(a.effort);
      expect(a.description.length, name).toBeGreaterThan(10);
      expect(a.description.length, name).toBeLessThanOrEqual(300);
      expect(a.prompt.length, name).toBeGreaterThan(200);
      expect(a.prompt.length, name).toBeLessThan(1500);
    }
  });

  it("never use low effort", () => {
    expect(AGENT_EFFORTS as readonly string[]).not.toContain("low");
    for (const [, a] of all) expect(a.effort).not.toBe("low");
  });

  it("route the way they were chosen", () => {
    const by = (m: string) =>
      all
        .filter(([, a]) => a.model === m)
        .map(([n]) => n)
        .sort();
    expect(by("opus")).toEqual(["analyst", "architect", "critic", "planner"]);
    expect(by("haiku")).toEqual([
      "document-specialist",
      "executor-trivial",
      "explore",
      "git-master",
      "writer",
    ]);
    expect(by("sonnet")).toHaveLength(12);
    // three executors: minefields, the default, and the trivial
    const x = (n: string) => DEFAULT_AGENTS[n];
    expect(
      [x("executor-careful"), x("executor"), x("executor-trivial")].map((a) => [
        a?.model,
        a?.effort,
      ]),
    ).toEqual([
      ["sonnet", "high"],
      ["sonnet", "medium"],
      ["haiku", "high"],
    ]);
    expect(DEFAULT_AGENTS.architect?.effort).toBe("xhigh");
  });

  it("carry nothing of oh-my-claudecode or an em dash", () => {
    for (const [name, a] of all) {
      const text = `${a.description}\n${a.prompt}`;
      expect(text, name).not.toMatch(/lsp_|ast_grep|TodoWrite|\.omc|notepad|oh-my-claudecode|—/);
    }
  });
});

describe("resolveAgents", () => {
  it("is every shipped agent with no edits", () => {
    expect(Object.keys(resolveAgents())).toHaveLength(21);
    expect(Object.keys(resolveAgents({}))).toEqual(Object.keys(DEFAULT_AGENTS));
  });

  it("drops a disabled agent and keeps the rest", () => {
    const out = resolveAgents({ writer: { enabled: false } });
    expect(out.writer).toBeUndefined();
    expect(Object.keys(out)).toHaveLength(20);
  });

  it("lays an edit over the default and leaves the other fields alone", () => {
    const out = resolveAgents({ explore: { model: "sonnet" } });
    expect(out.explore?.model).toBe("sonnet");
    expect(out.explore?.effort).toBe(DEFAULT_AGENTS.explore?.effort);
    expect(out.explore?.prompt).toBe(DEFAULT_AGENTS.explore?.prompt);
  });

  it("adds an agent of their own, after the shipped ones", () => {
    const mine = { description: "d long enough", model: "haiku", effort: "medium", prompt: "p" };
    const rows = listAgents({ zeta: mine, alpha: mine } as never);
    expect(rows.slice(-2).map((r) => [r.name, r.custom])).toEqual([
      ["alpha", true],
      ["zeta", true],
    ]);
    expect(resolveAgents({ zeta: mine } as never).zeta?.model).toBe("haiku");
  });
});

describe("listAgents", () => {
  it("marks a changed default as edited, and one set back as not", () => {
    expect(
      listAgents({ critic: { model: "sonnet" } }).find((r) => r.name === "critic")?.edited,
    ).toBe(true);
    const same = DEFAULT_AGENTS.critic?.model;
    expect(listAgents({ critic: { model: same } }).find((r) => r.name === "critic")?.edited).toBe(
      false,
    );
  });
});

describe("cleanEdits", () => {
  it("drops bad names, bad fields, and a custom agent that is not whole", () => {
    const out = cleanEdits({
      "Bad Name": { enabled: false },
      writer: {
        enabled: false,
        model: "gpt",
        effort: "low",
        description: "  ",
        prompt: "x".repeat(PROMPT_MAX + 1),
      },
      half: { description: "d", model: "haiku" },
      whole: { description: "d", model: "opus", effort: "high", prompt: "p" },
    });
    expect(out).toEqual({
      writer: { enabled: false },
      whole: { description: "d", model: "opus", effort: "high", prompt: "p" },
    });
  });

  it("takes anything that is not an object as no edits", () => {
    for (const v of [undefined, null, 3, "x", []]) expect(cleanEdits(v)).toEqual({});
  });
});

describe("validateAgent", () => {
  const ok = { description: "d", model: "haiku", effort: "medium", prompt: "p" } as const;

  it("takes a whole definition", () => {
    expect(validateAgent("mine", ok, {}, true)).toBeUndefined();
  });

  it("refuses a taken name, a bad name, and a missing field", () => {
    expect(validateAgent("writer", ok, {}, true)).toMatch(/taken/);
    expect(validateAgent("mine", ok, { mine: ok }, true)).toMatch(/taken/);
    expect(validateAgent("Mine", ok, {}, true)).toMatch(/lowercase/);
    expect(validateAgent("mine", { ...ok, prompt: " " }, {}, true)).toMatch(/prompt/);
    expect(validateAgent("mine", { ...ok, description: "" }, {}, true)).toMatch(/description/);
    expect(validateAgent("mine", { ...ok, effort: "low" as never }, {}, true)).toMatch(/medium/);
  });

  it("lets an existing agent keep its own name when edited", () => {
    expect(validateAgent("writer", ok, {}, false)).toBeUndefined();
  });
});

describe("applyEdit and resetAgent", () => {
  it("keeps only what differs from the default", () => {
    const base = DEFAULT_AGENTS.verifier!;
    const a = applyEdit({}, "verifier", { model: "opus", effort: base.effort });
    expect(a).toEqual({ verifier: { model: "opus" } });
    expect(applyEdit(a, "verifier", { model: base.model })).toEqual({});
  });

  it("turning an agent back on removes the flag", () => {
    const off = applyEdit({}, "writer", { enabled: false });
    expect(off).toEqual({ writer: { enabled: false } });
    expect(applyEdit(off, "writer", { enabled: true })).toEqual({});
  });

  it("reset removes a shipped agent's edit, and deletes one of theirs", () => {
    expect(resetAgent({ writer: { model: "opus" } }, "writer")).toEqual({});
    const mine = { description: "d", model: "haiku", effort: "medium", prompt: "p" } as const;
    expect(resetAgent({ mine }, "mine")).toEqual({});
  });
});

describe("modelFamily", () => {
  it("names the family of a model id, and nothing for one it does not know", () => {
    expect(modelFamily("claude-opus-5")).toBe("opus");
    expect(modelFamily("claude-sonnet-5-5")).toBe("sonnet");
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(modelFamily("claude-fable-5-1")).toBe("fable");
    expect(modelFamily("gpt-5")).toBeUndefined();
    expect(modelFamily(undefined)).toBeUndefined();
  });
});
