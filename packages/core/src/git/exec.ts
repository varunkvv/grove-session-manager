import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { expandHome } from "../paths.ts";
import type { GitTrace } from "../types.ts";

export interface GitRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** the caller's args, without the hygiene prefix every run gets */
  args: string[];
  timedOut: boolean;
}

export interface GitRunOptions {
  cwd: string;
  gitPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * what `git rev-parse --local-env-vars` prints. inherited from a hook or an editor's terminal
 * they point git at some other repository, and `-C` does not win against GIT_DIR.
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM are not on the list and must survive.
 */
const LOCAL_ENV_VARS = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const QUERY_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const APPLE_STUB = "/usr/bin/git";

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !LOCAL_ENV_VARS.has(name)) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  env.GIT_PAGER = "cat";
  // an app launched from Finder gets a minimal PATH, and the git-lfs filters live in homebrew
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of EXTRA_PATH) if (!dirs.includes(dir)) dirs.push(dir);
  env.PATH = dirs.join(path.delimiter);
  return env;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function usable(candidate: string): Promise<boolean> {
  if (!path.isAbsolute(candidate)) return false;
  // asdf/rbenv shims need a version file near the cwd and fail anywhere else
  const real = await realpath(candidate).catch(() => candidate);
  if (candidate.includes("/shims/") || real.includes("/shims/")) return false;
  if (process.platform === "darwin" && candidate === APPLE_STUB) {
    // without the developer tools the stub opens the "install command line tools" dialog
    const tools =
      (await exists("/Library/Developer/CommandLineTools/usr/bin/git")) ||
      (await exists("/Applications/Xcode.app"));
    if (!tools) return false;
  }
  try {
    await access(candidate, constants.X_OK);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    try {
      execFile(
        candidate,
        ["--version"],
        { env: gitEnv(), timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => resolve(!error && String(stdout).startsWith("git version")),
      );
    } catch {
      resolve(false);
    }
  });
}

async function findGit(configured?: string): Promise<string | null> {
  const onPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, "git"));
  const candidates = [
    configured ? expandHome(configured) : undefined,
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    APPLE_STUB,
    ...onPath,
  ];
  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) continue;
    tried.add(candidate);
    if (await usable(candidate)) return candidate;
  }
  return null;
}

const resolved = new Map<string, Promise<string>>();

/** never rejects. with no usable git anywhere it answers "git" and the run itself reports the failure. */
export function resolveGitBinary(configured?: string): Promise<string> {
  const key = configured ?? "";
  let pending = resolved.get(key);
  if (!pending) {
    pending = findGit(configured).then(
      (found) => {
        // a miss is not remembered: git may get installed while the app is open
        if (!found) resolved.delete(key);
        return found ?? "git";
      },
      () => {
        resolved.delete(key);
        return "git";
      },
    );
    resolved.set(key, pending);
  }
  return pending;
}

/** never rejects: a missing binary, a bad cwd, a timeout and a non-zero exit all come back as values */
export async function runGit(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
  const bin = await resolveGitBinary(opts.gitPath);
  const timeoutMs = opts.timeoutMs ?? QUERY_TIMEOUT_MS;
  // no `cwd` for the child on purpose: a missing directory would be a spawn error with no stderr
  const argv = [
    "--no-pager",
    "-c",
    "core.quotepath=off",
    "-c",
    "advice.detachedHead=false",
    "-C",
    opts.cwd,
    ...args,
  ];
  return new Promise((resolve) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const child = execFile(
        bin,
        argv,
        { env: gitEnv(opts.env), maxBuffer: MAX_BUFFER, encoding: "utf8", windowsHide: true },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          // `killed` is only set when our signal landed. a command that finished on its own in
          // the same tick as the timer keeps its real result.
          const late = timedOut && error?.killed === true;
          const exitCode = !error ? 0 : typeof error.code === "number" ? error.code : null;
          let text = stderr;
          if (late) text = `${text}git timed out after ${timeoutMs}ms\n`;
          else if (error && exitCode === null) text = `${text}${error.message}\n`;
          resolve({ ok: !error, exitCode, stdout, stderr: text, args, timedOut: late });
        },
      );
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // a grandchild (an lfs filter, ssh) can hold the pipes open long after git is gone
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, timeoutMs);
      }
    } catch (e) {
      // execFile throws synchronously on a NUL byte in an argument
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout: "", stderr: String(e), args, timedOut: false });
    }
  });
}

export function toTrace(result: GitRunResult): GitTrace {
  return { args: result.args, exitCode: result.exitCode, stderr: result.stderr.trim() };
}

/** git's own words, without the progress line `worktree add` writes to stderr even when it works */
export function gitMessage(result: GitRunResult): string {
  const lines = result.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Preparing worktree"));
  return lines.join(" ") || `git exited with code ${result.exitCode}`;
}

export function outputLines(stdout: string): string[] {
  return stdout.split("\n").filter((l) => l !== "");
}
