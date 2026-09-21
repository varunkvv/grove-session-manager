import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateComboName, validateComboRoot, validateFolders } from "../../src/combos/rules.ts";
import type { Combo } from "../../src/types.ts";
import { makeSandbox } from "../helpers/transcript.ts";

const base = makeSandbox("grove-rules-");
const app = path.join(base, "claude-ws");
const home = path.join(base, "home");
mkdirSync(app, { recursive: true });
mkdirSync(home, { recursive: true });
const combo = (
  name: string,
  folders: Combo["folders"] = [],
  root = path.join(app, name),
): Combo => ({ name, root, folders });

describe("combo names", () => {
  it("unique case-insensitively, and by directory slug", () => {
    const existing = [combo("prod-debug")];
    expect(validateComboName("feature x", existing)).toEqual({ slug: "feature-x" });
    expect(validateComboName("Prod-Debug", existing).problem).toBeDefined();
    expect(validateComboName("prod.debug", existing).problem).toBeDefined();
    expect(validateComboName("prod-debug", existing, "prod-debug").problem).toBeUndefined();
    expect(validateComboName("   ", existing).problem).toBeDefined();
    expect(validateComboName("!!!", existing).problem).toBeDefined();
  });
});

describe("combo roots", () => {
  it("a sane root passes", () => {
    expect(
      validateComboRoot(
        combo("a", [{ path: "/Users/you/src/api", mode: "worktree" }]),
        [],
        app,
        home,
      ).problems,
    ).toEqual([]);
  });

  it("home, the app folder and ~/.claude are refused", () => {
    expect(validateComboRoot(combo("x", [], home), [], app, home).problems).toHaveLength(1);
    expect(validateComboRoot(combo("x", [], app), [], app, home).problems).toHaveLength(1);
    expect(
      validateComboRoot(combo("x", [], path.join(home, ".claude", "ws")), [], app, home).problems,
    ).toHaveLength(1);
    expect(validateComboRoot(combo("x", [], "relative/path"), [], app, home).problems).toHaveLength(
      1,
    );
  });

  it("roots may not nest, and members may not live inside the root", () => {
    const outer = combo("outer");
    expect(
      validateComboRoot(combo("inner", [], path.join(outer.root, "inner")), [outer], app, home)
        .problems,
    ).toHaveLength(1);
    const self = combo("self", [{ path: path.join(app, "self", "api"), mode: "reference" }]);
    expect(validateComboRoot(self, [], app, home).problems).toHaveLength(1);
    const inside = combo("deep", [{ path: app, mode: "reference" }]);
    expect(validateComboRoot(inside, [], app, home).problems).toHaveLength(1);
  });

  it("another combo's worktree dir that slugs the same is a collision", () => {
    // <app>/prod-debug/api and <app>/prod-debug-api share one Claude project dir
    const other = combo("prod-debug", [{ path: "/Users/you/src/api", mode: "worktree" }]);
    const clash = combo("prod-debug-api");
    expect(validateComboRoot(clash, [other], app, home).problems.join(" ")).toContain("same place");
    expect(validateComboRoot(combo("prod-debug-web"), [other], app, home).problems).toEqual([]);
  });
});

describe("folders", () => {
  it("two members with one basename need a folder name", () => {
    const c = combo("c", [
      { path: "/Users/you/src/api", mode: "worktree" },
      { path: "/Users/you/forks/api", mode: "worktree" },
    ]);
    expect(validateFolders(c)).toHaveLength(1);
    c.folders[1]!.as = "api-fork";
    expect(validateFolders(c)).toEqual([]);
  });

  it("`as` must be one plain folder name and may not shadow our own files", () => {
    for (const as of [
      "../x",
      "a/b",
      ".hidden",
      "-flag",
      "CLAUDE.md",
      ".claude",
      "c.code-workspace",
      "",
    ]) {
      const c = combo("c", [{ path: "/Users/you/src/api", mode: "worktree", as }]);
      expect(validateFolders(c).length, as).toBeGreaterThan(0);
    }
  });

  it("a repo that is itself called 'context' needs another folder name", () => {
    const c = combo("c", [{ path: "/Users/you/src/context", mode: "worktree" }]);
    expect(validateFolders(c).join(" ")).toContain("another folder name");
    c.folders[0]!.as = "context-repo";
    expect(validateFolders(c)).toEqual([]);
    // a reference never lands inside the combo folder, so its name is free
    expect(
      validateFolders(combo("c", [{ path: "/Users/you/src/plans", mode: "reference" }])),
    ).toEqual([]);
  });

  it("the same path twice is reported, references may share a basename", () => {
    const dup = combo("c", [
      { path: "/a/api", mode: "reference" },
      { path: "/a/api", mode: "reference" },
    ]);
    expect(validateFolders(dup)).toHaveLength(1);
    const refs = combo("c", [
      { path: "/a/api", mode: "reference" },
      { path: "/b/api", mode: "reference" },
    ]);
    expect(validateFolders(refs)).toEqual([]);
  });
});
