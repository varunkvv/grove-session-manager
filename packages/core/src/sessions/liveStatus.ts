import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { settingsLocalPath } from "../combos/settingsSync.ts";
import { isObject, readJsonGuarded, stringifyLike, writeFileAtomic } from "../fsx.ts";
import { getStateDir } from "../paths.ts";
import { squash } from "../transcript/title.ts";
import type { AgentRun, Combo, Disposable, LiveState, LiveStatus, Warning } from "../types.ts";

/**
 * which sessions need a person right now. a transcript cannot say it: "running a tool" and
 * "waiting on a permission prompt" look the same on disk. Claude Code hooks can, so each session
 * that should be tracked gets a few hooks that drop the hook's stdin into a directory we watch.
 */
export const STATUS_HOOK_EVENTS = [
  "UserPromptSubmit",
  "PermissionRequest",
  "PostToolUse",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
  // the only exact times a subagent's life has. nothing on disk records when one ended.
  "SubagentStart",
  "SubagentStop",
] as const;

const MARKER = "# grove-status";

export function statusEventsDir(stateDir: string): string {
  return path.join(stateDir, "events");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** the fields we read sit in the first ~1KB. the rest can be a whole tool output. */
export const EVENT_MAX_BYTES = 16_384;
/** past this many unread events the app has been closed a long while. stop adding, the state is stale. */
const EVENT_BACKLOG = 5000;

/**
 * one file per event, written aside and renamed in, so the app never reads half of one. no json
 * parsing in shell: the payload goes through, cut to its head, and the app reads the fields out of
 * it. the trailing cat drains what head left, so Claude Code never writes into a closed pipe.
 */
export function statusHookCommand(eventsDir: string): string {
  return (
    `d=${shellQuote(eventsDir)}; mkdir -p "$d" && ` +
    `[ "$(ls "$d" | wc -l | tr -d ' ')" -lt ${EVENT_BACKLOG} ] && ` +
    `f="$d/$$-$(date +%s)" && head -c ${EVENT_MAX_BYTES} > "$f.tmp" && mv "$f.tmp" "$f.json"; ` +
    `cat > /dev/null ${MARKER}`
  );
}

type HookGroup = { matcher?: string; hooks?: unknown[] };

function isOurs(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some(
    (h) => isObject(h) && typeof h.command === "string" && h.command.includes(MARKER),
  );
}

/** `hooks` with our entries replaced (or removed when `command` is null). everything else is kept. */
export function withStatusHooks(hooks: unknown, command: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(hooks) ? { ...hooks } : {};
  const events = new Set<string>([...Object.keys(out), ...STATUS_HOOK_EVENTS]);
  for (const event of events) {
    const list = Array.isArray(out[event]) ? (out[event] as unknown[]) : [];
    const kept = list.filter((g) => !isOurs(g));
    if (command && (STATUS_HOOK_EVENTS as readonly string[]).includes(event)) {
      const group: HookGroup = {
        matcher: "",
        // async: a status line must never slow down a turn
        hooks: [{ type: "command", command, async: true, timeout: 10 }],
      };
      kept.push(group);
    }
    if (kept.length) out[event] = kept;
    else delete out[event];
  }
  return out;
}

export type HookSyncStatus =
  | "created"
  | "written"
  | "unchanged"
  | "skipped-invalid-json"
  | "skipped-unexpected-shape";

/**
 * adds or removes our hooks in one Claude Code settings file. a file that is not valid JSON is
 * left alone. Claude Code watches its settings files, so running sessions pick this up.
 */
export async function syncStatusHooks(
  settingsFile: string,
  eventsDir: string,
  enabled: boolean,
): Promise<{ status: HookSyncStatus; warning?: Warning }> {
  const read = await readJsonGuarded(settingsFile);
  if (read.status === "invalid") {
    return {
      status: "skipped-invalid-json",
      warning: {
        code: "settings-invalid-json",
        message: `${settingsFile} is not valid JSON, so session status hooks were not added.`,
      },
    };
  }
  const command = enabled ? statusHookCommand(eventsDir) : null;
  if (read.status === "missing") {
    if (!command) return { status: "unchanged" };
    await writeFileAtomic(settingsFile, stringifyLike({ hooks: withStatusHooks({}, command) }));
    return { status: "created" };
  }
  const root = read.value;
  if (!isObject(root) || (root.hooks !== undefined && !isObject(root.hooks))) {
    return { status: "skipped-unexpected-shape" };
  }
  const hooks = withStatusHooks(root.hooks, command);
  if (JSON.stringify(hooks) === JSON.stringify(root.hooks ?? {})) return { status: "unchanged" };
  const next = { ...root, hooks };
  if (Object.keys(hooks).length === 0) delete (next as Record<string, unknown>).hooks;
  await writeFileAtomic(settingsFile, stringifyLike(next, read.text));
  return { status: "written" };
}

/** every session started in a combo reports its status. the combo's settings.local.json is ours to edit. */
export function syncComboStatusHooks(
  appRoot: string,
  combo: Combo,
): Promise<{ status: HookSyncStatus; warning?: Warning }> {
  return syncStatusHooks(settingsLocalPath(combo), statusEventsDir(getStateDir(appRoot)), true);
}

/** the repair is not urgent, and a settings file is often written in a burst */
const HOOK_RESYNC_DEBOUNCE_MS = 1000;

export interface HookWatchOptions {
  debounceMs?: number;
  /** every re-sync that completed. the app logs it; the tests count it. */
  onSync?: (status: HookSyncStatus) => void;
  onError?: (error: unknown) => void;
}

/**
 * re-syncs our hooks when someone else rewrites the settings file. a Claude Code session that was
 * already running when the hook set changed writes the copy it loaded at startup back over ours,
 * which silently drops the events we added, and nothing announces it - syncing once at app start
 * is not enough.
 *
 * this cannot ping-pong. our own write comes back through the same watcher, syncStatusHooks finds
 * the file already matching and returns `unchanged` without writing, so it stops there. the other
 * side writes on its own triggers, never on a file change, so it does not answer back either.
 *
 * null when the directory is not there yet - call again once it is.
 */
export function watchStatusHooks(
  settingsFile: string,
  eventsDir: string,
  opts: HookWatchOptions = {},
): Disposable | null {
  const dir = path.dirname(settingsFile);
  const name = path.basename(settingsFile);
  const delay = opts.debounceMs ?? HOOK_RESYNC_DEBOUNCE_MS;
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      // an atomic write renames a `.tmp` sibling in, so the directory reports other names too
      if (filename?.toString() !== name) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void syncStatusHooks(settingsFile, eventsDir, true)
          .then((r) => opts.onSync?.(r.status))
          .catch((e) => opts.onError?.(e));
      }, delay);
    });
  } catch (e) {
    opts.onError?.(e);
    return null;
  }
  watcher.on("error", (e) => opts.onError?.(e));
  return {
    dispose() {
      watcher.close();
      if (timer) clearTimeout(timer);
    },
  };
}

