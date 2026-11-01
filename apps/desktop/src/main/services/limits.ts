import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseUsageUtilization, type UsageLimits } from "@grove/core";
import { log } from "../log.ts";

/** how often the file is looked at. Claude Code writes its cache of the limits at most once a minute */
const EVERY_MS = 60_000;

/**
 * Claude Code's state file, where it picks it: `~/.claude.json` with the default config folder,
 * inside any other one (CLAUDE_CONFIG_DIR). loginEnv sets that variable on the same test
 */
export function claudeStateFile(configDir: string, home: string): string {
  return path.resolve(configDir) === path.join(home, ".claude")
    ? path.join(home, ".claude.json")
    : path.join(configDir, ".claude.json");
}

export interface LimitsOptions {
  file: string;
  /** only when what it says moved */
  onChange: (limits: UsageLimits | null) => void;
}

/**
 * the account's usage limits as Claude Code last fetched them. the file is looked at once a minute
 * and read again only when it changed. grove never writes it, and never asks the API itself
 */
export class LimitsService {
  private limits: UsageLimits | null = null;
  private sent = "null";
  private mtime = -1;
  private looking: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly o: LimitsOptions;

  constructor(o: LimitsOptions) {
    this.o = o;
  }

  current(): UsageLimits | null {
    return this.limits;
  }

  /** one look at a time: a second while one runs gets the first */
  read(): Promise<void> {
    this.looking ??= this.look().finally(() => {
      this.looking = undefined;
    });
    return this.looking;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.read(), EVERY_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async look(): Promise<void> {
    const mtime = await stat(this.o.file).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    if (mtime === this.mtime) return;
    if (mtime === 0) {
      this.mtime = 0;
      return this.set(null);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.o.file, "utf8"));
    } catch {
      // caught mid-write: what was read last stands, and the next look reads it again
      return;
    }
    this.mtime = mtime;
    this.set(parseUsageUtilization(parsed));
  }

  private set(next: UsageLimits | null): void {
    const json = JSON.stringify(next);
    if (json === this.sent) return;
    this.sent = json;
    this.limits = next;
    // a listener that throws must not stop the next look
    try {
      this.o.onChange(next);
    } catch (e) {
      log.warn("usage limits:", e);
    }
  }
}
