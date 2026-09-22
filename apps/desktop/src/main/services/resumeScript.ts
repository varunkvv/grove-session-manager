// the .command file Terminal runs for "Resume in Terminal". pure: the caller does the fs work.
import { stat } from "node:fs/promises";
import path from "node:path";
import { isValidSessionId, shellQuote } from "@grove/core/pure";

export const RESUME_SCRIPT_MAX_AGE_MS = 24 * 60 * 60_000;

export function resumeScriptPath(stateDir: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  return path.join(stateDir, "run", `resume-${sessionId}.command`);
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
 * the cwd and the id both come out of a transcript, which is untrusted text. the id is checked
 * against the uuid shape, everything else goes through single quotes.
 */
export function resumeScriptBody(o: {
  sessionId: string;
  cwd?: string;
  claudeBin: string;
}): string {
  if (!isValidSessionId(o.sessionId)) throw new Error(`not a session id: ${o.sessionId}`);
  const cd = o.cwd ? `cd ${shellQuote(o.cwd)} 2>/dev/null || cd ~` : "cd ~";
  const bin = o.claudeBin === "claude" ? "claude" : shellQuote(o.claudeBin);
  return `#!/bin/zsh\n${cd}\nexec ${bin} --resume ${o.sessionId}\n`;
}
