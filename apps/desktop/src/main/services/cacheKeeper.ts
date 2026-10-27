// grove chat's cache keeper: claude code writes a session's prompt cache with a 1h ttl, and a turn
// after more than that rewrites the whole context. a throwaway fork that reads the cached prefix a
// little before the hour keeps it, at about 1/40 of the rewrite it saves (plans/2026-10-27-cache-keeper)
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ChatStatus } from "../../shared/ipc.ts";

/** a fork this long after the session's last api activity: before the hour's ttl runs out */
export const KEEP_EVERY_MS = 55 * 60_000;
/** under this much context a rewrite is cheap: not worth a fork */
export const KEEP_MIN_CONTEXT = 20_000;
/** a fork that wrote more than this missed the prefix: that session is not kept again */
export const KEEP_MISS_TOKENS = 20_000;
/** hours after a session's last turn it is kept for, with no setting. past ~3h few come back */
export const KEEP_HOURS_DEFAULT = 3;
/** a fork gets this long to reach its request, then it is closed */
export const KEEP_TIMEOUT_MS = 2 * 60_000;
/** what the fork sends. it is closed as its request starts, so no reply is written */
export const KEEP_PROMPT = ".";

export interface KeepClock {
  /** when the session's last real turn ended. never: grove saw no turn of it */
  lastTurn?: number;
  /** when its last fork read the cache */
  lastWarm?: number;
  running: boolean;
  /** a fork for it is under way */
  warming: boolean;
  /** a fork missed the prefix: it stays cold until a real turn */
  off: boolean;
  /** its context, in tokens */
  context: number;
}

/** whether the session gets a fork now. hours 0 is off */
export function keepDue(k: KeepClock, now: number, hours: number): boolean {
  if (!(hours > 0) || k.lastTurn === undefined) return false;
  if (k.running || k.warming || k.off || k.context < KEEP_MIN_CONTEXT) return false;
  if (now - k.lastTurn >= hours * 3_600_000) return false;
  return now - Math.max(k.lastTurn, k.lastWarm ?? 0) >= KEEP_EVERY_MS;
}

/** the setting as the host reads it: absent is the default, anything not a number of hours is off */
export function keepHours(v: unknown): number {
  if (v === undefined) return KEEP_HOURS_DEFAULT;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * what the fork adds to the options a start builds. it resumes the session as a fork that writes
 * no transcript and runs no hook (grove's status and needs-you hooks among them), and it mirrors
 * what the last turn ran on: a model, effort, style or thinking that differ change the prefix
 * (probe: effort low over xhigh wrote 1.2k). none of this is in the cached prefix itself
 */
export function forkOptions(
  id: string,
  status: Pick<ChatStatus, "model" | "effort" | "style" | "ultracode" | "thinkingOff">,
): Partial<Options> {
  return {
    resume: id,
    forkSession: true,
    persistSession: false,
    maxTurns: 1,
    ...(status.model ? { model: status.model } : {}),
    ...(status.effort ? { effort: status.effort as Options["effort"] } : {}),
    ...(status.thinkingOff ? { thinking: { type: "disabled" as const } } : {}),
    settings: {
      disableAllHooks: true,
      ...(status.style ? { outputStyle: status.style } : {}),
      ...(status.ultracode ? { ultracode: true } : {}),
    } as Options["settings"],
    // no tool ever runs in a fork: it is closed before one could, and this denies one that is
    // reached anyway. an in-process hook still fires under disableAllHooks (probe), and his
    // settings can allow a tool before canUseTool is asked
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async () => ({
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: "a cache keeper fork runs no tools",
              },
            }),
          ],
        },
      ],
    },
    canUseTool: async () => ({ behavior: "deny", message: "a cache keeper fork runs no tools" }),
    onUserDialog: async () => ({ behavior: "cancel" }) as never,
    onElicitation: async () => ({ action: "decline" }),
  };
}

/** what a fork's frames say, as the keeper reads them */
export interface ForkRead {
  /** the fork's own session id, from its init */
  fork?: string;
  /** its request's usage, once there is one */
  usage?: { read: number; write: number };
}

/**
 * one frame of a fork. a resumed fork first replays what the session had pending (a background
 * task's end) as a turn of its own with no request (probe: origin task-notification, all zeros):
 * that is passed over. true: the request has started and the fork can go
 */
export function readFork(r: ForkRead, m: unknown): boolean {
  const f = m as {
    type?: string;
    subtype?: string;
    session_id?: string;
    origin?: { kind?: string };
    event?: { type?: string; message?: { usage?: Record<string, unknown> } };
    usage?: Record<string, unknown>;
  };
  if (f.type === "system" && f.subtype === "init" && f.session_id) r.fork = f.session_id;
  const usage =
    f.type === "stream_event" && f.event?.type === "message_start"
      ? f.event.message?.usage
      : f.type === "result" && f.origin?.kind !== "task-notification"
        ? f.usage
        : undefined;
  if (!usage) return f.type === "result" && f.origin?.kind !== "task-notification";
  const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  const read = n("cache_read_input_tokens");
  const write = n("cache_creation_input_tokens");
  if (read + write + n("input_tokens") === 0 && f.type === "stream_event") return false;
  r.usage = { read, write };
  return true;
}

/**
 * what claude leaves of a fork that writes no transcript: a checkpoint folder and an env folder
 * under its own id (probe). removed by that exact id, so nothing else is touched
 */
export async function sweepFork(claudeDir: string, fork: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(fork)) return;
  await Promise.all(
    ["file-history", "session-env"].map((d) =>
      rm(path.join(claudeDir, d, fork), { recursive: true, force: true }).catch(() => {}),
    ),
  );
}
