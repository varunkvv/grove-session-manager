import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { targetDirFor } from "../combos/schema.ts";
import { mapLimit } from "../fsx.ts";
import { pathRelation, realpathLoose, samePath } from "../paths.ts";
import type {
  BranchSpec,
  Combo,
  ComboFolder,
  CreateAction,
  FolderOutcome,
  FolderState,
  FolderStatus,
  TeardownAction,
  TeardownOutcome,
} from "../types.ts";
import { validateBranchName } from "./branch.ts";
import { type GitRunResult, gitMessage, outputLines, runGit, toTrace } from "./exec.ts";
import { listWorktrees } from "./inspect.ts";
import { shortBranch, type WorktreeEntry } from "./porcelain.ts";

export interface GitOptions {
  gitPath?: string;
}

export interface ReconcileOptions extends GitOptions {
  /** one `git status` per healthy worktree. off by default, it is the slow part on a big repo. */
  dirty?: boolean;
}

export interface EnsureOptions extends GitOptions {
  repairStale?: boolean;
  onOutcome?: (outcome: FolderOutcome) => void;
}

export interface TeardownOptions extends GitOptions {
  onOutcome?: (outcome: TeardownOutcome) => void;
}

const ADD_TIMEOUT_MS = 600_000;
const REMOVE_TIMEOUT_MS = 120_000;
const PARALLEL = 4;
const MAX_DIRTY_PATHS = 10;
const GIT_LOG_CAP = 500;
const MAX_GIT_FILE_BYTES = 64 * 1024;

/** test hook: the args of every mutating git command (`worktree add|remove|prune`), oldest first */
export const gitLog: string[][] = [];

export function clearGitLog(): void {
  gitLog.length = 0;
}

interface RunIn {
  cwd: string;
  gitPath?: string;
}

function mutate(args: string[], run: RunIn, timeoutMs: number): Promise<GitRunResult> {
  gitLog.push([...args]);
  if (gitLog.length > GIT_LOG_CAP) gitLog.splice(0, gitLog.length - GIT_LOG_CAP);
  return runGit(args, { ...run, timeoutMs });
}

const queues = new Map<string, Promise<void>>();

/**
 * one mutation at a time per repository, keyed on the common dir because two combos can share an
 * origin. the look that decides (is the branch held, does it exist) runs under the same lock as
 * the add it leads to, otherwise two runs both see a free branch and one of them just fails.
 */
async function withRepoLock<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
  const before = queues.get(commonDir) ?? Promise.resolve();
  const run = before.then(fn);
  const settled = run.then(
    () => {},
    () => {},
  );
  queues.set(commonDir, settled);
  try {
    return await run;
  } finally {
    if (queues.get(commonDir) === settled) queues.delete(commonDir);
  }
}

function report<T>(callback: ((outcome: T) => void) | undefined, outcome: T): void {
  try {
    callback?.(outcome);
  } catch {
    // a broken listener must not stop the rest of the combo
  }
}

interface Origin {
  /** realpath'd. doubles as the mutex key. */
  commonDir: string;
  entries: WorktreeEntry[];
  /** realpath -> entry. git printed realpaths when it registered them, a stale one no longer resolves. */
  byPath: Map<string, WorktreeEntry>;
}

type OriginLookup = { origin: Origin } | { problem: string };

interface Looked {
  status: FolderStatus;
  /** missing for a reference and for `missing-origin`, there for every state git could act on */
  origin?: Origin;
}

async function queryOrigin(dir: string, gitPath?: string): Promise<OriginLookup> {
  try {
    if (!(await stat(dir)).isDirectory()) {
      return { problem: `the origin is not a directory: ${dir}` };
    }
  } catch {
    return { problem: `the origin does not exist: ${dir}` };
  }
  const identity = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
    { cwd: dir, gitPath },
  );
  const [commonDir, toplevel] = identity.ok ? outputLines(identity.stdout) : [];
  if (!commonDir || !toplevel) return { problem: `the origin is not a git work tree: ${dir}` };
  const listed = await listWorktrees(dir, { gitPath });
  if (!listed.ok) {
    return { problem: `cannot list the worktrees of ${dir}: ${listed.error.message}` };
  }
  const entries = listed.value;
  return {
    origin: {
      commonDir: realpathLoose(commonDir),
      entries,
      byPath: new Map(entries.map((e) => [realpathLoose(e.path), e])),
    },
  };
}

