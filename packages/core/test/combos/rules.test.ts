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

describe("the words the project form shows", () => {
  it("say project, not combo", () => {
    expect(validateComboName(" ", []).problem).toBe("Give the project a name.");
    expect(validateComboName("x", [combo("X")]).problem).toBe('"X" already uses that name.');
    expect(validateComboRoot(combo("x", [], "rel"), [], app, home).problems).toEqual([
      "The project folder must be an absolute path.",
    ]);
    expect(validateComboRoot(combo("x", [], home), [], app, home).problems).toEqual([
      "The project folder cannot be your home folder.",
    ]);
    expect(
      validateComboRoot(combo("x", [], path.join(home, ".claude", "ws")), [], app, home).problems,
    ).toEqual(["The project folder cannot live inside ~/.claude."]);
    const root = path.join(app, "p");
    expect(
      validateComboRoot(
        combo("p", [{ path: path.join(root, "api"), mode: "reference" }]),
        [],
        app,
        home,
      ).problems,
    ).toEqual([
      `${path.join(root, "api")} is inside the project folder. Repos must live elsewhere.`,
    ]);
    expect(
      validateComboRoot(combo("p", [{ path: app, mode: "reference" }]), [], app, home).problems,
    ).toEqual([`The project folder is inside ${app}.`]);
    expect(
      validateComboRoot(combo("inner", [], path.join(root, "inner")), [combo("p")], app, home)
        .problems,
    ).toEqual(['The project folder overlaps with "p".']);
    const other = combo("prod-debug", [{ path: "/Users/you/src/api", mode: "worktree" }]);
    expect(validateComboRoot(combo("prod-debug-api"), [other], app, home).problems).toEqual([
      `Claude Code would store this project's sessions in the same place as "prod-debug". Pick another name.`,
    ]);
    expect(
      validateFolders(combo("c", [{ path: "/Users/you/src/cards", mode: "worktree" }])),
    ).toEqual([
      '"cards" is a name the project folder uses itself. Give that working copy another folder name.',
    ]);
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

  it("a repo named like a record folder or the server file needs another folder name", () => {
    for (const name of ["cards", "conclusions", ".mcp.json", "Cards"]) {
      const c = combo("c", [{ path: `/Users/you/src/${name}`, mode: "worktree" }]);
      expect(validateFolders(c).join(" "), name).toContain("another folder name");
    }
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
