import { stat } from "node:fs/promises";
import path from "node:path";
import { expandHome, realpathLoose, samePath } from "../paths.ts";
import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import { gitMessage, outputLines, runGit } from "./exec.ts";
import { parseWorktreeList, shortBranch, type WorktreeEntry } from "./porcelain.ts";

export interface PathInfo {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  isToplevel: boolean;
  toplevel?: string;
  commonDir?: string;
  currentBranch?: string;
  head?: string;
  branches: Array<{ name: string; checkedOutAt?: string }>;
  allowedModes: Array<"worktree" | "reference">;
  suggestedDirName: string;
}

const UNBORN = /^0+$/;

export async function listWorktrees(
  dir: string,
  opts: { gitPath?: string } = {},
): Promise<Result<WorktreeEntry[]>> {
  const run = { cwd: dir, gitPath: opts.gitPath };
  let list = await runGit(["worktree", "list", "--porcelain", "-z"], run);
  // -z arrived in git 2.36. 129 is the usage error an older git answers with.
  if (!list.ok && list.exitCode === 129) {
    list = await runGit(["worktree", "list", "--porcelain"], run);
  }
  if (!list.ok) return err("git-failed", gitMessage(list));
  return ok(parseWorktreeList(list.stdout));
}

/**
 * what a folder picker needs before it offers "worktree" next to "reference". only a repository
 * toplevel qualifies: a worktree made from a subdirectory is still the whole repo, which is not
 * what was picked. never throws, a path that is missing or not a directory allows no mode at all.
 */
export async function classifyPath(p: string, opts: { gitPath?: string } = {}): Promise<PathInfo> {
  const abs = path.resolve(expandHome(p));
  const info: PathInfo = {
    path: abs,
    exists: false,
    isDirectory: false,
    isGitRepo: false,
    isToplevel: false,
    branches: [],
    allowedModes: [],
    suggestedDirName: path.basename(abs) || "folder",
  };
  try {
    info.isDirectory = (await stat(abs)).isDirectory();
    info.exists = true;
  } catch {
    return info;
  }
  if (!info.isDirectory) return info;
  info.allowedModes = ["reference"];

  const run = { cwd: abs, gitPath: opts.gitPath };
  const identity = await runGit(
    ["rev-parse", "--is-bare-repository", "--path-format=absolute", "--git-common-dir"],
    run,
  );
  if (!identity.ok) return info;
  const [bare, commonDir] = outputLines(identity.stdout);
  info.isGitRepo = true;
  if (commonDir) info.commonDir = commonDir;

  // fails in a bare repo and inside a .git directory. both stay reference-only.
  const top = bare === "true" ? undefined : await runGit(["rev-parse", "--show-toplevel"], run);
  const toplevel = top?.ok ? outputLines(top.stdout)[0] : undefined;
  if (toplevel) {
    info.toplevel = toplevel;
    info.isToplevel = samePath(toplevel, abs);
    if (info.isToplevel) info.allowedModes = ["reference", "worktree"];
  }

  const listed = await listWorktrees(abs, opts);
  const entries = listed.ok ? listed.value : [];
  const here = toplevel ? realpathLoose(toplevel) : undefined;
  const current = entries.find((e) => !e.bare && realpathLoose(e.path) === here);
  if (current?.branch) info.currentBranch = shortBranch(current.branch);
  if (current?.head && !UNBORN.test(current.head)) info.head = current.head;

  // the full refname on purpose: %(refname:short) answers "heads/x" when a tag is also named x
  const refs = await runGit(["for-each-ref", "--format=%(refname)", "refs/heads"], run);
  if (refs.ok) {
    info.branches = outputLines(refs.stdout).map((ref) => {
      const holder = entries.find((e) => e.branch === ref);
      const name = shortBranch(ref);
      return holder ? { name, checkedOutAt: holder.path } : { name };
    });
  }
  return info;
}