/** nothing a person would miss: empty, or only the .DS_Store Finder leaves in every folder it shows */
async function isDisposableDir(dir: string): Promise<boolean> {
  try {
    const names = await readdir(dir);
    if (names.length === 0) return true;
    if (names.length > 1 || names[0] !== ".DS_Store") return false;
    return (await lstat(path.join(dir, ".DS_Store"))).isFile();
  } catch {
    return false;
  }
}

/** where the `.git` FILE of a linked worktree points. relative since git 2.48 when asked to. */
async function linkedGitDir(target: string): Promise<string | undefined> {
  try {
    const text = await readFile(path.join(target, ".git"), "utf8");
    const gitdir = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1];
    return gitdir ? path.resolve(target, gitdir) : undefined;
  } catch {
    return undefined;
  }
}

/** the last component stays unresolved, so a symlink AT the target is reported as a symlink */
function escapesRoot(target: string, root: string): boolean {
  const abs = path.resolve(target);
  const real = path.join(realpathLoose(path.dirname(abs)), path.basename(abs));
  const rel = path.relative(realpathLoose(root), real);
  return rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

async function classifyTarget(
  combo: Combo,
  folder: ComboFolder,
  origin: Origin,
  opts: ReconcileOptions,
): Promise<FolderStatus> {
  const target = targetDirFor(combo, folder);
  const at = (state: FolderState, message: string): FolderStatus => ({
    folder,
    target,
    state,
    message,
  });

  // `as` comes from a file people edit by hand. "../x" must never reach a git command.
  if (escapesRoot(target, combo.root)) return at("foreign", "the target is outside the combo root");

  const entry = origin.byPath.get(realpathLoose(target));
  const vacant = (): FolderStatus => {
    if (!entry) return at("absent", "not created yet");
    const status = at("stale", "the worktree directory is gone but git still lists it");
    return entry.locked ? { ...status, locked: true } : status;
  };

  let found: Stats;
  try {
    found = await lstat(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return vacant();
    return at("foreign", `cannot look at the target (${code})`);
  }
  if (found.isSymbolicLink()) return at("foreign", "a symlink is in the way");
  if (!found.isDirectory()) return at("foreign", "a file is in the way");

  const dotGit = await lstat(path.join(target, ".git")).catch(() => undefined);
  if (!dotGit) {
    if (await isDisposableDir(target)) return vacant();
    return at("foreign", "a directory with other content is in the way");
  }
  if (dotGit.isDirectory()) return at("foreign", "a separate clone is in the way");
  const gitDir =
    dotGit.isFile() && dotGit.size <= MAX_GIT_FILE_BYTES ? await linkedGitDir(target) : undefined;
  if (!gitDir || pathRelation(gitDir, path.join(origin.commonDir, "worktrees")) !== "inside") {
    return at("foreign", "a worktree of another repository is in the way");
  }
  if (!entry || entry.prunable) {
    return at("foreign", "a worktree the origin does not list at this path is in the way");
  }

  const status: FolderStatus = { folder, target, state: "ok", detached: entry.detached };
  if (entry.branch) status.branch = shortBranch(entry.branch);
  if (entry.head) status.head = entry.head;
  status.locked = entry.locked;
  if (opts.dirty) {
    const changes = await runGit(["status", "--porcelain=v1", "-z"], {
      cwd: target,
      gitPath: opts.gitPath,
    });
    if (changes.ok) status.dirty = changes.stdout.length > 0;
  }
  return status;
}

async function lookAtFolder(
  combo: Combo,
  folder: ComboFolder,
  known: OriginLookup | undefined,
  opts: ReconcileOptions,
): Promise<Looked> {
  const target = targetDirFor(combo, folder);
  if (folder.mode === "reference") {
    const there = await stat(target).then(
      () => true,
      () => false,
    );
    if (there) return { status: { folder, target, state: "reference" } };
    const message = `the reference path does not exist: ${target}`;
    return { status: { folder, target, state: "missing-origin", message } };
  }
  const lookup = known ?? (await queryOrigin(folder.path, opts.gitPath));
  if ("problem" in lookup) {
    return { status: { folder, target, state: "missing-origin", message: lookup.problem } };
  }
  return {
    status: await classifyTarget(combo, folder, lookup.origin, opts),
    origin: lookup.origin,
  };
}

async function look(combo: Combo, opts: ReconcileOptions): Promise<Looked[]> {
  const dirs = [...new Set(combo.folders.filter((f) => f.mode === "worktree").map((f) => f.path))];
  const lookups = await mapLimit(dirs, PARALLEL, (dir) => queryOrigin(dir, opts.gitPath));
  const byDir = new Map(dirs.map((dir, i) => [dir, lookups[i]!]));
  return mapLimit(combo.folders, PARALLEL, (folder) =>
    lookAtFolder(combo, folder, byDir.get(folder.path), opts),
  );
}

/** read-only. one status per folder, in combo.folders order. each distinct origin is asked once. */
export async function reconcileCombo(
  combo: Combo,
  opts: ReconcileOptions = {},
): Promise<FolderStatus[]> {
  return (await look(combo, opts)).map((l) => l.status);
}

/** the states nothing is done about. null means the folder is ours to create. */
function settle(status: FolderStatus, repairStale: boolean): FolderOutcome | null {
  const { folder, target, state, message } = status;
  const say = (action: CreateAction): FolderOutcome => ({
    folder,
    target,
    action,
    state,
    ...(message ? { message } : {}),
  });
  if (folder.mode === "reference") return say("not-applicable");
  if (state === "ok") return { folder, target, action: "exists", state };
  if (state === "foreign") return say("refused-foreign");
  if (state === "missing-origin") return say("missing-origin");
  if (state === "stale" && !repairStale) return say("stale");
  return null;
}

type Plan =
  | { args: string[]; action: "created" | "attached" }
  | { refused: "invalid-branch" | "collision"; message: string; heldBy?: string };

async function planAdd(
  spec: BranchSpec,
  dest: string,
  origin: Origin,
  pruning: boolean,
  run: RunIn,
): Promise<Plan> {
  if (spec.kind === "detach") {
    return { args: ["worktree", "add", "--detach", dest, "HEAD"], action: "created" };
  }
  // an existing name is checked too: "-f" as a branch would be read as an option
  let problem = validateBranchName(spec.name);
  if (!problem && spec.kind === "new") {
    const verdict = await runGit(["check-ref-format", "--branch", spec.name], run);
    // no exit code means git never ran. that is for the add itself to report.
    if (!verdict.ok && verdict.exitCode !== null) problem = gitMessage(verdict);
  }
  if (!problem && spec.kind === "new" && spec.base?.startsWith("-")) {
    problem = 'a base cannot start with "-"';
  }
  if (problem) return { refused: "invalid-branch", message: problem };

  const ref = `refs/heads/${spec.name}`;
  const realDest = realpathLoose(dest);
  // not a holder: our own dead entry, and during a repair every entry the prune is about to drop.
  // outside a repair a dead entry does count, git refuses the branch until it is pruned.
  const holder = origin.entries.find(
    (e) => e.branch === ref && realpathLoose(e.path) !== realDest && !(pruning && e.prunable),
  );
  if (holder) {
    const message = `branch ${spec.name} is already checked out at ${holder.path}`;
    return { refused: "collision", message, heldBy: holder.path };
  }
  if (spec.kind === "existing") {
    // when the local branch is missing git may still create it from a remote of the same name
    return { args: ["worktree", "add", dest, spec.name], action: "created" };
  }
  // create-or-attach: we never delete branches, so after a teardown or a prune the name is
  // still there and a bare `-b` would fail
  const exists = (await runGit(["show-ref", "--verify", "--quiet", ref], run)).ok;
  return exists
    ? { args: ["worktree", "add", dest, spec.name], action: "attached" }
    : { args: ["worktree", "add", "-b", spec.name, dest, spec.base || "HEAD"], action: "created" };
}

/** false when something is there that we will not delete. a symlink is never followed. */
async function clearDisposableDir(dir: string): Promise<boolean> {
  try {
    if (!(await lstat(dir)).isDirectory()) return false;
  } catch {
    return true;
  }
  // git refuses a directory that holds anything, a .DS_Store included
  await unlink(path.join(dir, ".DS_Store")).catch(() => {});
  try {
    await rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

async function createWorktree(
  combo: Combo,
  status: FolderStatus,
  origin: Origin,
  opts: EnsureOptions,
): Promise<FolderOutcome> {
  const { folder, target } = status;
  const wasStale = status.state === "stale";
  const dest = path.resolve(target);
  const stateNow = async () => (await lookAtFolder(combo, folder, undefined, opts)).status.state;
  const failed = async (result: GitRunResult): Promise<FolderOutcome> => ({
    folder,
    target,
    action: "failed",
    state: await stateNow(),
    message: gitMessage(result),
    git: toTrace(result),
  });

  const run: RunIn = { cwd: folder.path, gitPath: opts.gitPath };
  const plan = await planAdd(folder.branch ?? { kind: "detach" }, dest, origin, wasStale, run);
  if ("refused" in plan) {
    const { refused: action, message, heldBy } = plan;
    return { folder, target, action, state: status.state, message, ...(heldBy ? { heldBy } : {}) };
  }

  if (wasStale) {
    const pruned = await mutate(["worktree", "prune"], run, REMOVE_TIMEOUT_MS);
    if (!pruned.ok) return failed(pruned);
  }
  try {
    await mkdir(combo.root, { recursive: true });
  } catch (e) {
    const message = `cannot create the combo root: ${(e as Error).message}`;
    return { folder, target, action: "failed", state: await stateNow(), message };
  }
  if (!(await clearDisposableDir(dest))) {
    const message = "the target filled up while we were looking, it is left alone";
    return { folder, target, action: "refused-foreign", state: "foreign", message };
  }

  const added = await mutate(plan.args, run, ADD_TIMEOUT_MS);
  if (added.ok) {
    const action = wasStale ? "recreated" : plan.action;
    return { folder, target, action, state: "ok", git: toTrace(added) };
  }
  // the list cannot see a branch that is mid-rebase or mid-bisect in another worktree. git can.
  const heldBy = /is already (?:used by worktree|checked out) at '(.+)'/.exec(added.stderr)?.[1];
  if (heldBy) {
    const outcome = await failed(added);
    return { ...outcome, action: "collision", heldBy };
  }
  return failed(added);
}

async function ensureFolder(
  combo: Combo,
  looked: Looked,
  opts: EnsureOptions,
): Promise<FolderOutcome> {
  const repair = opts.repairStale === true;
  const done = settle(looked.status, repair);
  if (done) return done;
  // absent and stale always come with an origin
  return withRepoLock(looked.origin!.commonDir, async () => {
    // look again under the lock: an earlier folder of this combo, or another combo on the same
    // origin, may have taken the branch or the directory since the first look
    const fresh = await lookAtFolder(combo, looked.status.folder, undefined, opts);
    return settle(fresh.status, repair) ?? createWorktree(combo, fresh.status, fresh.origin!, opts);
  });
}

/**
 * creates what is `absent`, and with repairStale what is `stale`. everything else is reported and
 * left exactly as it is. a problem in one folder never stops the ones after it.
 */
export async function ensureWorktrees(
  combo: Combo,
  opts: EnsureOptions = {},
): Promise<FolderOutcome[]> {
  const outcomes: FolderOutcome[] = [];
  for (const looked of await look(combo, opts)) {
    let outcome: FolderOutcome;
    try {
      outcome = await ensureFolder(combo, looked, opts);
    } catch (e) {
      const { folder, target, state } = looked.status;
      outcome = { folder, target, action: "failed", state, message: String(e) };
    }
    outcomes.push(outcome);
    report(opts.onOutcome, outcome);
  }
  return outcomes;
}

export function repairCombo(combo: Combo, opts: EnsureOptions = {}): Promise<FolderOutcome[]> {
  return ensureWorktrees(combo, { ...opts, repairStale: true });
}

/** matches the origin path first, then the target, so a repo that is in the combo twice can be told apart */
function findFolder(combo: Combo, folderPath: string): ComboFolder | undefined {
  return (
    combo.folders.find((f) => samePath(f.path, folderPath)) ??
    combo.folders.find((f) => samePath(targetDirFor(combo, f), folderPath))
  );
}

export async function repairFolder(
  combo: Combo,
  folderPath: string,
  opts: EnsureOptions = {},
): Promise<FolderOutcome> {
  const folder = findFolder(combo, folderPath);
  if (folder) {
    const [outcome] = await repairCombo({ ...combo, folders: [folder] }, opts);
    if (outcome) return outcome;
  }
  const outcome: FolderOutcome = {
    folder: folder ?? { path: folderPath, mode: "worktree" },
    target: folderPath,
    action: "failed",
    state: "missing-origin",
    message: `this combo has no folder at ${folderPath}`,
  };
  report(opts.onOutcome, outcome);
  return outcome;
}

async function dirtyPathsOf(dir: string, gitPath?: string): Promise<string[]> {
  const changes = await runGit(["status", "--porcelain=v1", "-z"], { cwd: dir, gitPath });
  if (!changes.ok) return [];
  const tokens = changes.stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length && paths.length < MAX_DIRTY_PATHS; i++) {
    const token = tokens[i]!;
    if (token.length < 4) continue;
    paths.push(token.slice(3));
    // a rename or a copy is followed by the path it came from
    if (/[RC]/.test(token.slice(0, 2))) i++;
  }
  return paths;
}

async function removeFolder(
  combo: Combo,
  looked: Looked,
  opts: TeardownOptions,
  force: boolean,
): Promise<TeardownOutcome> {
  const { folder, target } = looked.status;
  const say = (action: TeardownAction, extra: Partial<TeardownOutcome> = {}): TeardownOutcome => ({
    folder,
    target,
    action,
    ...extra,
  });
  const leave = (status: FolderStatus): TeardownOutcome => {
    // force is for a healthy worktree that git refused. anything else is not ours to delete.
    if (!force) return say("untouched", status.message ? { message: status.message } : {});
    return say("failed", { message: `not force-removing a folder that is ${status.state}` });
  };
  const run: RunIn = { cwd: folder.path, gitPath: opts.gitPath };

  const first = looked.status;
  const actionable = first.state === "ok" || (first.state === "stale" && !force);
  if (!looked.origin || !actionable) return leave(first);

  return withRepoLock(looked.origin.commonDir, async () => {
    const now = (await lookAtFolder(combo, folder, undefined, opts)).status;
    if (now.state === "stale" && !force) {
      const pruned = await mutate(["worktree", "prune"], run, REMOVE_TIMEOUT_MS);
      const git = toTrace(pruned);
      if (!pruned.ok) return say("failed", { message: gitMessage(pruned), git });
      const after = (await lookAtFolder(combo, folder, undefined, opts)).status;
      if (after.state !== "stale") return say("removed", { git });
      // prune never drops a locked entry
      if (after.locked) return say("skipped-locked", { message: "the worktree is locked", git });
      return say("failed", { message: "git still lists the worktree after a prune", git });
    }
    if (now.state !== "ok") return leave(now);

    const dest = path.resolve(target);
    const args = force ? ["worktree", "remove", "--force", dest] : ["worktree", "remove", dest];
    const removed = await mutate(args, run, REMOVE_TIMEOUT_MS);
    const git = toTrace(removed);
    if (removed.ok) return say("removed", { git });
    // from here on we only put a name on git's refusal. nothing else is attempted.
    if (now.locked) return say("skipped-locked", { message: "the worktree is locked", git });
    const dirtyPaths = force ? [] : await dirtyPathsOf(dest, opts.gitPath);
    if (dirtyPaths.length) {
      return say("skipped-dirty", {
        message: "the worktree has uncommitted changes",
        dirtyPaths,
        git,
      });
    }
    return say("failed", { message: gitMessage(removed), git });
  });
}

async function removeSafely(
  combo: Combo,
  looked: Looked,
  opts: TeardownOptions,
  force: boolean,
): Promise<TeardownOutcome> {
  let outcome: TeardownOutcome;
  try {
    outcome = await removeFolder(combo, looked, opts, force);
  } catch (e) {
    const { folder, target } = looked.status;
    outcome = { folder, target, action: "failed", message: String(e) };
  }
  report(opts.onOutcome, outcome);
  return outcome;
}

/**
 * plain `git worktree remove` per healthy worktree, so git itself protects uncommitted work.
 * there is no force here on purpose. branches, the combo root, CLAUDE.md and .claude/ are
 * never touched.
 */
export async function teardownCombo(
  combo: Combo,
  opts: TeardownOptions = {},
): Promise<TeardownOutcome[]> {
  const outcomes: TeardownOutcome[] = [];
  for (const looked of await look(combo, opts)) {
    outcomes.push(await removeSafely(combo, looked, opts, false));
  }
  return outcomes;
}

/** one folder per call, and only one that reconciles as `ok`. `--force` is passed once, so a locked worktree stays. */
export async function forceRemoveWorktree(
  combo: Combo,
  folderPath: string,
  opts: TeardownOptions = {},
): Promise<TeardownOutcome> {
  const folder = findFolder(combo, folderPath);
  if (!folder) {
    const outcome: TeardownOutcome = {
      folder: { path: folderPath, mode: "worktree" },
      target: folderPath,
      action: "failed",
      message: `this combo has no folder at ${folderPath}`,
    };
    report(opts.onOutcome, outcome);
    return outcome;
  }
  return removeSafely(combo, await lookAtFolder(combo, folder, undefined, opts), opts, true);
}
