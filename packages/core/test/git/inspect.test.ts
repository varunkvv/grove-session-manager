import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyPath } from "../../src/git/inspect.ts";
import { git, makeRepo } from "../helpers/git.ts";
import { makeSandbox } from "../helpers/transcript.ts";

describe("classifyPath", () => {
  const base = makeSandbox("grove-git-inspect-");
  const repo = path.join(base, "api");
  const held = path.join(base, "trees", "api-login");
  const plain = path.join(base, "notes");
  let head = "";

  beforeAll(async () => {
    await makeRepo(repo, { branches: ["feature/login", "release"] });
    mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    mkdirSync(plain);
    writeFileSync(path.join(plain, "todo.md"), "- things\n");
    await git(repo, "worktree", "add", held, "feature/login");
    head = await git(repo, "rev-parse", "HEAD");
  });

  it("a directory that is not in a repo can only be a reference", async () => {
    expect(await classifyPath(plain)).toEqual({
      path: plain,
      exists: true,
      isDirectory: true,
      isGitRepo: false,
      isToplevel: false,
      branches: [],
      allowedModes: ["reference"],
      suggestedDirName: "notes",
    });
  });

  it("a repo toplevel allows a worktree and lists branches with where they are checked out", async () => {
    const info = await classifyPath(repo);
    expect(info).toMatchObject({
      path: repo,
      exists: true,
      isDirectory: true,
      isGitRepo: true,
      isToplevel: true,
      toplevel: repo,
      commonDir: path.join(repo, ".git"),
      currentBranch: "main",
      head,
      suggestedDirName: "api",
    });
    expect(info.allowedModes).toEqual(["reference", "worktree"]);
    expect(info.allowedModes).toContain("worktree");
    expect(info.branches).toEqual([
      { name: "feature/login", checkedOutAt: held },
      { name: "main", checkedOutAt: repo },
      { name: "release" },
    ]);
  });

  it("a subdirectory of a repo is reference only, and still says which repo it is in", async () => {
    const info = await classifyPath(path.join(repo, "src", "deep"));
    expect(info.allowedModes).toEqual(["reference"]);
    expect(info).toMatchObject({
      isGitRepo: true,
      isToplevel: false,
      toplevel: repo,
      currentBranch: "main",
      suggestedDirName: "deep",
    });
  });

  it("a linked worktree is a toplevel of its own, sharing the origin's common dir", async () => {
    const info = await classifyPath(held);
    expect(info).toMatchObject({
      isToplevel: true,
      toplevel: held,
      commonDir: path.join(repo, ".git"),
      currentBranch: "feature/login",
      head,
    });
    expect(info.allowedModes).toContain("worktree");
  });

  it("a bare repo is reference only", async () => {
    const bare = path.join(base, "api.git");
    await git(base, "clone", "-q", "--bare", repo, bare);
    const info = await classifyPath(bare);
    expect(info).toMatchObject({ isGitRepo: true, isToplevel: false, commonDir: bare });
    expect(info.toplevel).toBeUndefined();
    expect(info.allowedModes).toEqual(["reference"]);
    expect(info.branches.map((b) => b.name)).toEqual(["feature/login", "main", "release"]);
  });

  it("a repo with no commit yet has a branch name and no head", async () => {
    const unborn = path.join(base, "unborn");
    mkdirSync(unborn);
    await git(unborn, "init", "-q", "-b", "main");
    const info = await classifyPath(unborn);
    expect(info).toMatchObject({ isToplevel: true, currentBranch: "main", branches: [] });
    expect(info.head).toBeUndefined();
  });

  it("a detached HEAD has a head and no current branch", async () => {
    const detached = path.join(base, "trees", "api-detached");
    await git(repo, "worktree", "add", "--detach", detached, "HEAD");
    const info = await classifyPath(detached);
    expect(info.head).toBe(head);
    expect(info.currentBranch).toBeUndefined();
  });

  it("a branch that shares its name with a tag keeps its real name", async () => {
    const twin = path.join(base, "twin");
    await makeRepo(twin, { branches: ["v1"] });
    await git(twin, "tag", "v1");
    expect((await classifyPath(twin)).branches.map((b) => b.name)).toEqual(["main", "v1"]);
  });

  it("a symlink to a repo resolves to the same toplevel", async () => {
    const link = path.join(base, "api-link");
    symlinkSync(repo, link);
    const info = await classifyPath(link);
    expect(info).toMatchObject({ path: link, isToplevel: true, toplevel: repo });
    expect(info.allowedModes).toContain("worktree");
  });

  it("a file and a missing path allow nothing, and nothing throws", async () => {
    expect(await classifyPath(path.join(plain, "todo.md"))).toMatchObject({
      exists: true,
      isDirectory: false,
      isGitRepo: false,
      allowedModes: [],
    });
    expect(await classifyPath(path.join(base, "nope", "never"))).toEqual({
      path: path.join(base, "nope", "never"),
      exists: false,
      isDirectory: false,
      isGitRepo: false,
      isToplevel: false,
      branches: [],
      allowedModes: [],
      suggestedDirName: "never",
    });
  });
});
