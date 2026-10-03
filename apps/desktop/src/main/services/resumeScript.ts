// the .command file Terminal runs for a claude command. pure: the caller does the fs work.
import { stat } from "node:fs/promises";
import path from "node:path";
import { isValidSessionId, shellQuote } from "@grove/core/pure";

export const RESUME_SCRIPT_MAX_AGE_MS = 24 * 60 * 60_000;

export function resumeScriptPath(stateDir: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  return path.join(stateDir, "run", `resume-${sessionId}.command`);
}

/**
 * a .command for a claude command in a folder, when it has to happen where a person can answer
 * (the CLI's one-time trust prompt). every argument is quoted: a prompt is typed text. a folder
 * that is gone stops it, rather than dispatching from somewhere else.
 */
export function claudeScriptBody(o: {
  cwd: string;
  claudeBin: string;
  args: readonly string[];
}): string {
  const bin = o.claudeBin === "claude" ? "claude" : shellQuote(o.claudeBin);
  return `#!/bin/zsh\ncd ${shellQuote(o.cwd)} || exit 1\nexec ${[bin, ...o.args.map(shellQuote)].join(" ")}\n`;
}

/** only our own files are ever swept out of the run dir */
export function isResumeScriptName(name: string): boolean {
  return /^resume-[0-9a-fA-F-]{36}\.command$/.test(name);
}

/**
 * where claude usually lives, most specific first. Terminal runs a .command file without the
 * person's interactive shell setup, so a bare `claude` is the last resort, not the default.
 */
export function claudeBinCandidates(home: string, configured?: string): string[] {
  return [
    ...(configured ? [configured] : []),
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

/**
 * the first candidate that is a file, else a bare `claude` and the PATH's luck. Terminal runs a
 * .command file without the person's shell setup, and a GUI app has no shell env at all.
 */
export async function resolveClaudeBin(home: string, configured?: string): Promise<string> {
  for (const candidate of claudeBinCandidates(home, configured)) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // not there
    }
  }
  return "claude";
}

/**
 * the short id `claude --bg` prints and `claude agents --json` lists (8 hex so far). it comes out
 * of another program's output, so it is held to a plain token before anything runs it.
 */
export function isValidShortId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}
