import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runGit } from "../../src/git/exec.ts";
import type { Combo, ComboFolder } from "../../src/types.ts";

// the machine's own git config must not leak into a test. set on process.env so that every
// runGit call inherits them, the ones inside the code under test included.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

/** for setup and assertions. throws on failure, unlike runGit. leading whitespace is kept for `status`. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(args, { cwd });
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trimEnd();
}

/** `git init -b main` because init.defaultBranch is unset here, one commit, optional extra branches */
export async function makeRepo(dir: string, opts: { branches?: string[] } = {}): Promise<string> {
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Test User");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), `# ${path.basename(dir)}\n`);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  for (const branch of opts.branches ?? []) await git(dir, "branch", branch);
  return dir;
}

export interface RepoSnapshot {
  head: string;
  branch: string;
  branches: string[];
  status: string;
}

export async function snapshotRepo(dir: string): Promise<RepoSnapshot> {
  return {
    head: await git(dir, "rev-parse", "HEAD"),
    branch: await git(dir, "branch", "--show-current"),
    branches: (await git(dir, "for-each-ref", "--format=%(refname)", "refs/heads")).split("\n"),
    status: await git(dir, "status", "--porcelain"),
  };
}

export const worktree = (
  origin: string,
  branch: ComboFolder["branch"] = { kind: "detach" },
  as?: string,
): ComboFolder => ({ path: origin, mode: "worktree", branch, ...(as ? { as } : {}) });

export const reference = (dir: string): ComboFolder => ({ path: dir, mode: "reference" });

export const makeCombo = (root: string, folders: ComboFolder[]): Combo => ({
  name: path.basename(root),
  root,
  folders,
});
