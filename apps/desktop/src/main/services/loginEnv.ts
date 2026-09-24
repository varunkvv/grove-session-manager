import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { stripLaunchEnv } from "@grove/core";
import { log } from "../log.ts";

/**
 * a background session inherits the environment of whatever dispatched it, for good: its Bash
 * runs with that PATH until it ends. an app opened from Finder has PATH=/usr/bin:/bin:/usr/sbin:/sbin,
 * so a session grove dispatched with it would find no node, pnpm or gh (seen on 2026-09-23). so
 * every claude this feature runs gets the person's login shell environment instead, resolved once
 * per app run.
 */
export const ENV_MARKER = "__GROVE_ENV__";
const TIMEOUT_MS = 5000;

/** what the shell runs. rc files can print anything first, so the dump starts after a marker. */
export function loginShellArgs(): string[] {
  return ["-ilc", `printf '${ENV_MARKER}\\0'; env -0`];
}

/**
 * `env -0` after the marker: NUL-separated `KEY=value`, and a value may hold newlines. null when
 * the marker never came or nothing usable followed it - a PATH is the least a real dump has.
 */
export function parseEnvDump(out: string): Record<string, string> | null {
  const at = out.indexOf(`${ENV_MARKER}\0`);
  if (at < 0) return null;
  const env: Record<string, string> = {};
  for (const entry of out.slice(at + ENV_MARKER.length + 1).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env.PATH ? env : null;
}

/** where claude, node and friends usually are, for when the shell could not say */
export function fallbackPath(home: string, current = ""): string {
  const extra = [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const have = current.split(":").filter(Boolean);
  return [...extra.filter((p) => !have.includes(p)), ...have].join(":");
}

/**
 * the environment a dispatched claude gets. what an Electron parent leaves behind is dropped,
 * along with the shell's own bookkeeping, and Claude Code's config dir is the one grove reads.
 * CLAUDE_CONFIG_DIR is only set when it is not the default. an unset one and one spelled out as
 * ~/.claude are not promised to behave the same (where credentials live, for one), so the
 * everyday case leaves it exactly as the shell had it.
 */
export function finishEnv(
  env: NodeJS.ProcessEnv,
  o: { home: string; claudeConfigDir: string },
): NodeJS.ProcessEnv {
  const out = stripLaunchEnv(env);
  for (const key of ["PWD", "OLDPWD", "SHLVL", "_"]) delete out[key];
  if (path.resolve(o.claudeConfigDir) !== path.join(o.home, ".claude")) {
    out.CLAUDE_CONFIG_DIR = o.claudeConfigDir;
  }
  return out;
}

export type ShellRun = (
  shell: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<string | null>;

/** stdin is closed at once: an rc file that reads it would otherwise hang until the timeout */
const runShell: ShellRun = (shell, args, env, timeoutMs) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        shell,
        [...args],
        { env, timeout: timeoutMs, maxBuffer: 4 << 20, encoding: "utf8", cwd: os.homedir() },
        (error, stdout) => resolve(error ? null : String(stdout)),
      );
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });

export interface LoginEnvOptions {
  home: string;
  /** the environment the app itself got: the fallback, and what the shell starts from */
  base: NodeJS.ProcessEnv;
  /** Claude Code's config dir as grove reads it */
  claudeConfigDir: () => string;
  /** a test root never runs anyone's rc files: it goes straight to the fallback */
  useShell: boolean;
  shell?: string;
  run?: ShellRun;
}

/** the login shell's environment, asked once per app run and kept */
export class LoginEnv {
  private readonly opts: LoginEnvOptions;
  private resolved: Promise<NodeJS.ProcessEnv> | null = null;

  constructor(opts: LoginEnvOptions) {
    this.opts = opts;
  }

  get(): Promise<NodeJS.ProcessEnv> {
    this.resolved ??= this.resolve();
    return this.resolved.then((env) =>
      finishEnv(env, { home: this.opts.home, claudeConfigDir: this.opts.claudeConfigDir() }),
    );
  }

  private async resolve(): Promise<NodeJS.ProcessEnv> {
    const base = stripLaunchEnv(this.opts.base);
    if (this.opts.useShell) {
      const shell = this.opts.shell || safeShell() || "/bin/zsh";
      const out = await (this.opts.run ?? runShell)(shell, loginShellArgs(), base, TIMEOUT_MS);
      const env = out === null ? null : parseEnvDump(out);
      if (env) return env;
      log.warn(`login shell environment from ${shell} unavailable, using the app's own`);
    }
    return { ...base, PATH: fallbackPath(this.opts.home, base.PATH) };
  }
}

function safeShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}
