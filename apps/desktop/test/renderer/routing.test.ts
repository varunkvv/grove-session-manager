import { DEFAULT_AGENTS, listAgents } from "@grove/core/pure";
import { describe, expect, it } from "vitest";
import {
  BLANK,
  draftErrors,
  draftOf,
  enabledCount,
  filterRows,
  groupRows,
  isDirty,
  isValid,
  saveDraft,
} from "../../src/renderer/logic/routing.ts";

const shipped = Object.keys(DEFAULT_AGENTS);
const first = shipped[0] as string;

describe("grouping and filtering", () => {
  it("groups by tier, cheapest first, and counts every shipped agent once", () => {
    const groups = groupRows(listAgents());
    expect(groups.map((g) => g.tier)).toEqual(["haiku", "sonnet", "opus"]);
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(shipped.length);
  });

  it("leaves out a tier with nothing in it", () => {
    const rows = listAgents().filter((r) => r.model === "opus");
    expect(groupRows(rows).map((g) => g.tier)).toEqual(["opus"]);
  });

  it("filters on and off, and counts what is on", () => {
    const rows = listAgents({ [first]: { enabled: false } });
    expect(enabledCount(rows)).toBe(shipped.length - 1);
    expect(filterRows(rows, "off").map((r) => r.name)).toEqual([first]);
    expect(filterRows(rows, "on")).toHaveLength(shipped.length - 1);
    expect(filterRows(rows, "all")).toHaveLength(shipped.length);
  });
});

describe("the edit view", () => {
  const row = listAgents().find((r) => r.name === first);

  it("is clean until a field moves, and clean again when it moves back", () => {
    const d = draftOf(row);
    expect(isDirty(d, row)).toBe(false);
    expect(isDirty({ ...d, description: `${d.description}!` }, row)).toBe(true);
    expect(isDirty(d, row)).toBe(false);
  });

  it("a blank new agent is clean, haiku and medium", () => {
    expect(isDirty(BLANK, undefined)).toBe(false);
    expect(BLANK.model).toBe("haiku");
    expect(BLANK.effort).toBe("medium");
  });

  it("says which field is wrong", () => {
    expect(Object.keys(draftErrors(BLANK, {}, true)).sort()).toEqual([
      "description",
      "name",
      "prompt",
    ]);
    const ok = { ...BLANK, name: "mine", description: "d", prompt: "p" };
    expect(draftErrors(ok, {}, true)).toEqual({});
    expect(isValid(ok, {}, true)).toBe(true);
    expect(draftErrors({ ...ok, name: first }, {}, true).name).toMatch(/taken/);
    expect(draftErrors({ ...ok, name: "Bad Name" }, {}, true).name).toBeDefined();
    expect(draftErrors({ ...ok, prompt: " " }, {}, true)).toHaveProperty("prompt");
  });

  it("a name taken is fine for the agent being edited", () => {
    expect(isValid(draftOf(row), {}, false)).toBe(true);
  });

  it("saving a shipped agent keeps only what differs from the default", () => {
    const d = { ...draftOf(row), effort: "max" as const };
    expect(saveDraft({}, d)).toEqual({ [first]: { effort: "max" } });
    expect(saveDraft({ [first]: { effort: "max" } }, draftOf(row))).toEqual({});
  });

  it("saving a new agent keeps all four fields, and it lists enabled in its tier", () => {
    const d = { ...BLANK, name: "mine", description: "d", prompt: "p", model: "opus" as const };
    const edits = saveDraft({}, d);
    expect(edits.mine).toEqual({
      description: "d",
      prompt: "p",
      model: "opus",
      effort: "medium",
    });
    const mine = listAgents(edits).find((r) => r.name === "mine");
    expect(mine).toMatchObject({ custom: true, enabled: true, model: "opus" });
  });
});
