import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  clearGitLog,
  ensureWorktrees,
  gitLog,
  reconcileCombo,
  repairCombo,
  repairFolder,
} from "../../src/git/worktrees.ts";
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

describe("reconcileCombo and repair", () => {
  const base = makeSandbox("grove-wt-reconcile-");
  const api = path.join(base, "src", "api");
  const web = path.join(base, "src", "web");
  const lib = path.join(base, "src", "lib");
  const notes = path.join(base, "src", "notes");
  const before = new Map<string, RepoSnapshot>();

  const root = path.join(base, "ws", "alpha");
  const alpha = makeCombo(root, [
    worktree(api),
    worktree(web, { kind: "new", name: "dev/eng-218" }),
    worktree(lib, { kind: "existing", name: "release" }),
    reference(notes),
  ]);
  const targets = ["api", "web", "lib"].map((name) => path.join(root, name));

  beforeAll(async () => {
    await makeRepo(api);
    await makeRepo(web);
    await makeRepo(lib, { branches: ["release"] });
    mkdirSync(notes, { recursive: true });
    for (const repo of [api, web, lib]) before.set(repo, await snapshotRepo(repo));
  });

  it("a fresh combo is all `absent`, and looking creates nothing", async () => {
    clearGitLog();
    const statuses = await reconcileCombo(alpha);
    expect(statuses).toMatchObject([
      { folder: alpha.folders[0], target: targets[0], state: "absent" },
      { folder: alpha.folders[1], target: targets[1], state: "absent" },
      { folder: alpha.folders[2], target: targets[2], state: "absent" },
      { folder: alpha.folders[3], target: notes, state: "reference" },
    ]);
    expect(statuses.slice(0, 3).every((s) => s.message)).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(gitLog).toEqual([]);
  });

  it("built worktrees are `ok` with branch, head and lock. `dirty` only when asked for", async () => {
    await ensureWorktrees(alpha);
    const head = (repo: string) => before.get(repo)!.head;

    const plain = await reconcileCombo(alpha);
    expect(plain).toEqual([
      {
        folder: alpha.folders[0],
        target: targets[0],
        state: "ok",
        detached: true,
        head: head(api),
        locked: false,
      },
      {
        folder: alpha.folders[1],
        target: targets[1],
        state: "ok",
        detached: false,
        head: head(web),
        locked: false,
        branch: "dev/eng-218",
      },
      {
        folder: alpha.folders[2],
        target: targets[2],
        state: "ok",
        detached: false,
        head: head(lib),
        locked: false,
        branch: "release",
      },
      { folder: alpha.folders[3], target: notes, state: "reference" },
    ]);

    writeFileSync(path.join(targets[1]!, "scratch.txt"), "wip\n");
    const asked = await reconcileCombo(alpha, { dirty: true });
    expect(asked.map((s) => s.dirty)).toEqual([false, true, false, undefined]);
    rmSync(path.join(targets[1]!, "scratch.txt"));

    await git(api, "worktree", "lock", "--reason", "on a usb stick", targets[0]!);
    expect((await reconcileCombo(alpha))[0]).toMatchObject({ state: "ok", locked: true });
    await git(api, "worktree", "unlock", targets[0]!);
  });

  it("rm -rf behind git's back is `stale`. ensure leaves it, repairCombo prunes and recreates all three kinds", async () => {
    for (const target of targets) rmSync(target, { recursive: true, force: true });

    const stale = await reconcileCombo(alpha);
    expect(stale.map((s) => s.state)).toEqual(["stale", "stale", "stale", "reference"]);
    expect(stale[0]!.message).toContain("git still lists it");

    clearGitLog();
    const ensured = await ensureWorktrees(alpha);
    expect(ensured.map((o) => [o.action, o.state])).toEqual([
      ["stale", "stale"],
      ["stale", "stale"],
      ["stale", "stale"],
      ["not-applicable", "reference"],
    ]);
    expect(gitLog).toEqual([]);

    const repaired = await repairCombo(alpha);
    expect(repaired.map((o) => [o.action, o.state])).toEqual([
      ["recreated", "ok"],
      ["recreated", "ok"],
      ["recreated", "ok"],
      ["not-applicable", "reference"],
    ]);
    // create-or-attach: the branch outlived its worktree, so the second add must not pass -b
    expect(gitLog).toEqual([
      ["worktree", "prune"],
      ["worktree", "add", "--detach", targets[0], "HEAD"],
      ["worktree", "prune"],
      ["worktree", "add", targets[1], "dev/eng-218"],
      ["worktree", "prune"],
      ["worktree", "add", targets[2], "release"],
    ]);

    expect((await reconcileCombo(alpha)).map((s) => s.state)).toEqual([
      "ok",
      "ok",
      "ok",
      "reference",
    ]);
    expect(await git(targets[0]!, "branch", "--show-current")).toBe("");
    expect(await git(targets[1]!, "branch", "--show-current")).toBe("dev/eng-218");
    expect(await git(targets[2]!, "branch", "--show-current")).toBe("release");
    for (const repo of [api, web, lib]) {
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("prunable");
    }
  });

  it("repairFolder repairs the one folder it is pointed at", async () => {
    rmSync(targets[0]!, { recursive: true, force: true });
    rmSync(targets[1]!, { recursive: true, force: true });

    expect(await repairFolder(alpha, web)).toMatchObject({
      target: targets[1],
      action: "recreated",
      state: "ok",
    });
    expect((await reconcileCombo(alpha)).map((s) => s.state)).toEqual([
      "stale",
      "ok",
      "ok",
      "reference",
    ]);

    // the target path works as well as the origin path
    expect(await repairFolder(alpha, targets[0]!)).toMatchObject({
      action: "recreated",
      state: "ok",
    });
    expect(await repairFolder(alpha, path.join(base, "src", "unknown"))).toMatchObject({
      action: "failed",
    });
  });

  it("an emptied directory that git still lists is `stale` too, and repair brings it back", async () => {
    rmSync(targets[2]!, { recursive: true, force: true });
    mkdirSync(targets[2]!);
    writeFileSync(path.join(targets[2]!, ".DS_Store"), "finder was here");

    expect((await reconcileCombo(alpha))[2]).toMatchObject({ state: "stale" });
    expect(await repairFolder(alpha, lib)).toMatchObject({ action: "recreated", state: "ok" });
    expect(await git(targets[2]!, "branch", "--show-current")).toBe("release");
  });

  it("a directory with a file in it is `foreign`: ensure and repair refuse, the file survives byte for byte", async () => {
    const foreignRoot = path.join(base, "ws", "foreign");
    const combo = makeCombo(foreignRoot, [worktree(api), worktree(web, { kind: "detach" })]);
    const squatter = path.join(foreignRoot, "api");
    const precious = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13, 0]);
    mkdirSync(squatter, { recursive: true });
    writeFileSync(path.join(squatter, "thesis.bin"), precious);

    expect((await reconcileCombo(combo))[0]).toMatchObject({ target: squatter, state: "foreign" });
    expect((await reconcileCombo(combo))[0]!.message).toContain("in the way");

    clearGitLog();
    for (const run of [ensureWorktrees, repairCombo]) {
      const outcomes = await run(combo);
      expect(outcomes[0]).toMatchObject({ action: "refused-foreign", state: "foreign" });
      expect(outcomes[0]!.git).toBeUndefined();
      // the folder after it is still taken care of
      expect(outcomes[1]!.state).toBe("ok");
    }
    expect(gitLog.filter((args) => args.includes(squatter))).toEqual([]);
    expect(readdirSync(squatter)).toEqual(["thesis.bin"]);
    expect(readFileSync(path.join(squatter, "thesis.bin")).equals(precious)).toBe(true);
  });

  it("a full clone, a file, a symlink, another repo's worktree and a moved worktree are all `foreign`", async () => {
    const zooRoot = path.join(base, "ws", "zoo");
    const combo = makeCombo(zooRoot, [
      worktree(api, { kind: "detach" }, "clone"),
      worktree(api, { kind: "detach" }, "file"),
      worktree(api, { kind: "detach" }, "link"),
      worktree(api, { kind: "detach" }, "other-repo"),
      worktree(api, { kind: "detach" }, "moved"),
    ]);
    mkdirSync(zooRoot, { recursive: true });
    await git(base, "clone", "-q", api, path.join(zooRoot, "clone"));
    writeFileSync(path.join(zooRoot, "file"), "not a directory\n");
    symlinkSync(api, path.join(zooRoot, "link"));
    await git(web, "worktree", "add", "--detach", path.join(zooRoot, "other-repo"), "HEAD");
    // a real worktree of the right origin, but git lists it somewhere else
    await git(api, "worktree", "add", "--detach", path.join(base, "elsewhere"), "HEAD");
    mkdirSync(path.join(zooRoot, "moved"));
    writeFileSync(
      path.join(zooRoot, "moved", ".git"),
      readFileSync(path.join(base, "elsewhere", ".git")),
    );

    const statuses = await reconcileCombo(combo);
    expect(statuses.map((s) => s.state)).toEqual(Array.from({ length: 5 }, () => "foreign"));
    expect(statuses.map((s) => s.message)).toEqual([
      "a separate clone is in the way",
      "a file is in the way",
      "a symlink is in the way",
      "a worktree of another repository is in the way",
      "a worktree the origin does not list at this path is in the way",
    ]);

    clearGitLog();
    const outcomes = await repairCombo(combo);
    expect(outcomes.map((o) => o.action)).toEqual(
      Array.from({ length: 5 }, () => "refused-foreign"),
    );
    expect(gitLog).toEqual([]);
    expect(existsSync(path.join(zooRoot, "clone", ".git", "HEAD"))).toBe(true);
    expect(readFileSync(path.join(zooRoot, "file"), "utf8")).toBe("not a directory\n");
    expect(await git(path.join(zooRoot, "other-repo"), "rev-parse", "--show-toplevel")).toBe(
      path.join(zooRoot, "other-repo"),
    );
  });

  it("a target that escapes the combo root is `foreign` and git never hears about it", async () => {
    const escapeRoot = path.join(base, "ws", "escape");
    const combo = makeCombo(escapeRoot, [
      worktree(api, { kind: "detach" }, "../escaped"),
      worktree(api, { kind: "detach" }, "."),
    ]);
    clearGitLog();
    const outcomes = await ensureWorktrees(combo);
    expect(outcomes.map((o) => [o.action, o.state])).toEqual([
      ["refused-foreign", "foreign"],
      ["refused-foreign", "foreign"],
    ]);
    expect(gitLog).toEqual([]);
    expect(existsSync(path.join(base, "ws", "escaped"))).toBe(false);
  });

  it("an empty directory or one with only a .DS_Store is `absent`, and ensure builds over it", async () => {
    const emptyRoot = path.join(base, "ws", "empty");
    const combo = makeCombo(emptyRoot, [
      worktree(api, { kind: "detach" }, "bare-dir"),
      worktree(web, { kind: "new", name: "vv/over-ds-store" }, "finder-dir"),
    ]);
    mkdirSync(path.join(emptyRoot, "bare-dir"), { recursive: true });
    mkdirSync(path.join(emptyRoot, "finder-dir"));
    writeFileSync(path.join(emptyRoot, "finder-dir", ".DS_Store"), "finder was here");

    expect((await reconcileCombo(combo)).map((s) => s.state)).toEqual(["absent", "absent"]);
    expect(await ensureWorktrees(combo)).toMatchObject([
      { action: "created", state: "ok" },
      { action: "created", state: "ok" },
    ]);
    expect(await git(path.join(emptyRoot, "finder-dir"), "branch", "--show-current")).toBe(
      "vv/over-ds-store",
    );
    expect(existsSync(path.join(emptyRoot, "finder-dir", ".DS_Store"))).toBe(false);
  });

  it("a deleted origin and a deleted reference are both `missing-origin`, whatever is at the target", async () => {
    const doomed = path.join(base, "src", "doomed");
    const doomedNotes = path.join(base, "src", "doomed-notes");
    await makeRepo(doomed);
    mkdirSync(doomedNotes);
    const goneRoot = path.join(base, "ws", "gone");
    const combo = makeCombo(goneRoot, [worktree(doomed), reference(doomedNotes), worktree(web)]);
    expect(await ensureWorktrees(combo)).toMatchObject([
      { action: "created" },
      { action: "not-applicable" },
      { action: "created" },
    ]);

    rmSync(doomed, { recursive: true, force: true });
    rmSync(doomedNotes, { recursive: true, force: true });

    const statuses = await reconcileCombo(combo);
    expect(statuses.map((s) => s.state)).toEqual(["missing-origin", "missing-origin", "ok"]);
    expect(statuses[0]!.message).toContain(doomed);
    expect(statuses[1]!.message).toContain(doomedNotes);

    clearGitLog();
    const outcomes = await repairCombo(combo);
    expect(outcomes.map((o) => [o.action, o.state])).toEqual([
      ["missing-origin", "missing-origin"],
      ["not-applicable", "missing-origin"],
      ["exists", "ok"],
    ]);
    expect(gitLog).toEqual([]);
    // the orphaned checkout is somebody's work. it stays.
    expect(existsSync(path.join(goneRoot, "doomed", "README.md"))).toBe(true);

    // a plain directory and a file are not origins either
    const notRepos = makeCombo(path.join(base, "ws", "not-repos"), [
      worktree(notes),
      worktree(path.join(api, "README.md")),
    ]);
    expect((await reconcileCombo(notRepos)).map((s) => s.state)).toEqual([
      "missing-origin",
      "missing-origin",
    ]);
  });

  it("the origin clones are intact: clean, same HEAD, same branch, nothing deleted", async () => {
    for (const repo of [api, web, lib]) {
      const now = await snapshotRepo(repo);
      const was = before.get(repo)!;
      expect(now.status).toBe("");
      expect(now.head).toBe(was.head);
      expect(now.branch).toBe("main");
      expect(now.branches).toEqual(expect.arrayContaining(was.branches));
    }
    expect((await snapshotRepo(web)).branches).toContain("refs/heads/dev/eng-218");
  });
});
