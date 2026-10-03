// who is calling, and is a card's holder still running.
//
// session  who the agent is. stable across a resume, new after /clear and after a fork.
// pid      the claude process, not this short-lived one. only evidence that the holder is running.
// agent    a label for people: the session's name in claude code's own registry.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostName } from "./publish.ts";
import { testOverrides } from "./version.ts";

export interface Caller {
  /** "person" when grove writes for the person. everything else is an agent. */
  actor: "agent" | "person";
  /** the claude session id, or the word "person". */
  session: string;
  /** where the session id came from: override | registry | env | none */
  sessionSource: string;
  /** the claude process. null when it cannot be known. */
  pid: number | null;
  pidSource: string;
  /** display name. empty for the person. */
  agent: string;
  /** `as`: the short name a subagent gave itself. */
  sub?: string;
  /** claude code's id for the tool call that is writing. only over MCP. */
  toolUseId?: string;
  host: string;
}

export interface CallerInput {
  env: NodeJS.ProcessEnv;
  /** the parent process of the MCP server. the CLI passes nothing. */
  ppid?: number;
  as?: string;
  toolUseId?: string;
  person?: boolean;
  /** `session_id` from the stdin of a SessionStart hook. the hook's env and parent are not to be relied on. */
  hookSession?: string;
}

export function registryDir(env: NodeJS.ProcessEnv): string {
  return (
    (testOverrides() && env.GROVE_RECORD_REGISTRY) ||
    path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude"), "sessions")
  );
}

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  name: string;
  /** `ps -o lstart` of the process when claude code wrote the file. "" when absent. */
  procStart: string;
}

/** claude code's own file for one live process. an internal format: only sessionId, name and procStart are read. */
export function readRegistryEntry(dir: string, pid: number): RegistryEntry | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), "utf8"));
    if (!j || typeof j.sessionId !== "string" || !j.sessionId) return null;
    return {
      pid,
      sessionId: j.sessionId,
      name: typeof j.name === "string" ? j.name : "",
      procStart: typeof j.procStart === "string" ? j.procStart : "",
    };
  } catch {
    return null;
  }
}

/** the live claude process that runs this session, by claude code's own registry. null when none is listed. */
export function findRegistryBySession(dir: string, session: string): RegistryEntry | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = /^([1-9]\d*)\.json$/.exec(name);
    if (!m) continue;
    const entry = readRegistryEntry(dir, Number(m[1]));
    if (entry?.sessionId === session) return entry;
  }
  return null;
}

function toPid(v: string | undefined): number | null {
  return v && /^[1-9]\d*$/.test(v) ? Number(v) : null;
}

/**
 * read on every call, never cached: /clear gives the same claude process a new session id, and
 * the server's own env keeps the id it was started with.
 */
export function resolveCaller(input: CallerInput): Caller {
  const env = input.env;
  const host = hostName();
  const sub = input.as?.trim() || undefined;
  const test = testOverrides();
  if (input.person || (test && env.GROVE_RECORD_ACTOR === "person")) {
    return {
      actor: "person",
      session: "person",
      sessionSource: "person",
      pid: null,
      pidSource: "none",
      agent: "",
      sub,
      toolUseId: input.toolUseId,
      host,
    };
  }
  let pid: number | null = null;
  let pidSource = "none";
  const over = test ? toPid(env.GROVE_RECORD_PID) : null;
  const claudePid = toPid(env.CLAUDE_PID);
  if (over) [pid, pidSource] = [over, "override"];
  else if (claudePid) [pid, pidSource] = [claudePid, "CLAUDE_PID"];
  else if (input.ppid && input.ppid > 1) [pid, pidSource] = [input.ppid, "ppid"];

  const reg = pid ? readRegistryEntry(registryDir(env), pid) : null;
  let session = "";
  let sessionSource = "none";
  if (test && env.GROVE_RECORD_SESSION)
    [session, sessionSource] = [env.GROVE_RECORD_SESSION, "override"];
  // a hook's stdin names the session that is starting. after /clear the registry may still name the old one
  else if (input.hookSession) [session, sessionSource] = [input.hookSession, "hook"];
  else if (reg) [session, sessionSource] = [reg.sessionId, "registry"];
  else if (env.CLAUDE_CODE_SESSION_ID)
    [session, sessionSource] = [env.CLAUDE_CODE_SESSION_ID, "env"];
  if (!/^[A-Za-z0-9._@-]*$/.test(session)) [session, sessionSource] = ["", "none"];

  // the name is a label. with no registry entry for the pid (a hook, a detached shell) look the session up
  const overAgent = test ? env.GROVE_RECORD_AGENT : undefined;
  const named =
    reg?.sessionId === session
      ? reg.name
      : session && !overAgent
        ? findRegistryBySession(registryDir(env), session)?.name
        : "";
  const agent = overAgent || named || (session ? session.slice(0, 8) : "");
  // a tool-use id is written bare into the record, so anything but its own alphabet is dropped
  const tu = input.toolUseId || env.GROVE_RECORD_TOOL_USE_ID || "";
  return {
    actor: "agent",
    session,
    sessionSource,
    pid,
    pidSource,
    agent,
    sub,
    toolUseId: /^[A-Za-z0-9_-]+$/.test(tu) ? tu : undefined,
    host,
  };
}

/**
 * start time of a process, in one fixed form whatever the caller's time zone and locale. empty
 * when the process does not exist. the same string as `procStart` in ~/.claude/sessions/<pid>.json.
 */
export function procStart(pid: number): string {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      env: { LC_ALL: "C", TZ: "UTC0", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

export type Liveness = "alive" | "dead" | "unknown";

export interface HolderRef {
  session: string;
  pid: number | null;
  pidStart: string;
  host: string;
}

/**
 * alive | dead | unknown. unknown is treated as alive everywhere: never take a card on a guess.
 * ported from record.sh holder_status, same order.
 */
export function holderStatus(holder: HolderRef, env: NodeJS.ProcessEnv): Liveness {
  if (holder.host !== hostName()) return "unknown";
  // ps must work for us to say "dead". in a sandbox it may not
  if (!procStart(process.pid)) return "unknown";
  const dir = registryDir(env);
  // 1. is any registered claude process running that session right now? covers a resume under a new pid
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // no registry
  }
  for (const name of names) {
    const m = /^([1-9]\d*)\.json$/.exec(name);
    if (!m) continue;
    const entry = readRegistryEntry(dir, Number(m[1]));
    // a file left by a crash names a pid that may now be another process. its start time tells
    if (entry?.sessionId !== holder.session) continue;
    const now = procStart(entry.pid);
    if (now && (!entry.procStart || entry.procStart === now)) return "alive";
  }
  // 2. the process that made the claim
  if (!holder.pid) return "unknown";
  const started = procStart(holder.pid);
  if (!started) return "dead";
  if (holder.pidStart && started !== holder.pidStart) return "dead"; // the pid was reused
  // the process is there. if the registry says it now runs another session (/clear, /resume in
  // the same process), the holder session is not running anywhere
  const now = readRegistryEntry(dir, holder.pid);
  if (now && now.sessionId !== holder.session) return "dead";
  return "alive";
}
