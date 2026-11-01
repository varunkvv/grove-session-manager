import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderClaudeMdStub } from "../../src/combos/claudeMd.ts";
import { migrateReferences } from "../../src/combos/migrateReferences.ts";
import { combosFilePath, loadCombos } from "../../src/combos/store.ts";
import { ensureWorktrees } from "../../src/git/worktrees.ts";
import { git, makeCombo, makeRepo, worktree } from "../helpers/git.ts";
import { makeSandbox } from "../helpers/transcript.ts";

/** an app root with one combo holding one working copy of a fresh repo, stub written as 0.37 did */
async function setup(opts: { create?: boolean } = {}) {
  const base = makeSandbox("grove-migrate-");
  const app = path.join(base, "app");
  const api = await makeRepo(path.join(base, "src", "api"));
  const root = path.join(app, "task");
  mkdirSync(root, { recursive: true });
  const combo = makeCombo(root, [worktree(api, { kind: "new", name: "feat" })]);
  if (opts.create !== false) await ensureWorktrees(combo);
  const oldStub = renderClaudeMdStub(combo)
    .replace(
      /## Worktrees[\s\S]*?\n\n## Where/,
      [
        "A working copy is a git worktree: a second checkout of the original clone, sharing its `.git`.",
        "",
        "- commits and branches made here show up in the original clone straight away, and the other way round",
        "- it started clean. uncommitted work in the original clone is not here",
        "- a branch can be checked out in one worktree at a time. when `git checkout <branch>` refuses, that is why",
        "- never remove a working copy with `rm -rf` or `git worktree remove`. Grove owns their lifecycle",
        "",
        "## Where",
      ].join("\n"),
    )
    .replace("inside a worktree.", "inside a working copy.");
  writeFileSync(path.join(root, "CLAUDE.md"), oldStub);
  writeFileSync(
    combosFilePath(app),
    JSON.stringify({
      combos: [{ name: "task", root, folders: [combo.folders[0]], colour: "teal" }],
    }),
  );
  return {
    app,
    api,
    root,
    dir: path.join(root, "api"),
    moved: path.join(root, "worktrees", "api"),
  };
}

const load = async (app: string) => (await loadCombos(app)).combos;

describe("migrateReferences", () => {
  it("moves a clean worktree and flips the folder", async () => {
    const s = await setup();
    const head = await git(s.dir, "rev-parse", "HEAD");
    const report = await migrateReferences(s.app, await load(s.app), { apply: true });
    expect(report).toMatchObject({ moved: 1, flipped: 0, kept: 0 });
    expect(existsSync(s.dir)).toBe(false);
    expect(await git(s.moved, "branch", "--show-current")).toBe("feat");
    expect(await git(s.moved, "rev-parse", "HEAD")).toBe(head);
    expect(await git(s.api, "worktree", "list")).toContain(path.join("worktrees", "api"));
    const [combo] = await load(s.app);
    expect(combo?.folders).toEqual([{ path: s.api, mode: "reference" }]);
    expect(JSON.parse(readFileSync(combosFilePath(s.app), "utf8")).combos[0]?.colour).toBe("teal");
  });

  it("moves a dirty worktree with its uncommitted work", async () => {
    const s = await setup();
    writeFileSync(path.join(s.dir, "wip.txt"), "not committed\n");
    writeFileSync(path.join(s.dir, "README.md"), "changed\n");
    await migrateReferences(s.app, await load(s.app), { apply: true });
    expect(readFileSync(path.join(s.moved, "wip.txt"), "utf8")).toBe("not committed\n");
    expect(await git(s.moved, "status", "--porcelain")).toContain("?? wip.txt");
    expect(await git(s.moved, "status", "--porcelain")).toContain(" M README.md");
  });

  it("only flips a folder whose directory is missing", async () => {
    const s = await setup({ create: false });
    const report = await migrateReferences(s.app, await load(s.app), { apply: true });
    expect(report).toMatchObject({ moved: 0, flipped: 1, kept: 0 });
    expect(existsSync(path.join(s.root, "worktrees"))).toBe(false);
    expect((await load(s.app))[0]?.folders[0]?.mode).toBe("reference");
  });

  it("leaves alone a directory git does not list as the repo's worktree", async () => {
    const s = await setup({ create: false });
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(path.join(s.dir, "keep.txt"), "mine\n");
    const report = await migrateReferences(s.app, await load(s.app), { apply: true });
    expect(report).toMatchObject({ moved: 0, flipped: 0, kept: 1 });
    expect(readFileSync(path.join(s.dir, "keep.txt"), "utf8")).toBe("mine\n");
    expect((await load(s.app))[0]?.folders[0]?.mode).toBe("worktree");
  });

  it("leaves a folder as a worktree when git cannot move it", async () => {
    const s = await setup();
    await git(s.api, "worktree", "lock", s.dir);
    const report = await migrateReferences(s.app, await load(s.app), { apply: true });
    expect(report).toMatchObject({ moved: 0, flipped: 0, kept: 1 });
    expect(existsSync(s.dir)).toBe(true);
    expect((await load(s.app))[0]?.folders[0]?.mode).toBe("worktree");
  });

  it("a dry run changes nothing", async () => {
    const s = await setup();
    const before = readFileSync(combosFilePath(s.app), "utf8");
    const stub = readFileSync(path.join(s.root, "CLAUDE.md"), "utf8");
    const report = await migrateReferences(s.app, await load(s.app), { apply: false });
    expect(report).toMatchObject({ applied: false, moved: 1 });
    expect(existsSync(s.dir)).toBe(true);
    expect(existsSync(s.moved)).toBe(false);
    expect(readFileSync(combosFilePath(s.app), "utf8")).toBe(before);
    expect(readFileSync(path.join(s.root, "CLAUDE.md"), "utf8")).toBe(stub);
  });

  it("rewrites the member line and applies the swaps, an edited line stays", async () => {
    const s = await setup();
    await migrateReferences(s.app, await load(s.app), { apply: true });
    const md = readFileSync(path.join(s.root, "CLAUDE.md"), "utf8");
    expect(md).toContain(
      `- \`${s.api}\` - reference. your own clone: read it and make worktrees from it, never edit it directly.`,
    );
    expect(md).not.toContain("working copy. a git worktree of");
    expect(md).toContain("## Worktrees");

    const edited = await setup();
    const file = path.join(edited.root, "CLAUDE.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("- `api/` - working copy.", "- `api/` - mine."),
    );
    const report = await migrateReferences(edited.app, await load(edited.app), { apply: true });
    expect(readFileSync(file, "utf8")).toContain("- `api/` - mine.");
    expect(report.combos[0]?.claudeMd.join()).toContain("left alone");
  });
});
