import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveGitBinary } from "../../src/git/exec.ts";
import {
  clearGitLog,
  ensureWorktrees,
  gitLog,
  reconcileCombo,
  teardownCombo,
} from "../../src/git/worktrees.ts";
import type { FolderOutcome } from "../../src/types.ts";
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

const adds = () => gitLog.filter((args) => args[0] === "worktree" && args[1] === "add");

describe("ensureWorktrees", () => {
  const base = makeSandbox("grove-wt-create-");
  const api = path.join(base, "src", "api");
  const web = path.join(base, "src", "web");
  const lib = path.join(base, "src", "lib");
  const notes = path.join(base, "src", "notes");
  const before = new Map<string, RepoSnapshot>();

  const alphaRoot = path.join(base, "ws", "alpha");
  const alpha = makeCombo(alphaRoot, [
    worktree(api),
    worktree(web, { kind: "new", name: "dev/eng-218" }),
    worktree(lib, { kind: "existing", name: "release" }),
    reference(notes),
  ]);

  beforeAll(async () => {
    await makeRepo(api);
    await makeRepo(web);
    await makeRepo(lib, { branches: ["release"] });
    mkdirSync(notes, { recursive: true });
    writeFileSync(path.join(notes, "todo.md"), "- ship it\n");
    for (const repo of [api, web, lib]) before.set(repo, await snapshotRepo(repo));
  });

  it("detached + new branch + existing branch + reference: three worktrees, the reference untouched", async () => {
    clearGitLog();
    const outcomes = await ensureWorktrees(alpha);

    expect(outcomes).toMatchObject([
      { target: path.join(alphaRoot, "api"), action: "created", state: "ok" },
      { target: path.join(alphaRoot, "web"), action: "created", state: "ok" },
      { target: path.join(alphaRoot, "lib"), action: "created", state: "ok" },
      { target: notes, action: "not-applicable", state: "reference" },
    ]);
    expect(await git(path.join(alphaRoot, "api"), "branch", "--show-current")).toBe("");
    expect(await git(path.join(alphaRoot, "web"), "branch", "--show-current")).toBe("dev/eng-218");
    expect(await git(path.join(alphaRoot, "lib"), "branch", "--show-current")).toBe("release");
    expect(await git(path.join(alphaRoot, "api"), "rev-parse", "HEAD")).toBe(before.get(api)!.head);

    // what ran is visible both on the outcome and in the log
    expect(gitLog).toEqual([
      ["worktree", "add", "--detach", path.join(alphaRoot, "api"), "HEAD"],
      ["worktree", "add", "-b", "dev/eng-218", path.join(alphaRoot, "web"), "HEAD"],
      ["worktree", "add", path.join(alphaRoot, "lib"), "release"],
    ]);
    expect(outcomes.map((o) => o.git?.args)).toEqual([...gitLog, undefined]);
    expect(outcomes.map((o) => o.git?.exitCode)).toEqual([0, 0, 0, undefined]);

    expect(readdirSync(notes)).toEqual(["todo.md"]);
    expect(readFileSync(path.join(notes, "todo.md"), "utf8")).toBe("- ship it\n");
    // no CLAUDE.md, no workspace file: another module owns those
    expect(readdirSync(alphaRoot).sort()).toEqual(["api", "lib", "web"]);
  });

  it("a second combo wanting the same repo detached coexists with the first", async () => {
    const betaRoot = path.join(base, "ws", "beta");
    const outcomes = await ensureWorktrees(makeCombo(betaRoot, [worktree(api)]));

    expect(outcomes).toMatchObject([{ action: "created", state: "ok" }]);
    for (const dir of [path.join(alphaRoot, "api"), path.join(betaRoot, "api")]) {
      expect(await git(dir, "branch", "--show-current")).toBe("");
      expect(await git(dir, "rev-parse", "HEAD")).toBe(before.get(api)!.head);
    }
    const listed = await git(api, "worktree", "list", "--porcelain");
    expect(listed.match(/^worktree /gm)).toHaveLength(3);
  });

  it("a second combo wanting the same named branch reports a collision, and the folders around it still build", async () => {
    const gammaRoot = path.join(base, "ws", "gamma");
    const gamma = makeCombo(gammaRoot, [
      worktree(api),
      worktree(web, { kind: "new", name: "dev/eng-218" }),
      worktree(lib, { kind: "existing", name: "release" }),
      worktree(web, { kind: "detach" }, "web-detached"),
    ]);
    clearGitLog();
    const outcomes = await ensureWorktrees(gamma);

    expect(outcomes).toMatchObject([
      { action: "created", state: "ok" },
      { action: "collision", state: "absent", heldBy: path.join(alphaRoot, "web") },
      { action: "collision", state: "absent", heldBy: path.join(alphaRoot, "lib") },
      { action: "created", state: "ok", target: path.join(gammaRoot, "web-detached") },
    ]);
    expect(outcomes[1]!.message).toContain("dev/eng-218");
    expect(outcomes[1]!.git).toBeUndefined();
    // git was never asked to add the two that collide
    expect(adds().map((args) => args.at(-2))).toEqual([
      path.join(gammaRoot, "api"),
      path.join(gammaRoot, "web-detached"),
    ]);
    expect(readdirSync(gammaRoot).sort()).toEqual(["api", "web-detached"]);
    // and the holder is unharmed
    expect(await git(path.join(alphaRoot, "web"), "branch", "--show-current")).toBe("dev/eng-218");
  });

  it("running it again: every worktree `exists` and git is not asked to change anything", async () => {
    clearGitLog();
    const outcomes = await ensureWorktrees(alpha);

    expect(outcomes.map((o) => [o.action, o.state])).toEqual([
      ["exists", "ok"],
      ["exists", "ok"],
      ["exists", "ok"],
      ["not-applicable", "reference"],
    ]);
    expect(adds()).toEqual([]);
    expect(gitLog).toEqual([]);
    expect(outcomes.every((o) => o.git === undefined)).toBe(true);
  });

  it("`as` overrides the directory name under the root", async () => {
    const deltaRoot = path.join(base, "ws", "delta");
    const delta = makeCombo(deltaRoot, [worktree(api, { kind: "detach" }, "api-copy")]);
    const outcomes = await ensureWorktrees(delta);

    expect(outcomes).toMatchObject([
      { target: path.join(deltaRoot, "api-copy"), action: "created", state: "ok" },
    ]);
    expect(readdirSync(deltaRoot)).toEqual(["api-copy"]);
    expect(await git(path.join(deltaRoot, "api-copy"), "rev-parse", "--show-toplevel")).toBe(
      path.join(deltaRoot, "api-copy"),
    );
  });

  it("a new branch starts from its base, not from wherever the origin happens to be", async () => {
    const repo = path.join(base, "src", "svc");
    await makeRepo(repo, { branches: ["release"] });
    writeFileSync(path.join(repo, "later.txt"), "after the release\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "later");

    const root = path.join(base, "ws", "based");
    const outcomes = await ensureWorktrees(
      makeCombo(root, [worktree(repo, { kind: "new", name: "hotfix", base: "release" })]),
    );

    expect(outcomes).toMatchObject([{ action: "created", state: "ok" }]);
    expect(outcomes[0]!.git!.args).toEqual([
      "worktree",
      "add",
      "-b",
      "hotfix",
      path.join(root, "svc"),
      "release",
    ]);
    const head = await git(path.join(root, "svc"), "rev-parse", "HEAD");
    expect(head).toBe(await git(repo, "rev-parse", "release"));
    expect(head).not.toBe(await git(repo, "rev-parse", "main"));
    expect(existsSync(path.join(root, "svc", "later.txt"))).toBe(false);
  });

  it("an existing branch that only lives on a remote is created from it", async () => {
    const clone = path.join(base, "src", "lib-clone");
    await git(base, "clone", "-q", lib, clone);
    expect(await git(clone, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe(
      "main",
    );

    const root = path.join(base, "ws", "remote");
    const outcomes = await ensureWorktrees(
      makeCombo(root, [worktree(clone, { kind: "existing", name: "release" })]),
    );
    expect(outcomes).toMatchObject([{ action: "created", state: "ok" }]);
    expect(await git(path.join(root, "lib-clone"), "branch", "--show-current")).toBe("release");
  });

  it("an existing branch that is nowhere fails with git's words, and the next folder still builds", async () => {
    const root = path.join(base, "ws", "nowhere");
    const outcomes = await ensureWorktrees(
      makeCombo(root, [
        worktree(lib, { kind: "existing", name: "never-made" }),
        worktree(web, { kind: "detach" }),
      ]),
    );
    expect(outcomes).toMatchObject([
      { action: "failed", state: "absent" },
      { action: "created", state: "ok" },
    ]);
    expect(outcomes[0]!.message).toContain("never-made");
    expect(outcomes[0]!.git).toMatchObject({ exitCode: 128 });
    expect(outcomes[0]!.git!.args.slice(0, 2)).toEqual(["worktree", "add"]);
    expect(existsSync(path.join(root, "lib"))).toBe(false);
  });

  it("a bad branch name is refused before git is asked to change anything", async () => {
    const root = path.join(base, "ws", "bad-names");
    clearGitLog();
    const outcomes = await ensureWorktrees(
      makeCombo(root, [
        worktree(api, { kind: "new", name: "a..b" }, "one"),
        worktree(api, { kind: "new", name: "-x" }, "two"),
        worktree(api, { kind: "existing", name: "--force" }, "three"),
        worktree(api, { kind: "new", name: "fine", base: "--orphan" }, "four"),
        worktree(api, { kind: "new", name: "@" }, "five"),
      ]),
    );
    expect(outcomes.map((o) => [o.action, o.state])).toEqual(
      Array.from({ length: 5 }, () => ["invalid-branch", "absent"]),
    );
    expect(outcomes.every((o) => typeof o.message === "string" && o.message.length > 0)).toBe(true);
    expect(gitLog).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it("two folders of one combo wanting the same new branch: the first gets it, the second collides", async () => {
    const root = path.join(base, "ws", "twice");
    const outcomes = await ensureWorktrees(
      makeCombo(root, [
        worktree(web, { kind: "new", name: "dev/twice" }, "first"),
        worktree(web, { kind: "new", name: "dev/twice" }, "second"),
      ]),
    );
    expect(outcomes).toMatchObject([
      { action: "created", state: "ok" },
      { action: "collision", state: "absent", heldBy: path.join(root, "first") },
    ]);
    expect(readdirSync(root)).toEqual(["first"]);
  });

  it("two combos racing for one new branch on a shared origin: one creates it, the other sees the holder", async () => {
    const roots = ["left", "right"].map((name) => path.join(base, "ws", name));
    const results = await Promise.all(
      roots.map((root) =>
        ensureWorktrees(
          makeCombo(root, [
            worktree(api, { kind: "detach" }, "loose"),
            worktree(api, { kind: "new", name: "vv/race" }, "named"),
            worktree(api, { kind: "detach" }, "looser"),
          ]),
        ),
      ),
    );
    // mutations on one repository are serialized, and the look that decides is taken under the
    // lock. unserialized, both would run `worktree add -b` and the loser would be a bare `failed`.
    const named = results.map((outcomes) => outcomes[1]!);
    const winner = named.find((o) => o.action === "created");
    const loser = named.find((o) => o.action === "collision");
    expect(winner).toMatchObject({ state: "ok" });
    expect(loser).toMatchObject({ state: "absent", heldBy: winner!.target });
    expect(loser!.git).toBeUndefined();
    for (const outcomes of results) {
      expect([outcomes[0]!.action, outcomes[2]!.action]).toEqual(["created", "created"]);
    }
    expect(await git(winner!.target, "branch", "--show-current")).toBe("vv/race");
    expect(existsSync(loser!.target)).toBe(false);
  });

  it("a configured gitPath is the binary every command goes through", async () => {
    const real = await resolveGitBinary();
    const wrapper = path.join(base, "wrapped", "git");
    const calls = path.join(base, "wrapped", "calls.log");
    mkdirSync(path.dirname(wrapper));
    writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> "${calls}"\nexec "${real}" "$@"\n`);
    chmodSync(wrapper, 0o755);

    const combo = makeCombo(path.join(base, "ws", "wrapped"), [worktree(api)]);
    const opts = { gitPath: wrapper };
    expect(await ensureWorktrees(combo, opts)).toMatchObject([{ action: "created" }]);
    expect(await reconcileCombo(combo, { ...opts, dirty: true })).toMatchObject([{ dirty: false }]);
    expect(await teardownCombo(combo, opts)).toMatchObject([{ action: "removed" }]);

    const seen = readFileSync(calls, "utf8");
    for (const command of [
      "rev-parse --path-format=absolute --git-common-dir --show-toplevel",
      "worktree list --porcelain -z",
      "worktree add --detach",
      "status --porcelain=v1 -z",
      "worktree remove",
    ]) {
      expect(seen).toContain(command);
    }
    // every run carries the hygiene prefix
    for (const line of seen.trim().split("\n").slice(1)) {
      expect(line).toMatch(
        /^--no-pager -c core\.quotepath=off -c advice\.detachedHead=false -C \//,
      );
    }
  });

  it("onOutcome hears every folder in order, and a listener that throws stops nothing", async () => {
    const root = path.join(base, "ws", "listener");
    const heard: FolderOutcome[] = [];
    const outcomes = await ensureWorktrees(
      makeCombo(root, [
        worktree(api),
        reference(notes),
        worktree(web, { kind: "detach" }, "web-two"),
      ]),
      {
        onOutcome: (o) => {
          heard.push(o);
          throw new Error("listener bug");
        },
      },
    );
    expect(heard).toEqual(outcomes);
    expect(outcomes.map((o) => o.action)).toEqual(["created", "not-applicable", "created"]);
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
    expect((await snapshotRepo(web)).branches).toEqual(
      expect.arrayContaining(["refs/heads/dev/eng-218", "refs/heads/dev/twice"]),
    );
  });
});
