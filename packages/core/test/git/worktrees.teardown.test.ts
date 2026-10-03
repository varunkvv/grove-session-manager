import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  clearGitLog,
  ensureWorktrees,
  gitLog,
  reconcileCombo,
  teardownCombo,
} from "../../src/git/worktrees.ts";
import type { TeardownOutcome } from "../../src/types.ts";
import {
  git,
  makeCombo,
  makeRepo,
  type RepoSnapshot,
  reference,
  snapshotRepo,
  worktree,
} from "../helpers/git.ts";
import { makeSandbox } from "../helpers/transcript.ts";

describe("teardownCombo", () => {
  const base = makeSandbox("grove-wt-teardown-");
  const api = path.join(base, "src", "api");
  const web = path.join(base, "src", "web");
  const lib = path.join(base, "src", "lib");
  const notes = path.join(base, "src", "notes");
  const before = new Map<string, RepoSnapshot>();

  const root = path.join(base, "ws", "alpha");
  const alpha = makeCombo(root, [
    worktree(api),
    worktree(web, { kind: "new", name: "vv/teardown" }),
    worktree(lib, { kind: "existing", name: "release" }),
    reference(notes),
  ]);
  const [apiTree, webTree, libTree] = ["api", "web", "lib"].map((name) => path.join(root, name));

  beforeAll(async () => {
    await makeRepo(api);
    await makeRepo(web);
    await makeRepo(lib, { branches: ["release"] });
    mkdirSync(notes, { recursive: true });
    writeFileSync(path.join(notes, "todo.md"), "- ship it\n");
    for (const repo of [api, web, lib]) before.set(repo, await snapshotRepo(repo));
  });

  it("an uncommitted change is `skipped-dirty` and stays on disk. clean worktrees are removed, nothing else is", async () => {
    await ensureWorktrees(alpha);
    writeFileSync(path.join(root, "CLAUDE.md"), "# alpha\n");
    mkdirSync(path.join(root, ".claude"));
    writeFileSync(path.join(root, ".claude", "settings.json"), "{}\n");
    writeFileSync(path.join(webTree!, "scratch.txt"), "two days of work\n");

    clearGitLog();
    const heard: TeardownOutcome[] = [];
    const outcomes = await teardownCombo(alpha, { onOutcome: (o) => heard.push(o) });

    expect(outcomes).toMatchObject([
      { target: apiTree, action: "removed" },
      { target: webTree, action: "skipped-dirty", dirtyPaths: ["scratch.txt"] },
      { target: libTree, action: "removed" },
      { target: notes, action: "untouched" },
    ]);
    expect(heard).toEqual(outcomes);
    // plain removes only. nothing here can pass --force.
    expect(gitLog).toEqual([
      ["worktree", "remove", apiTree],
      ["worktree", "remove", webTree],
      ["worktree", "remove", libTree],
    ]);
    expect(outcomes[1]!.git).toMatchObject({ exitCode: 128 });

    expect(readFileSync(path.join(webTree!, "scratch.txt"), "utf8")).toBe("two days of work\n");
    expect(existsSync(apiTree!)).toBe(false);
    expect(existsSync(libTree!)).toBe(false);
    expect(readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toBe("# alpha\n");
    expect(readFileSync(path.join(root, ".claude", "settings.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(path.join(notes, "todo.md"), "utf8")).toBe("- ship it\n");
    expect((await reconcileCombo(alpha)).map((s) => s.state)).toEqual([
      "absent",
      "ok",
      "absent",
      "reference",
    ]);
  });

  it("once the change is gone the worktree goes too, and its branch stays", async () => {
    rmSync(path.join(webTree!, "scratch.txt"));
    clearGitLog();
    const outcomes = await teardownCombo(alpha);

    expect(outcomes[1]).toMatchObject({ target: webTree, action: "removed" });
    expect(gitLog).toEqual([["worktree", "remove", webTree]]);
    expect(existsSync(webTree!)).toBe(false);
    // the combo root is ours to keep even when it holds no worktree any more
    expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(true);
    expect(await git(web, "rev-parse", "--verify", "refs/heads/vv/teardown")).toBe(
      before.get(web)!.head,
    );
  });

  it("building the combo again attaches to the branch the teardown left behind", async () => {
    clearGitLog();
    const outcomes = await ensureWorktrees(alpha);
    expect(outcomes.map((o) => o.action)).toEqual([
      "created",
      "attached",
      "created",
      "not-applicable",
    ]);
    expect(gitLog[1]).toEqual(["worktree", "add", webTree, "vv/teardown"]);
    expect(await git(webTree!, "branch", "--show-current")).toBe("vv/teardown");
  });

  it("tracked edits, a staged rename and a pile of new files: dirtyPaths names them, ten at most", async () => {
    writeFileSync(path.join(libTree!, "README.md"), "# lib, edited\n");
    await git(webTree!, "mv", "README.md", "README.rst");
    for (let i = 0; i < 12; i++) writeFileSync(path.join(apiTree!, `note-${i}.txt`), "x\n");

    const outcomes = await teardownCombo(alpha);
    expect(outcomes.map((o) => o.action)).toEqual([
      "skipped-dirty",
      "skipped-dirty",
      "skipped-dirty",
      "untouched",
    ]);
    expect(outcomes[0]!.dirtyPaths).toHaveLength(10);
    expect(outcomes[0]!.dirtyPaths![0]).toMatch(/^note-\d+\.txt$/);
    // the old name of a rename is a separate token in -z output. it is not a dirty path.
    expect(outcomes[1]!.dirtyPaths).toEqual(["README.rst"]);
    expect(outcomes[2]!.dirtyPaths).toEqual(["README.md"]);

    // the test's own cleanup. nothing in core passes --force
    for (const [origin, tree] of [
      [api, apiTree],
      [web, webTree],
      [lib, libTree],
    ] as const) {
      await git(origin, "worktree", "remove", "--force", tree!);
    }
    expect((await reconcileCombo(alpha)).map((s) => s.state)).toEqual([
      "absent",
      "absent",
      "absent",
      "reference",
    ]);
  });

  it("a foreign directory at the target is left alone", async () => {
    const foreignRoot = path.join(base, "ws", "foreign");
    const combo = makeCombo(foreignRoot, [worktree(api), reference(notes)]);
    const squatter = path.join(foreignRoot, "api");
    mkdirSync(squatter, { recursive: true });
    writeFileSync(path.join(squatter, "thesis.txt"), "years of work\n");

    clearGitLog();
    expect(await teardownCombo(combo)).toMatchObject([
      { target: squatter, action: "untouched" },
      { action: "untouched" },
    ]);

    expect(gitLog).toEqual([]);
    expect(readFileSync(path.join(squatter, "thesis.txt"), "utf8")).toBe("years of work\n");
    expect(readFileSync(path.join(notes, "todo.md"), "utf8")).toBe("- ship it\n");
  });

  it("a full clone at the target is left alone too", async () => {
    const cloneRoot = path.join(base, "ws", "clone");
    const combo = makeCombo(cloneRoot, [worktree(api)]);
    mkdirSync(cloneRoot, { recursive: true });
    await git(base, "clone", "-q", api, path.join(cloneRoot, "api"));

    clearGitLog();
    expect(await teardownCombo(combo)).toMatchObject([{ action: "untouched" }]);
    expect(gitLog).toEqual([]);
    expect(await git(path.join(cloneRoot, "api"), "rev-parse", "HEAD")).toBe(before.get(api)!.head);
  });

  it("a locked worktree is `skipped-locked`", async () => {
    const lockedRoot = path.join(base, "ws", "locked");
    const combo = makeCombo(lockedRoot, [worktree(api)]);
    const tree = path.join(lockedRoot, "api");
    await ensureWorktrees(combo);
    await git(api, "worktree", "lock", "--reason", "on a usb stick", tree);

    clearGitLog();
    expect(await teardownCombo(combo)).toMatchObject([{ action: "skipped-locked" }]);
    expect(gitLog).toEqual([["worktree", "remove", tree]]);
    expect(existsSync(path.join(tree, "README.md"))).toBe(true);

    await git(api, "worktree", "unlock", tree);
    expect(await teardownCombo(combo)).toMatchObject([{ action: "removed" }]);
  });

  it("a stale entry is pruned and reported `removed`. the branch it held is kept", async () => {
    const staleRoot = path.join(base, "ws", "stale");
    const combo = makeCombo(staleRoot, [worktree(web, { kind: "new", name: "vv/stale" })]);
    await ensureWorktrees(combo);
    rmSync(path.join(staleRoot, "web"), { recursive: true, force: true });
    expect(await reconcileCombo(combo)).toMatchObject([{ state: "stale" }]);

    clearGitLog();
    expect(await teardownCombo(combo)).toMatchObject([{ action: "removed" }]);
    expect(gitLog).toEqual([["worktree", "prune"]]);
    expect(await reconcileCombo(combo)).toMatchObject([{ state: "absent" }]);
    expect(await git(web, "worktree", "list", "--porcelain")).not.toContain(staleRoot);
    expect(await git(web, "rev-parse", "--verify", "refs/heads/vv/stale")).toBe(
      before.get(web)!.head,
    );
  });

  it("tearing down a combo that was never built touches nothing", async () => {
    const neverRoot = path.join(base, "ws", "never");
    clearGitLog();
    const outcomes = await teardownCombo(makeCombo(neverRoot, [worktree(api), reference(notes)]));
    expect(outcomes.map((o) => o.action)).toEqual(["untouched", "untouched"]);
    expect(gitLog).toEqual([]);
    expect(existsSync(neverRoot)).toBe(false);
  });

  it("after all of it the origin clones are intact, and no branch made for a worktree was deleted", async () => {
    for (const repo of [api, web, lib]) {
      const now = await snapshotRepo(repo);
      const was = before.get(repo)!;
      expect(now.status).toBe("");
      expect(now.head).toBe(was.head);
      expect(now.branch).toBe("main");
      expect(now.branches).toEqual(expect.arrayContaining(was.branches));
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("prunable");
    }
    expect((await snapshotRepo(web)).branches).toEqual([
      "refs/heads/main",
      "refs/heads/vv/stale",
      "refs/heads/vv/teardown",
    ]);
    expect((await snapshotRepo(lib)).branches).toEqual(["refs/heads/main", "refs/heads/release"]);
    // the root and what the app keeps in it outlive every teardown
    expect(readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toBe("# alpha\n");
    expect(existsSync(path.join(root, ".claude", "settings.json"))).toBe(true);
  });
});
