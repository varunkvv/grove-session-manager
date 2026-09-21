import path from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceFolders } from "../../src/combos/folders.ts";
import { normalizeCombosFile, targetDirFor } from "../../src/combos/schema.ts";

const APP = "/Users/you/claude-ws";

describe("combo model", () => {
  it("string folders load as references (older format)", () => {
    const { combos, problems } = normalizeCombosFile(
      {
        combos: [
          { name: "legacy", root: `${APP}/legacy`, folders: ["/Users/you/src/api", "~/src/logs"] },
        ],
      },
      APP,
      "/Users/you",
    );
    expect(problems).toEqual([]);
    expect(combos[0]!.folders).toEqual([
      { path: "/Users/you/src/api", mode: "reference" },
      { path: "/Users/you/src/logs", mode: "reference" },
    ]);
  });

  it("the documented shape loads as written, worktree without a branch means detached", () => {
    const { combos } = normalizeCombosFile(
      {
        combos: [
          {
            name: "prod-debug",
            root: `${APP}/prod-debug`,
            note: "incident triage",
            folders: [
              { path: "/Users/you/src/api", mode: "worktree", branch: { kind: "detach" } },
              {
                path: "/Users/you/src/shared",
                mode: "worktree",
                branch: { kind: "new", name: "prod-debug" },
              },
              { path: "/Users/you/src/web", mode: "worktree" },
              { path: "/Users/you/src/logs", mode: "reference" },
            ],
          },
        ],
      },
      APP,
    );
    const c = combos[0]!;
    expect(c.note).toBe("incident triage");
    expect(c.folders.map((f) => f.branch?.kind)).toEqual(["detach", "new", "detach", undefined]);
    expect(targetDirFor(c, c.folders[1]!)).toBe(`${APP}/prod-debug/shared`);
    expect(targetDirFor(c, { ...c.folders[0]!, as: "api-copy" })).toBe(
      `${APP}/prod-debug/api-copy`,
    );
    expect(targetDirFor(c, c.folders[3]!)).toBe("/Users/you/src/logs");
  });

  it("a missing root defaults to <appRoot>/<slug of the name>", () => {
    const { combos } = normalizeCombosFile({ combos: [{ name: "ENG 218!", folders: [] }] }, APP);
    expect(combos[0]!.root).toBe(path.join(APP, "eng-218"));
  });

  it("one broken combo is reported and kept aside, the rest still load", () => {
    const broken = {
      name: "bad",
      folders: [{ path: "/x", mode: "worktree", branch: { kind: "new" } }],
    };
    const { combos, problems, rejected } = normalizeCombosFile(
      {
        combos: [
          broken,
          { name: "good", folders: [] },
          { folders: [] },
          { name: "GOOD", folders: [] },
        ],
      },
      APP,
    );
    expect(combos.map((c) => c.name)).toEqual(["good"]);
    expect(problems.map((p) => p.combo)).toEqual(["bad", undefined, "GOOD"]);
    expect(rejected).toHaveLength(3);
    expect(rejected[0]).toBe(broken);
  });

  it("unknown keys survive, junk input yields nothing and never throws", () => {
    const { combos } = normalizeCombosFile(
      {
        combos: [
          { name: "x", colour: "teal", folders: [{ path: "/a", mode: "reference", pinned: true }] },
        ],
      },
      APP,
    );
    expect(combos[0]).toMatchObject({ colour: "teal" });
    expect(combos[0]!.folders[0]).toMatchObject({ pinned: true });
    for (const junk of [null, 3, "x", [], {}, { combos: "no" }]) {
      expect(normalizeCombosFile(junk, APP).combos).toEqual([]);
    }
  });
});

describe("workspaceFolders", () => {
  it("workspaceFolders(combo)[0] === combo.root, then references only", () => {
    const { combos } = normalizeCombosFile(
      {
        combos: [
          {
            name: "prod-debug",
            root: `${APP}/prod-debug`,
            folders: [
              { path: "/Users/you/src/api", mode: "worktree" },
              { path: "/Users/you/src/logs", mode: "reference" },
              "/Users/you/src/docs",
            ],
          },
        ],
      },
      APP,
    );
    const combo = combos[0]!;
    expect(workspaceFolders(combo)[0]).toBe(combo.root);
    // worktrees are children of the root. listing them again would show them twice.
    expect(workspaceFolders(combo)).toEqual([
      combo.root,
      "/Users/you/src/logs",
      "/Users/you/src/docs",
    ]);
  });
});