/** the combo's own settings file, watched. see watchStatusHooks for why this is not a one-off sync. */
export function watchComboStatusHooks(
  appRoot: string,
  combo: Combo,
  opts: HookWatchOptions = {},
): Disposable | null {
  return watchStatusHooks(settingsLocalPath(combo), statusEventsDir(getStateDir(appRoot)), opts);
}

export interface StatusEvent {
  sessionId: string;
  event: string;
  at: number;
  notificationType?: string;
  message?: string;
  toolName?: string;
  /** set when a subagent raised the event, not the session itself */
  agentId?: string;
  agentType?: string;
}

/**
 * a payload cut at EVENT_MAX_BYTES is no longer JSON. the short fields near its start still are
 * readable, which is all the status needs. free text (messages) is not trusted from a cut payload.
 */
export function parseTruncatedEvent(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "session_id",
    "hook_event_name",
    "tool_name",
    "notification_type",
    "agent_id",
    "agent_type",
  ]) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,200})"`).exec(text);
    if (m?.[1]) out[key] = m[1];
  }
  return out;
}

export function parseStatusEvent(payload: unknown, at: number): StatusEvent | null {
  if (!isObject(payload)) return null;
  const sessionId = payload.session_id;
  const event = payload.hook_event_name;
  if (typeof sessionId !== "string" || typeof event !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const ev: StatusEvent = { sessionId, event, at };
  const notificationType = str(payload.notification_type);
  // Stop carries the reply that ended the turn. it makes a better notification than "done".
  const message = str(payload.message) ?? str(payload.last_assistant_message);
  const toolName = str(payload.tool_name);
  const agentId = str(payload.agent_id);
  const agentType = str(payload.agent_type);
  if (notificationType) ev.notificationType = notificationType;
  if (message) ev.message = message;
  if (toolName) ev.toolName = toolName;
  if (agentId) ev.agentId = agentId;
  if (agentType) ev.agentType = agentType;
  return ev;
}

const NEEDS_YOU: ReadonlySet<LiveState> = new Set(["permission", "waiting", "failed"]);

export function needsYou(s: LiveStatus | undefined): boolean {
  return !!s && NEEDS_YOU.has(s.state) && !s.seen;
}

function next(
  prev: LiveStatus | undefined,
  ev: StatusEvent,
  state: LiveState,
  extra: Partial<LiveStatus> = {},
): LiveStatus {
  const turnStart = state === "running" ? (prev?.turnStart ?? ev.at) : prev?.turnStart;
  const out: LiveStatus = { state, at: ev.at, lastEventAt: ev.at, ...extra };
  if (turnStart !== undefined) out.turnStart = turnStart;
  return out;
}

/** one event on top of what we knew. undefined means the session is no longer live. */
export function reduceStatus(
  prev: LiveStatus | undefined,
  ev: StatusEvent,
): LiveStatus | undefined {
  // heartbeats from a background agent keep a running session fresh, and nothing else
  const touched = prev ? { ...prev, lastEventAt: Math.max(prev.lastEventAt, ev.at) } : prev;
  switch (ev.event) {
    case "UserPromptSubmit":
      return next(undefined, ev, "running", { turnStart: ev.at });
    case "PermissionRequest":
      return next(prev, ev, "permission", ev.toolName ? { detail: ev.toolName } : {});
    case "PostToolUse":
      if (ev.agentId && prev?.state !== "permission") return touched;
      // after a turn ended, a tool call means a new turn started without a prompt - a background
      // task finishing wakes the conversation up on its own
      if (prev?.state === "waiting" || prev?.state === "failed")
        return next(undefined, ev, "running");
      return next(prev, ev, "running");
    case "Notification":
      if (
        ev.notificationType === "permission_prompt" ||
        ev.notificationType === "agent_needs_input"
      ) {
        if (prev?.state === "permission") return touched;
        return next(prev, ev, "permission", ev.message ? { detail: ev.message } : {});
      }
      if (ev.notificationType === "idle_prompt" && prev?.state !== "waiting") {
        return next(prev, ev, "waiting");
      }
      return touched;
    case "Stop": {
      if (ev.agentId) return touched;
      const turnMs = prev?.turnStart !== undefined ? ev.at - prev.turnStart : undefined;
      return next(undefined, ev, "waiting", {
        ...(turnMs !== undefined ? { turnMs } : {}),
        ...(ev.message ? { detail: squash(ev.message, 160) } : {}),
      });
    }
    case "StopFailure":
      return next(undefined, ev, "failed", ev.message ? { detail: ev.message } : {});
    case "SessionEnd":
      return undefined;
    // a subagent starting or finishing is not the session starting or finishing. SubagentStop even
    // carries the agent's closing message, which must never read as the session's own.
    case "SubagentStart":
    case "SubagentStop":
      return touched;
    default:
      return touched;
  }
}

/** a session keeps this many agent ids. a long one spawns plenty; the newest are what anyone reads. */
const MAX_AGENT_RUNS = 64;

/**
 * the subagent lifecycle, kept beside the session's own state rather than inside it - reduceStatus
 * treats these events as heartbeats on purpose. undefined means the session is gone.
 *
 * every agent id here is taken on trust: Claude Code runs internal agents for /btw and prompt
 * suggestions that raise the same events, and only a meta file on disk tells them apart.
 */
export function reduceAgentRuns(
  prev: Readonly<Record<string, AgentRun>> | undefined,
  ev: StatusEvent,
): Record<string, AgentRun> | undefined {
  if (ev.event === "SessionEnd") return undefined;
  if (!ev.agentId) return prev;
  if (ev.event !== "SubagentStart" && ev.event !== "SubagentStop") return prev;
  const run: AgentRun = { ...prev?.[ev.agentId] };
  if (ev.event === "SubagentStart") run.startedAt = ev.at;
  else run.stoppedAt = ev.at;
  if (ev.agentType) run.agentType = ev.agentType;
  const out: Record<string, AgentRun> = { ...prev, [ev.agentId]: run };
  const ids = Object.keys(out);
  if (ids.length > MAX_AGENT_RUNS) {
    const at = (id: string) => out[id]?.startedAt ?? out[id]?.stoppedAt ?? 0;
    for (const id of ids.sort((a, b) => at(a) - at(b)).slice(0, ids.length - MAX_AGENT_RUNS)) {
      delete out[id];
    }
  }
  return out;
}

/**
 * every event file in the directory, oldest first, each removed once read. ordered by mtime:
 * the hooks run async, so names alone do not say which came first within a second.
 */
export async function drainStatusEvents(eventsDir: string): Promise<StatusEvent[]> {
  let names: string[];
  try {
    names = (await readdir(eventsDir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const files = await Promise.all(
    names.map(async (n) => {
      const file = path.join(eventsDir, n);
      try {
        return { file, at: (await stat(file)).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const events: StatusEvent[] = [];
  for (const f of files
    .filter((x) => x !== null)
    .sort((a, b) => a.at - b.at || a.file.localeCompare(b.file))) {
    // claim by rename, so two readers never both take one
    const claimed = `${f.file}.read`;
    try {
      await rename(f.file, claimed);
      const text = await readFile(claimed, "utf8");
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = parseTruncatedEvent(text);
      }
      const ev = parseStatusEvent(payload, f.at);
      if (ev) events.push(ev);
    } catch {
      // gone already, or not JSON
    } finally {
      await unlink(claimed).catch(() => {});
    }
  }
  return events;
}
