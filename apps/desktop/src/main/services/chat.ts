// grove chat's host: one claude per session grove runs itself, through the agent sdk, kept in main
// so it outlives the window it was opened from. no electron import: a window is a PushTarget.
import { randomUUID } from "node:crypto";
import { type FSWatcher, statSync, watch } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CanUseTool,
  EffortLevel,
  ElicitationRequest,
  ElicitationResult,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
  UserDialogRequest,
  UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk";
import {
  attachedFileText,
  editDiff,
  firstSentence,
  TASK_MIN_MS,
  toolLabel,
  toolTarget,
} from "@grove/core";
import type {
  ChatAgent,
  ChatAnswer,
  ChatAsk,
  ChatAttachment,
  ChatCommand,
  ChatMode,
  ChatNote,
  ChatQuestion,
  ChatRewind,
  ChatStatus,
  DialogChoice,
  ElicitField,
} from "../../shared/ipc.ts";
import type { EffortChoice, ModelChoice } from "../../shared/newSession.ts";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";
import type { PushTarget } from "../push.ts";
import {
  type ForkRead,
  forkOptions,
  KEEP_MISS_TOKENS,
  KEEP_PROMPT,
  KEEP_TIMEOUT_MS,
  keepDue,
  keepHours,
  readFork,
  sweepFork,
} from "./cacheKeeper.ts";
import { type ChatTask, ChatTasks } from "./chatTasks.ts";
import { taskView } from "./projects.ts";
import { onPath, type Placed, place } from "./uploads.ts";

/** an idle session with no window open is let go after this. the next send resumes it */
export const REAP_MS = 10 * 60_000;
/** how long a turn being let go of gets to end on its interrupt */
const RELEASE_WAIT_MS = 3000;
/** the streamed answer goes to the window at most this often */
const FLUSH_MS = 50;
/** a permission's input, as the card shows it */
const DETAIL_MAX = 2000;
/** a question option's preview: a mockup or a snippet */
const PREVIEW_MAX = 8000;

/** a prompt, a typed answer: generous, and still a bound on what a page can hand claude */
const TEXT_MAX = 200_000;

export const isText = (v: unknown, max = TEXT_MAX): v is string =>
  typeof v === "string" && v.length <= max;

const CHOICES: ReadonlySet<string> = new Set([
  "retry_fallback",
  "edit_prompt",
  "continue",
  "interrupt",
]);

/**
 * the dialogs grove draws, as vs code 2.1.301 declares and reads them (webview `tv1`, `Pv1`): a
 * refusal's fallback and auto mode's billed classifier. neither could be made to come on the wire
 */
export const DIALOG_KINDS = ["refusal_fallback_prompt", "auto_mode_server_fallback"];

/**
 * an MCP server's elicitation as a card: a form from its schema's flat properties (string, number,
 * integer, boolean, enum, as MCP allows), or a page to open. undefined for a schema grove cannot draw
 */
export function elicitOf(
  id: string,
  r: {
    serverName: string;
    message: string;
    mode?: string;
    url?: string;
    title?: string;
    requestedSchema?: Record<string, unknown>;
  },
): ChatAsk | undefined {
  const base = {
    id,
    kind: "elicit" as const,
    server: r.serverName,
    message: cut(r.message, 4000),
    ...(r.title ? { title: cut(r.title, 200) } : {}),
  };
  if (r.mode === "url") {
    return typeof r.url === "string" && /^https?:\/\//.test(r.url)
      ? { ...base, url: r.url, fields: [] }
      : undefined;
  }
  const props = (r.requestedSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(
    Array.isArray(r.requestedSchema?.required) ? (r.requestedSchema.required as string[]) : [],
  );
  const fields: ElicitField[] = [];
  for (const [key, p] of Object.entries(props).slice(0, 20)) {
    const options = Array.isArray(p.enum)
      ? p.enum.filter((x): x is string => typeof x === "string")
      : undefined;
    const type = options?.length
      ? "enum"
      : p.type === "boolean"
        ? "boolean"
        : p.type === "number" || p.type === "integer"
          ? "number"
          : p.type === "string"
            ? "string"
            : undefined;
    if (!type) return undefined;
    fields.push({
      key,
      label: typeof p.title === "string" ? p.title : key,
      type,
      required: required.has(key),
      ...(typeof p.description === "string" ? { description: cut(p.description, 300) } : {}),
      ...(options?.length ? { options } : {}),
    });
  }
  return { ...base, fields };
}

/** a dialog's payload as a card, or undefined for one in a shape grove does not know */
export function dialogOf(
  id: string,
  kind: string,
  p: Record<string, unknown>,
): ChatAsk | undefined {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  if (kind === "refusal_fallback_prompt") {
    const model = str(p.originalModel);
    const fallback = str(p.fallbackModel);
    if (!model || !fallback) return undefined;
    const category = str(p.apiRefusalCategory);
    return { id, kind: "refusal", model, fallback, ...(category ? { category } : {}) };
  }
  if (kind === "auto_mode_server_fallback") {
    const paragraphs = Array.isArray(p.paragraphs)
      ? p.paragraphs.flatMap((x) => (typeof x === "string" && x.trim() ? [cut(x, 2000)] : []))
      : [];
    const title = str(p.title);
    return { id, kind: "auto-fallback", ...(title ? { title } : {}), paragraphs };
  }
  return undefined;
}

/** what the page sent as an answer, held to the shapes the host knows. anything else is refused */
export function parseAnswer(raw: unknown): ChatAnswer {
  const a = raw as Record<string, unknown> | null;
  const bad = () => new AppError("invalid", "That is not an answer.");
  if (!a || typeof a !== "object") throw bad();
  const message = a.message === undefined ? undefined : isText(a.message) ? a.message : null;
  if (message === null) throw bad();
  if (a.kind === "question") {
    const answers = a.answers as Record<string, unknown> | null;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw bad();
    const clean: Record<string, string> = {};
    for (const [q, v] of Object.entries(answers)) {
      if (!isText(q, 4000) || !isText(v)) throw bad();
      clean[q] = v;
    }
    return { kind: "question", answers: clean };
  }
  if (a.kind === "plan" && typeof a.approve === "boolean") {
    const mode = a.mode === undefined ? undefined : asMode(a.mode);
    if (a.mode !== undefined && !mode) throw bad();
    return {
      kind: "plan",
      approve: a.approve,
      ...(message ? { message } : {}),
      ...(mode ? { mode } : {}),
    };
  }
  if (a.kind === "permission" && (a.allow === "once" || a.allow === "always" || a.allow === "no")) {
    return { kind: "permission", allow: a.allow, ...(message ? { message } : {}) };
  }
  if (a.kind === "dialog" && (a.choice === null || CHOICES.has(a.choice as string))) {
    return { kind: "dialog", choice: a.choice as DialogChoice | null };
  }
  if (
    a.kind === "elicit" &&
    (a.action === "accept" || a.action === "decline" || a.action === "cancel")
  ) {
    if (a.content === undefined) return { kind: "elicit", action: a.action };
    const c = a.content as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).length > 50) throw bad();
    const clean: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(c)) {
      if (!isText(k, 100)) throw bad();
      if (
        typeof v === "boolean" ||
        (typeof v === "number" && Number.isFinite(v)) ||
        isText(v, 10_000)
      )
        clean[k] = v;
      else throw bad();
    }
    return { kind: "elicit", action: a.action, content: clean };
  }
  throw bad();
}

/** where a session runs: its folder, and the project's other folders */
export interface ChatWhere {
  cwd: string;
  dirs: string[];
  /** a session grove made (cmd-N) that has no transcript yet: claude starts it under this id */
  fresh?: boolean;
  /** a fresh one's project's model and effort. a resumed session keeps its own */
  model?: ModelChoice;
  effort?: EffortChoice;
}

/** what the api takes, as Claude Code's own image paste sends it */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MB = 1024 * 1024;
/** base64 of n bytes */
const encoded = (n: number) => Math.ceil(n / 3) * 4;
/**
 * grove's caps, on what crosses ipc. only an image goes inline, and claude code shrinks it before
 * the api sees it (probe: an 18.7MB png went as a 455KB jpeg). everything else goes by a path, so
 * `bytes` only bounds a file sent as its bytes: an image, or a paste with no file behind it
 */
export const ATTACH = {
  files: 10,
  bytes: encoded(20 * MB),
} as const;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** a name that becomes a file's in grove's uploads: no folders in it */
const isName = (v: unknown): v is string => isText(v, 255) && !!v.trim() && !/[/\0\n\r]/.test(v);

/** files attached in the composer, as the page sent them, held to what grove sends. else refused */
export function parseAttachments(raw: unknown): ChatAttachment[] {
  if (raw === undefined) return [];
  const bad = (why = "That is not a file Claude can take.") => new AppError("invalid", why);
  if (!Array.isArray(raw) || raw.length > ATTACH.files) throw bad();
  return raw.map((f): ChatAttachment => {
    const o = f as Record<string, unknown> | null;
    if (o?.kind === "image") {
      if (typeof o.mediaType !== "string" || !IMAGE_TYPES.has(o.mediaType)) throw bad();
      if (!isText(o.data, ATTACH.bytes) || !BASE64.test(o.data)) throw bad();
      if (o.name !== undefined && !isName(o.name)) throw bad();
      return {
        kind: "image",
        mediaType: o.mediaType as "image/png",
        data: o.data,
        ...(o.name !== undefined ? { name: o.name as string } : {}),
      };
    }
    if (!isText(o?.name, 255) || !o.name.trim()) throw bad();
    // a paste with no file behind it: main writes it to disk
    if (o.kind === "data") {
      if (!isName(o.name) || !isText(o.mediaType, 255)) throw bad();
      if (!isText(o.data, ATTACH.bytes) || !BASE64.test(o.data)) throw bad();
      return { kind: "data", name: o.name, mediaType: o.mediaType, data: o.data };
    }
    // by its path: nothing is read, so no size cap. it has to be a file there now, by that name
    if (o.kind === "file") {
      if (!isText(o.path, 4096) || !path.isAbsolute(o.path) || /[\0\n\r]/.test(o.path)) {
        throw bad();
      }
      if (!isText(o.mediaType, 255)) throw bad();
      const st = (() => {
        try {
          return statSync(o.path);
        } catch {
          return null;
        }
      })();
      if (!st) throw bad(`${o.name} is not there any more.`);
      if (!st.isFile()) throw bad(`${o.name} is not a file.`);
      const name = path.basename(o.path);
      return { kind: "file", name, path: o.path, mediaType: o.mediaType, size: st.size };
    }
    throw bad();
  });
}

const isPdf = (f: { name: string; mediaType: string }) =>
  f.mediaType === "application/pdf" || /\.pdf$/i.test(f.name);

/**
 * a message's content blocks: what is attached first, then the words. an image inline, in the
 * shape vs code sends it. any other file a text block naming where it is on disk, which claude
 * reads when it needs it. `pages`: pdftoppm is there, so a Read of a pdf's pages works
 */
export function blocksFor(
  text: string,
  files: Placed[],
  pages = true,
): SDKUserMessage["message"]["content"] {
  return [
    ...files.map((f) =>
      f.kind === "image"
        ? {
            type: "image" as const,
            source: { type: "base64" as const, media_type: f.mediaType, data: f.data },
          }
        : { type: "text" as const, text: attachedFileText({ ...f, whole: !pages && isPdf(f) }) },
    ),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
}

export interface ChatHostOptions {
  claudeBin: () => Promise<string>;
  env: () => Promise<NodeJS.ProcessEnv>;
  /**
   * where grove keeps what is attached for claude to read, a folder per session in it. claude may
   * read anything in it without asking
   */
  uploads: string;
  /** a process came or went, or a turn started or ended: rows say where a session runs */
  onChange?: () => void;
  now?: () => number;
  /** claude code's own settings.json: whether the person asked to see thinking summaries */
  claudeSettings?: string;
  /**
   * /clear: the same claude goes on as a new session under a new id. the host has moved it there,
   * and its windows go with it
   */
  onReset?: (from: string, to: string, where: ChatWhere) => void;
  /** its status moved: the main window's session card follows it. never the streamed text */
  onStatus?: (id: string, status: ChatStatus) => void;
  /**
   * grove is about to close these claudes itself, on quit or when the reaper lets one go. the
   * session did not end, so what it waits on should still show after its SessionEnd
   */
  letGo?: (ids: string[]) => void;
  /**
   * a card claude raises no hook for (a dialog, an MCP server's form) opened: what the first one
   * asks. null when the last one went, answered, taken back or with its claude. a tool's ask is
   * not one: its PermissionRequest hook says it
   */
  onCard?: (id: string, asks: string | null) => void;
  /** claude code's projects folder: a failed auto mode check leaves the api's error in it */
  projectsDir?: string;
  /** the cache keeper's setting: hours after a session's last turn its cache is kept. 0 is off */
  keepWarmHours?: () => number | undefined;
  /** the keeper's fork, in place of the sdk's query: a test's */
  fork?: typeof import("@anthropic-ai/claude-agent-sdk")["query"];
}

/** what a card no hook announces asks, as its own label says it. undefined for a tool's ask */
function unhooked(a: ChatAsk): string | undefined {
  if (a.kind === "elicit") return `${a.server} asks`;
  if (a.kind === "refusal") return "Session paused";
  if (a.kind === "auto-fallback") return a.title ?? "Auto mode";
  return undefined;
}

const cardOf = (asks: readonly ChatAsk[]): string | null => {
  for (const a of asks) {
    const says = unhooked(a);
    if (says) return says;
  }
  return null;
};

/** vs code's thinking budget (extension.js `M61`), sent for every model as it sends it */
const THINKING_BUDGET = 31_999;

/** the person's `showThinkingSummaries`, as vs code reads it: off unless it says true */
async function showsThinking(file: string | undefined): Promise<boolean> {
  if (!file) return false;
  try {
    return JSON.parse(await readFile(file, "utf8"))?.showThinkingSummaries === true;
  } catch {
    return false;
  }
}

/**
 * what the claude code that started grove put in its environment, when one did (`pnpm app:dev`
 * from an agent's shell): with it the child registers as that session's editor. a grove opened
 * from Finder has none of these
 */
const PARENT_SESSION = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
]);

export function hostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !PARENT_SESSION.has(k)));
}

/**
 * when the api clears old tool results out of what claude sees: past 150k tokens of input, every
 * result but the newest 20, and only when that frees 20k or more. 20 because a turn reads several
 * files at once and a result cleared in the request it arrives in gets read again
 */
export const CLEARING = { trigger: 150_000, keep: 20, atLeast: 20_000 };

const isOn = (v: unknown): boolean =>
  typeof v === "string" &&
  !!v.trim() &&
  !["0", "false", "no", "off"].includes(v.trim().toLowerCase());

/**
 * the env that has the api clear old reads, through claude code's CLAUDE_CODE_EXTRA_BODY. it
 * replaces claude code's own context_management (only clear_thinking, keep all). no thinking edit:
 * claude code sends the body with auto mode's classifier too, which runs with thinking off, and
 * the api refuses clear_thinking there, so every classifier check fails closed. opus 4.5+,
 * sonnet 4.6+ and haiku 5.5+ keep all thinking without it. nothing where the api would refuse
 * every request: experimental betas off, a provider or gateway that does not get the
 * context-management beta. nothing when the person set an extra body of their own. `settings`:
 * the env of claude code's settings.json
 */
export function clearingEnv(
  env: NodeJS.ProcessEnv,
  settings: Record<string, unknown> = {},
  n = CLEARING,
): NodeJS.ProcessEnv {
  // claude code puts its settings' env over its own, as here
  const all: Record<string, unknown> = { ...env, ...settings };
  if (all.CLAUDE_CODE_EXTRA_BODY !== undefined) return {};
  if (isOn(all.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) return {};
  for (const k of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"])
    if (isOn(all[k])) return {};
  const base = typeof all.ANTHROPIC_BASE_URL === "string" ? all.ANTHROPIC_BASE_URL.trim() : "";
  if (base && !/^https:\/\/api\.anthropic\.com\/?$/.test(base)) return {};
  const edits = [
    {
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: n.trigger },
      keep: { type: "tool_uses", value: n.keep },
      clear_at_least: { type: "input_tokens", value: n.atLeast },
      clear_tool_inputs: false,
    },
  ];
  return { CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ context_management: { edits } }) };
}

/** the env of claude code's settings.json, where a gateway's base url often is. {} without one */
async function settingsEnv(file: string | undefined): Promise<Record<string, unknown>> {
  if (!file) return {};
  try {
    const env = JSON.parse(await readFile(file, "utf8"))?.env;
    // a value someone typed as a number still counts, as claude code reads it
    if (!env || typeof env !== "object") return {};
    return Object.fromEntries(
      Object.entries(env).flatMap(([k, v]) =>
        ["string", "number", "boolean"].includes(typeof v) ? [[k, String(v)]] : [],
      ),
    );
  } catch {
    return {};
  }
}

/** a turn the api refused for the extra body: `API Error: 400 context_management: ...` */
export function refusedClearing(m: { type: string }): boolean {
  if (m.type !== "result") return false;
  const r = m as { is_error?: boolean; result?: unknown; api_error_status?: unknown };
  if (r.is_error !== true || typeof r.result !== "string") return false;
  const status = r.api_error_status ?? /^API Error: (\d+)/.exec(r.result)?.[1] ?? "";
  return String(status) === "400" && r.result.includes("context_management");
}

/** what claude code leaves in a session's folder when auto mode's check failed (2.1.310) */
export const CLASSIFIER_ERROR_FILE = "auto-mode-classifier-error.txt";

/**
 * the api's error in that file: `400 {"type":"error","error":{"message":...}}` -> "400 <message>".
 * claude code itself only says the classifier's model is "temporarily unavailable"
 */
export function classifierError(file: string): string | undefined {
  const line = /=== ERROR ===\n(.+)/.exec(file)?.[1]?.trim();
  if (!line) return undefined;
  const [, status, body] = /^(\d{3}) (.*)$/.exec(line) ?? [];
  try {
    const message = JSON.parse(body ?? "")?.error?.message;
    if (typeof message === "string") return cut(`${status} ${message}`, 300);
  } catch {}
  return cut(line, 300);
}

/** a classifier error about grove's extra body: every later check fails the same way */
export const refusedClearingCheck = (error: string): boolean =>
  /^400 /.test(error) && /context_management|clear_(thinking|tool_uses)_\d+/.test(error);

/** the chat's error line once claude was started again without clearing */
export const CLEARING_REFUSED =
  "The API refused clearing old reads here, so Claude restarted without it. Try that message again.";

/** the pill's modes. bypass and the classifier modes only when the session started in one */
export function modesFor(start: ChatMode | undefined): ChatMode[] {
  const modes: ChatMode[] = ["default", "acceptEdits", "plan"];
  return start && !modes.includes(start) ? [...modes, start] : modes;
}

/** an api error's kind, as the live line says it */
const RETRY_WORD: Record<string, string> = {
  rate_limit: "rate limited",
  overloaded: "overloaded",
  server_error: "server error",
  unknown: "an error",
};

/** an api_retry frame, as the live line says it: "Retrying in 8s · overloaded (2 of 10)" */
export function retryLine(m: {
  retry_delay_ms: number;
  attempt: number;
  max_retries: number;
  error_status: number | null;
  error: string;
}): string {
  // no status: the api sent nothing back in time
  const why =
    m.error_status === null ? "no answer" : (RETRY_WORD[m.error] ?? m.error.replace(/_/g, " "));
  const wait = Math.max(1, Math.round(m.retry_delay_ms / 1000));
  return `Retrying in ${wait}s · ${why} (${m.attempt} of ${m.max_retries})`;
}

/**
 * the model as the window names it. claude reports the id it runs ("claude-opus-5-5"), and more
 * than one row can stand for that id (Default and Opus both do): the row picked stays picked
 */
export function modelFor(status: Pick<ChatStatus, "model" | "models">, reported: string): string {
  const named = status.models.find((m) => m.value === status.model || m.id === status.model);
  return named && (named.id === reported || named.value === reported) ? named.value : reported;
}

/** a rate limit's window, as the chip says it */
const LIMIT_WINDOW: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
  overage: "extra usage",
};

/** the output styles there are, and the one it starts in, from init's answer */
function stylesOf(init: unknown): Pick<ChatStatus, "style" | "styles"> {
  const i = init as { available_output_styles?: unknown; output_style?: unknown };
  const styles = Array.isArray(i.available_output_styles)
    ? i.available_output_styles.filter((x): x is string => typeof x === "string")
    : [];
  return {
    ...(styles.length ? { styles } : {}),
    ...(typeof i.output_style === "string" ? { style: i.output_style } : {}),
  };
}

/** a model that can answer without thinking: the 4.x ones. 5.x and fable always think */
export const thinksOff = (s: Pick<ChatStatus, "model" | "models">): boolean => {
  const m = s.models.find((x) => x.value === s.model || x.id === s.model);
  return /claude-(opus|sonnet|haiku)-4/.test(m?.id ?? m?.value ?? s.model ?? "");
};

/** notes kept under a turn: past this the oldest go */
const NOTES_MAX = 20;

/** a task's end, as the agents list says it */
const TASK_STATE: Record<string, ChatAgent["state"] | undefined> = {
  completed: "done",
  failed: "failed",
  killed: "stopped",
  stopped: "stopped",
};

/** a workflow agent's state in `workflow_progress`: start and done seen on the wire, the rest guessed */
const WORKFLOW_AGENT_STATE: Record<string, ChatAgent["state"] | undefined> = {
  start: "running",
  done: "done",
  failed: "failed",
  error: "failed",
  skipped: "stopped",
  cancelled: "stopped",
  killed: "stopped",
};

/**
 * one entry of a workflow's `task_progress.workflow_progress` (recordings/d-workflow): its agents
 * have no task frames of their own, this is all the stream says of them. not in the sdk's types
 */
interface WorkflowAgentProgress {
  type: "workflow_agent";
  agentId?: string;
  label?: string;
  agentType?: string;
  state?: string;
  durationMs?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  resultPreview?: string;
}

/** a workflow's agents as the agents list shows them, from the latest progress snapshot */
export function workflowAgents(
  workflow: string,
  progress: unknown,
  had: ReadonlyMap<string, ChatAgent>,
  now: number,
): ChatAgent[] {
  if (!Array.isArray(progress)) return [];
  return progress.flatMap((p: WorkflowAgentProgress): ChatAgent[] => {
    // a queued one has no id, and no transcript yet
    if (p?.type !== "workflow_agent" || typeof p.agentId !== "string") return [];
    const state = WORKFLOW_AGENT_STATE[p.state ?? ""] ?? "running";
    const was = had.get(p.agentId);
    // grove's clock, as for every agent: from when it was first heard of, back by what it took
    const took = typeof p.durationMs === "number" ? p.durationMs : 0;
    const since = was?.since ?? (state === "running" ? now : now - took);
    const tool =
      p.lastToolName && `${p.lastToolName}${p.lastToolSummary ? ` ${p.lastToolSummary}` : ""}`;
    const step = tool || (state === "done" && p.resultPreview ? cut(p.resultPreview, 200) : "");
    return [
      {
        id: p.agentId,
        description: p.label || "agent",
        ...(p.agentType ? { agentType: p.agentType } : {}),
        workflow,
        state,
        since,
        ...(state !== "running" ? { ended: was?.ended ?? now } : {}),
        ...(step ? { step } : {}),
      },
    ];
  });
}

const MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
]);
const asMode = (v: unknown): ChatMode | undefined =>
  typeof v === "string" && MODES.has(v) ? (v as ChatMode) : undefined;

/** what the person sends, as the sdk reads it: one at a time, as they come */
class Prompts implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;

  /** returns the uuid it went with: claude's command_lifecycle frames and a take-back name it */
  push(text: string, files: Placed[] = [], pages = true): string {
    const uuid = randomUUID();
    this.queue.push({
      type: "user",
      message: { role: "user", content: blocksFor(text, files, pages) },
      parent_tool_use_id: null,
      // typed by a person: the sdk treats a message with no origin as nobody's
      origin: { kind: "human" },
      // not in the sdk's types, but on the wire: claude says what became of it by this
      ...({ uuid } as object),
    });
    this.wake?.();
    return uuid;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => {
        this.wake = r;
      });
      this.wake = null;
    }
  }
}

/** what `getSettings().applied` says, as claude 2.1.296 answers it (recordings/c-start.jsonl) */
interface Applied {
  model?: string;
  effort?: string | null;
  ultracode?: boolean;
  ultracodeRequested?: boolean;
  ultracodeAvailable?: boolean;
}

interface Waiting {
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
  /** a dialog, not a tool's permission: its answer goes here instead */
  dialog?: (r: UserDialogResult) => void;
  /** an MCP server's form: its answer goes here */
  elicit?: (r: ElicitationResult) => void;
}

interface Hosted {
  id: string;
  where: ChatWhere;
  q?: Query;
  prompts: Prompts;
  status: ChatStatus;
  /** the answer being streamed: the text block the turn is writing now */
  text: string;
  /** where the text changed since the window last got it. null: nothing to send */
  dirty: number | null;
  flush?: NodeJS.Timeout;
  waiting: Map<string, Waiting>;
  windows: Set<PushTarget>;
  lastActive: number;
  starting?: Promise<void>;
  /** the message loop. it ends when the process does */
  ended?: Promise<void>;
  /** what waits for the turn under way to end: a move to the editor */
  afterTurn: Array<() => void>;
  /** a model picked before claude was up */
  model?: string;
  /** what `/` offers: Claude Code's commands and the skills it found */
  commands: ChatCommand[];
  /** the file its window's viewer shows: a change to it is pushed there */
  watching?: FSWatcher;
  /** its subagents, by task id, as the task frames say */
  agents: Map<string, ChatAgent>;
  /** what its claude left running: commands, Monitors, wake-ups */
  tasks: ChatTasks;
  /** the main window counts a command once it is a minute old: no frame says when that is */
  taskMinute?: ReturnType<typeof setTimeout>;
  /** the task the tool under way runs as, once claude has made it one */
  toolTask?: string;
  /** `system/init.terminal_slash_commands`: commands for a terminal, not a chat window */
  terminalOnly?: Set<string>;
  /** the send under way: its files are put on disk before it goes, and the next waits for it */
  sending?: Promise<void>;
  /** this claude was started with clearingEnv's extra body */
  clearing?: boolean;
  /** the cache keeper's clock: when its last turn ended, and when a fork last read its cache */
  lastTurn?: number;
  lastWarm?: number;
  /** a fork missed its cache: not kept again until a real turn */
  keepOff?: boolean;
  /**
   * the model its claude was put on by name: a pick in the menu, or the project's for a session
   * grove started. what claude chose itself is not named to a fork: "default" for the same opus
   * as "opus" missed 1.2k of the cache (probe)
   */
  picked?: string;
}

const emptyStatus = (): ChatStatus => ({
  live: false,
  starting: false,
  running: false,
  modes: modesFor(undefined),
  models: [],
  asks: [],
  queued: [],
  rev: 0,
});

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const commandsOf = (raw: unknown): ChatCommand[] =>
  (Array.isArray(raw) ? raw : []).flatMap((c) =>
    c && typeof c.name === "string"
      ? [
          {
            name: c.name,
            description: typeof c.description === "string" ? c.description : "",
            hint: typeof c.argumentHint === "string" ? c.argumentHint : "",
          },
        ]
      : [],
  );

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function questionsOf(input: Record<string, unknown>): ChatQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.flatMap((q): ChatQuestion[] => {
    if (!q || typeof q !== "object") return [];
    const o = q as Record<string, unknown>;
    if (typeof o.question !== "string") return [];
    const options = Array.isArray(o.options) ? o.options : [];
    return [
      {
        question: o.question,
        header: typeof o.header === "string" ? o.header : "",
        multiSelect: o.multiSelect === true,
        options: options.flatMap((x) => {
          const o = x as { label?: unknown; description?: unknown; preview?: unknown } | null;
          if (!o || typeof o !== "object" || typeof o.label !== "string") return [];
          return [
            {
              label: o.label,
              description: String(o.description ?? ""),
              ...(typeof o.preview === "string" && o.preview
                ? { preview: cut(o.preview, PREVIEW_MAX) }
                : {}),
            },
          ];
        }),
      },
    ];
  });
}

/** a tool's input as a card shows it: the command or the file first, when it has one */
function detailOf(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "url", "pattern"]) {
    if (typeof input[key] === "string") return cut(input[key] as string, DETAIL_MAX);
  }
  return cut(JSON.stringify(input, null, 2), DETAIL_MAX);
}

export class ChatHost {
  private readonly o: ChatHostOptions;
  private readonly hosted = new Map<string, Hosted>();
  private reaper: NodeJS.Timeout;
  /** whether pdftoppm is on claude's PATH, looked up once: a Read of a pdf's pages needs it */
  private pdfPages?: Promise<boolean>;
  /**
   * the api refused the clearing once: no claude started from here on gets it, until grove starts
   * again. a setup that refuses it (a project's settings, a gateway) would refuse every chat's
   * first message otherwise
   */
  private clearingOff = false;
  /** the cache keeper's forks under way: one at a time */
  private keeping?: Promise<void>;
  /** the fork under way: grove quitting closes it */
  private forking?: { close(): void };
  private disposed = false;

  constructor(o: ChatHostOptions) {
    this.o = o;
    this.reaper = setInterval(() => {
      this.reap();
      void this.keep();
    }, 60_000);
    this.reaper.unref?.();
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private entry(id: string, where?: ChatWhere): Hosted {
    let h = this.hosted.get(id);
    if (!h) {
      h = {
        id,
        where: where ?? { cwd: "", dirs: [] },
        prompts: new Prompts(),
        status: emptyStatus(),
        text: "",
        dirty: null,
        waiting: new Map(),
        windows: new Set(),
        lastActive: this.now(),
        afterTurn: [],
        commands: [],
        agents: new Map(),
        tasks: new ChatTasks(),
      };
      this.hosted.set(id, h);
    } else if (where && !h.q) {
      h.where = where;
    }
    return h;
  }

  /** a claude process is up for it, or starting: grove runs it, not the editor */
  hosts(id: string): boolean {
    return !!this.hosted.get(id)?.q;
  }

  running(id: string): boolean {
    return !!this.hosted.get(id)?.status.running;
  }

  /** the sessions mid-turn: what quitting would cut short */
  busy(): string[] {
    return [...this.hosted.values()].filter((h) => h.status.running).map((h) => h.id);
  }

  status(id: string): ChatStatus {
    return this.hosted.get(id)?.status ?? emptyStatus();
  }

  text(id: string): string {
    return this.hosted.get(id)?.text ?? "";
  }

  /** what `/` offers in this session: empty until claude is up. none bound to a terminal */
  commands(id: string): ChatCommand[] {
    const h = this.hosted.get(id);
    return (h?.commands ?? []).filter((c) => !h?.terminalOnly?.has(c.name));
  }

  /** a window shows this session from now on. what it needs to catch up is `status` and `text` */
  attach(id: string, target: PushTarget): void {
    this.entry(id).windows.add(target);
  }

  detach(id: string, target: PushTarget): void {
    const h = this.hosted.get(id);
    if (!h) return;
    h.windows.delete(target);
    h.lastActive = this.now();
    if (h.windows.size === 0) this.watch(id, null);
  }

  /**
   * `file` changed on disk: its window hears of it, and its viewer reads it again. the folder is
   * watched, not the file, so a file written as a new one and renamed over it still counts. null
   * stops. the path was checked against the session's folders by the caller
   */
  watch(id: string, file: string | null): void {
    const h = this.entry(id);
    h.watching?.close();
    h.watching = undefined;
    if (!file) return;
    const name = path.basename(file);
    let soon: NodeJS.Timeout | undefined;
    try {
      h.watching = watch(path.dirname(file), (_event, changed) => {
        if (changed !== null && changed !== name) return;
        // an editor's save is several events
        clearTimeout(soon);
        soon = setTimeout(() => {
          for (const w of h.windows) this.deliver(h, w, "grove:chat:file", { path: file });
        }, 80);
      });
      h.watching.on("error", () => this.watch(id, null));
    } catch {
      // the folder went away: there is nothing to watch
    }
  }

  /** claude for this session, started now if it is not up. resolves once it is ready */
  warm(id: string, where: ChatWhere): Promise<void> {
    const h = this.entry(id, where);
    h.lastActive = this.now();
    if (h.q && h.status.live) return Promise.resolve();
    h.starting ??= this.start(h).finally(() => {
      h.starting = undefined;
    });
    return h.starting;
  }

  /** where grove keeps what is attached: the session windows' viewer shows files from it too */
  get uploads(): string {
    return this.o.uploads;
  }

  /** while a turn runs, Claude Code queues it */
  async send(
    id: string,
    where: ChatWhere,
    text: string,
    files: ChatAttachment[] = [],
  ): Promise<void> {
    const h = this.entry(id, where);
    // one after another: a message's files go on disk before it goes, and none overtakes the last
    const go = (h.sending ?? Promise.resolve()).then(async () => {
      const queued = h.status.running;
      const placed = await place(files, {
        roots: [h.where.cwd, ...h.where.dirs],
        dir: path.join(this.o.uploads, h.id),
        queued,
      });
      let pages = true;
      if (placed.some((f) => f.kind === "file" && isPdf(f))) {
        this.pdfPages ??= this.o.env().then((e) => onPath("pdftoppm", e.PATH));
        pages = await this.pdfPages;
      }
      const uuid = h.prompts.push(text, placed, pages);
      // what was said along the way belongs to the turn before
      if (!queued && h.status.notes?.length) this.set(h, { notes: [] });
      if (queued) {
        const images = files.filter((f) => f.kind === "image").length;
        const named = [
          ...(images ? [`${images} image${images === 1 ? "" : "s"}`] : []),
          ...files.flatMap((f) => (f.kind === "image" ? [] : [f.name])),
        ];
        const shown = named.length ? `${text}${text ? " " : ""}[${named.join(" · ")}]` : text;
        this.set(h, { queued: [...h.status.queued, { id: uuid, text: shown, said: text }] });
      } else this.turnStarted(h);
    });
    h.sending = go.catch(() => {});
    await go;
    await this.warm(id, where);
    if (!h.status.live) throw new Error(h.status.error ?? "Claude did not start.");
  }

  /**
   * a queued message taken back: claude drops it if it has not started on it (probe: cancelled,
   * true). false when it already had: it was folded into the turn, or ran
   */
  async unqueue(id: string, uuid: string): Promise<boolean> {
    const h = this.hosted.get(id);
    if (!h?.status.queued.some((q) => q.id === uuid && !q.taken)) return false;
    const q = h.q as (Query & { cancelAsyncMessage?: (u: string) => Promise<boolean> }) | undefined;
    const gone = (await q?.cancelAsyncMessage?.(uuid).catch(() => false)) === true;
    if (gone) this.set(h, { queued: h.status.queued.filter((x) => x.id !== uuid) });
    return gone;
  }

  /**
   * ⌃B: the tool under way goes on in the background and the turn goes on without it. only once
   * claude has it as a task: a call before that answers ok and moves nothing (probe)
   */
  async background(id: string): Promise<boolean> {
    const h = this.hosted.get(id);
    const tool = h?.status.tool;
    if (!tool?.bg || !tool.id) return false;
    return (await h?.q?.backgroundTasks(tool.id)) === true;
  }

  /**
   * a name the person gave it, as /rename gives one (probe): through its claude when one is up, which
   * counts it as the person's; else a custom-title line appended to its transcript by the sdk
   */
  async rename(id: string, where: ChatWhere, title: string): Promise<void> {
    const h = this.hosted.get(id);
    const q = h?.q as
      | (Query & { renameSession?: (t: string, s: string) => Promise<void> })
      | undefined;
    if (q?.renameSession && h?.status.live) return q.renameSession(title, id);
    const { renameSession } = await import("@anthropic-ai/claude-agent-sdk");
    await renameSession(id, title, { dir: where.cwd });
  }

  /** the files changed since a message, put back (probe: by the uuid grove stamped on it) */
  async rewind(id: string, where: ChatWhere, uuid: string, dry: boolean): Promise<ChatRewind> {
    await this.warm(id, where);
    const r = await this.hosted.get(id)?.q?.rewindFiles(uuid, { dryRun: dry });
    if (!r) return { canRewind: false, error: "Claude is not up." };
    return {
      canRewind: r.canRewind,
      ...(r.error ? { error: r.error } : {}),
      ...(r.filesChanged ? { files: r.filesChanged } : {}),
      ...(r.insertions !== undefined ? { insertions: r.insertions } : {}),
      ...(r.deletions !== undefined ? { deletions: r.deletions } : {}),
    };
  }

  /**
   * /btw: answered from what the conversation knows, beside it (probe: the answer comes in the
   * promise, only a progress frame on the stream). runtime-only in the sdk
   */
  async side(id: string, where: ChatWhere, question: string): Promise<string | null> {
    await this.warm(id, where);
    const q = this.hosted.get(id)?.q as
      | (Query & { askSideQuestion?: (q: string) => Promise<{ response: string } | null> })
      | undefined;
    if (!q?.askSideQuestion) throw new Error("This claude takes no side questions.");
    return (await q.askSideQuestion(question))?.response ?? null;
  }

  /** fast mode, this session only (probe: the flag layer takes it, getSettings().effective says so) */
  async setFast(id: string, where: ChatWhere, on: boolean): Promise<void> {
    await this.warm(id, where);
    const h = this.entry(id);
    const model = h.status.models.find(
      (m) => m.value === h.status.model || m.id === h.status.model,
    );
    if (on && !model?.fast) throw new Error("This model has no fast mode.");
    await h.q?.applyFlagSettings({ fastMode: on ? true : null } as never);
    await this.settings(h);
  }

  /**
   * thinking off and on again. only a 4.x model can answer without it (probe: haiku 4.5 off had no
   * thinking blocks); the 5.x models think regardless and bill it, so it is not offered there
   */
  async setThinking(id: string, where: ChatWhere, on: boolean): Promise<void> {
    await this.warm(id, where);
    const h = this.entry(id);
    if (!on && !thinksOff(h.status)) throw new Error("This model always thinks.");
    const summaries = await showsThinking(this.o.claudeSettings);
    await h.q?.setMaxThinkingTokens(
      on ? THINKING_BUDGET : 0,
      on && summaries ? "summarized" : null,
    );
    this.set(h, { thinkingOff: !on });
  }

  /** an output style for this session only, through the flag layer: no settings file is written */
  async setStyle(id: string, where: ChatWhere, style: string): Promise<void> {
    await this.warm(id, where);
    const h = this.entry(id);
    if (!h.status.styles?.includes(style)) throw new Error(`${style} is not an output style here.`);
    await h.q?.applyFlagSettings({ outputStyle: style } as never);
    this.set(h, { style });
  }

  /** its claude's MCP servers, as it has them now (probe: 2ms). claude is started for it */
  async mcp(
    id: string,
    where: ChatWhere,
  ): Promise<Array<{ name: string; status: string; error?: string }>> {
    await this.warm(id, where);
    const list = (await this.hosted.get(id)?.q?.mcpServerStatus()) ?? [];
    return list.map((m) => ({
      name: m.name,
      status: m.status,
      ...(m.error ? { error: firstSentence(m.error, 200) } : {}),
    }));
  }

  async mcpReconnect(id: string, name: string): Promise<void> {
    await this.hosted.get(id)?.q?.reconnectMcpServer(name);
  }

  /** what a session grove hosts left running, from its stream. undefined: no claude is up for it */
  tasks(id: string): readonly ChatTask[] | undefined {
    const h = this.hosted.get(id);
    return h?.q ? h.tasks.tasks : undefined;
  }

  /** a background command or a Monitor stops. a wake-up has no stop: claude's own CronDelete is */
  async stopTask(id: string, taskId: string): Promise<void> {
    const h = this.hosted.get(id);
    const t = h?.tasks.tasks.find((x) => x.id === taskId);
    if (t?.kind !== "command") throw new Error("That is not running.");
    await h?.q?.stopTask(taskId);
  }

  /** one running subagent stops. the turn and the other agents go on */
  async stopAgent(id: string, agentId: string): Promise<void> {
    const h = this.hosted.get(id);
    const a = h?.agents.get(agentId);
    if (a?.state !== "running") throw new Error("That agent is not running.");
    // a workflow's agent has no task of its own: the workflow is what stops
    if (a.workflow) throw new Error("Stop the workflow it is part of.");
    await h?.q?.stopTask(agentId);
  }

  async interrupt(id: string): Promise<void> {
    await this.hosted.get(id)?.q?.interrupt();
  }

  async setMode(id: string, where: ChatWhere, mode: ChatMode): Promise<void> {
    await this.warm(id, where);
    const h = this.entry(id);
    if (!h.status.modes.includes(mode)) throw new Error(`${mode} is not on offer in this session.`);
    await h.q?.setPermissionMode(mode);
    this.set(h, { mode });
  }

  async setModel(id: string, model: string): Promise<void> {
    const h = this.entry(id);
    h.picked = model;
    if (!h.q) {
      // picked before claude is up: it starts on it
      h.model = model;
      this.set(h, { model });
      return;
    }
    await h.q.setModel(model);
    // a model that always thinks: the switch is not there for it
    this.set(h, {
      model,
      ...(h.status.thinkingOff && !thinksOff({ ...h.status, model }) ? { thinkingOff: false } : {}),
    });
    // the model moves effort to its own default, and ultracode off where it has none
    await this.settings(h);
  }

  /** from the next turn. ultracode stays on: an effort sent alone would turn it off */
  async setEffort(id: string, where: ChatWhere, level: string): Promise<void> {
    await this.warm(id, where);
    const h = this.entry(id);
    const model = h.status.models.find(
      (m) => m.value === h.status.model || m.id === h.status.model,
    );
    // a level the model does not list is answered ok and changes nothing: refused here instead
    if (!model?.efforts?.includes(level))
      throw new Error(`${level} is not an effort this model takes.`);
    await h.q?.applyFlagSettings({
      effortLevel: level as EffortLevel,
      ...(h.status.ultracode ? { ultracode: true } : {}),
    });
    await this.settings(h);
  }

  async setUltracode(id: string, where: ChatWhere, on: boolean): Promise<void> {
    await this.warm(id, where);
    const h = this.entry(id);
    await h.q?.applyFlagSettings({ ultracode: on ? true : null });
    await this.settings(h);
    // the ack says ok on a model without it, and leaves it off: say so
    if (on && !h.status.ultracode) throw new Error("This model does not take ultracode.");
  }

  answer(id: string, askId: string, a: ChatAnswer): void {
    const h = this.hosted.get(id);
    const w = h?.waiting.get(askId);
    if (!h || !w) throw new Error("That question has already been answered.");
    const ask = h.status.asks.find((x) => x.id === askId);
    if (a.kind === "elicit") {
      if (!w.elicit || ask?.kind !== "elicit")
        throw new Error("That answer is for another kind of question.");
      // only the fields it asked for, each as its kind
      const content =
        a.action === "accept" && a.content
          ? Object.fromEntries(
              ask.fields.flatMap((f) => {
                const v = a.content?.[f.key];
                if (v === undefined) return [];
                const ok =
                  (f.type === "boolean" && typeof v === "boolean") ||
                  (f.type === "number" && typeof v === "number") ||
                  (f.type === "string" && typeof v === "string") ||
                  (f.type === "enum" && typeof v === "string" && !!f.options?.includes(v));
                return ok ? [[f.key, v]] : [];
              }),
            )
          : undefined;
      h.waiting.delete(askId);
      this.set(h, { asks: h.status.asks.filter((x) => x.id !== askId) });
      w.elicit({ action: a.action, ...(content ? { content } : {}) });
      return;
    }
    if (a.kind === "dialog") {
      if (!w.dialog) throw new Error("That answer is for another kind of question.");
      const picks: Record<string, readonly string[]> = {
        refusal: ["retry_fallback", "edit_prompt"],
        "auto-fallback": ["continue", "interrupt"],
      };
      if (a.choice && !picks[ask?.kind ?? ""]?.includes(a.choice))
        throw new Error("That is not one of its buttons.");
      h.waiting.delete(askId);
      this.set(h, { asks: h.status.asks.filter((x) => x.id !== askId) });
      w.dialog(a.choice ? { behavior: "completed", result: a.choice } : { behavior: "cancelled" });
      return;
    }
    if (ask?.kind !== a.kind) throw new Error("That answer is for another kind of question.");
    let result: PermissionResult;
    if (a.kind === "question") {
      // the preview of a picked option goes with it, as Claude Code sends it: claude reads which
      // mockup was chosen, not only its label
      const annotations: Record<string, { preview: string }> = {};
      for (const q of questionsOf(w.input)) {
        const preview = q.options.find((o) => o.label === a.answers[q.question])?.preview;
        if (preview) annotations[q.question] = { preview };
      }
      result = {
        behavior: "allow",
        updatedInput: {
          ...w.input,
          answers: a.answers,
          ...(Object.keys(annotations).length ? { annotations } : {}),
        },
      };
    } else if (a.kind === "plan") {
      if (a.mode && !h.status.modes.includes(a.mode))
        throw new Error(`${a.mode} is not on offer in this session.`);
      // the mode rides on the allow: a setPermissionMode after it would race the next tool call
      result = a.approve
        ? {
            behavior: "allow",
            updatedInput: w.input,
            ...(a.mode
              ? { updatedPermissions: [{ type: "setMode", mode: a.mode, destination: "session" }] }
              : {}),
          }
        : { behavior: "deny", message: a.message?.trim() || "Keep planning." };
    } else if (a.allow === "no") {
      result = { behavior: "deny", message: a.message?.trim() || "The user declined this." };
    } else {
      result = {
        behavior: "allow",
        updatedInput: w.input,
        ...(a.allow === "always" && w.suggestions ? { updatedPermissions: w.suggestions } : {}),
      };
    }
    this.settle(h, askId, result);
  }

  /** runs once the turn under way has ended, or now when none is */
  afterTurn(id: string, run: () => void): void {
    const h = this.hosted.get(id);
    if (h?.status.running) h.afterTurn.push(run);
    else run();
  }

  /**
   * lets the session go: claude is stopped, mid-turn or not, and nothing of it is left here but
   * the windows still looking at it. resolves once the process has gone
   */
  async release(id: string): Promise<void> {
    const h = this.hosted.get(id);
    if (!h?.q) return;
    if (h.status.running) {
      // stopped as Esc stops it, so the transcript ends the turn on an interrupt and not on a
      // process that vanished. a claude that does not answer is let go anyway
      const ended = new Promise<void>((r) => h.afterTurn.push(r));
      await h.q.interrupt().catch(() => {});
      await Promise.race([ended, new Promise((r) => setTimeout(r, RELEASE_WAIT_MS))]);
    }
    h.q?.close();
    await h.ended;
  }

  dispose(): void {
    this.disposed = true;
    this.forking?.close();
    clearInterval(this.reaper);
    // before the close: its SessionEnd can land while the app still drains
    const up = [...this.hosted.values()].filter((h) => h.q).map((h) => h.id);
    if (up.length > 0) this.o.letGo?.(up);
    for (const h of this.hosted.values()) {
      h.q?.close();
      h.watching?.close();
    }
  }

  // ---------- inside

  /** called every minute. a test calls it itself */
  reap(): void {
    const now = this.now();
    const idle = [...this.hosted.values()].filter(
      // one watching something (a Monitor, a /loop's wake-up) would stop with it
      (h) =>
        h.q &&
        !h.status.running &&
        h.windows.size === 0 &&
        now - h.lastActive > REAP_MS &&
        h.tasks.tasks.length === 0,
    );
    if (idle.length > 0) this.o.letGo?.(idle.map((h) => h.id));
    for (const h of idle) h.q?.close();
  }

  /**
   * what a session's claude is started with that is in its prompt's cached prefix: the system
   * prompt, the tools, the folders, thinking and the env. a start and the cache keeper's fork both
   * build on it, so a fork reads the cache the session wrote (probe: read 148,904 of ~149k, wrote 0)
   */
  private async launch(h: Hosted): Promise<{
    query: typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    options: Options;
    clearing: boolean;
  }> {
    // only here: with grove chat off the sdk is never even loaded
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const [bin, env, summaries, settings] = await Promise.all([
      this.o.claudeBin(),
      this.o.env(),
      showsThinking(this.o.claudeSettings),
      settingsEnv(this.o.claudeSettings),
      // claude is told of it at launch: a folder added later has to be under one it knows
      mkdir(this.o.uploads, { recursive: true }),
    ]);
    const clearing = this.clearingOff ? {} : clearingEnv(env, settings);
    return {
      query,
      clearing: clearing.CLAUDE_CODE_EXTRA_BODY !== undefined,
      options: {
        pathToClaudeCodeExecutable: bin,
        cwd: h.where.cwd,
        // grove's uploads too: a Read of an attached file never asks, in any mode
        additionalDirectories: [...h.where.dirs, this.o.uploads],
        // CLAUDE.md, skills, hooks and the project's settings, as everywhere else. no mode: the
        // settings' defaultMode decides, as it does in the terminal
        settingSources: ["user", "project", "local"],
        // claude code's own prompt, as the vs code extension passes it. left out, the sdk sends an
        // empty one and the session runs without claude code's instructions
        systemPrompt: { type: "preset", preset: "claude_code" },
        // what the vs code extension starts every session with. checkpoints make grove's turns
        // rewindable later. the stop affordance keeps a stop from killing background agents:
        // each one is stopped from its own row
        enableFileCheckpointing: true,
        perTaskStopAffordance: true,
        // an option's preview in markdown, as the terminal shows it: the card draws it beside the
        // list, never as html. it is in AskUserQuestion's description, so in the prefix
        toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
        thinking: {
          type: "enabled",
          budgetTokens: THINKING_BUDGET,
          ...(summaries ? { display: "summarized" as const } : {}),
        },
        includePartialMessages: true,
        // claude's environment, and grove's own setting for claude code over it: the api clears
        // old reads out of context
        env: { ...hostEnv(env), ...clearing },
        supportedDialogKinds: DIALOG_KINDS,
        stderr: (data) => log.warn(`chat ${h.id.slice(0, 8)}:`, data.trimEnd()),
      },
    };
  }

  /**
   * the cache keeper, from the reaper's tick: the sessions due a fork, one at a time. a closed
   * window or a reaped claude does not stop it, a real turn starts its clock again
   */
  keep(): Promise<void> {
    if (this.keeping) return this.keeping;
    const hours = keepHours(this.o.keepWarmHours?.());
    const now = this.now();
    const due = [...this.hosted.values()].filter((h) =>
      keepDue(
        {
          lastTurn: h.lastTurn,
          lastWarm: h.lastWarm,
          running: h.status.running || h.status.starting,
          warming: false,
          off: h.keepOff === true,
          context: h.status.context?.used ?? 0,
        },
        now,
        hours,
      ),
    );
    if (due.length === 0) return Promise.resolve();
    this.keeping = (async () => {
      for (const h of due) {
        if (this.disposed) break;
        await this.warmCache(h).catch((e) => log.warn(`chat ${h.id.slice(0, 8)}: keep warm`, e));
      }
    })().finally(() => {
      this.keeping = undefined;
    });
    return this.keeping;
  }

  /** one fork that reads the session's cached prefix and goes as its request starts */
  private async warmCache(h: Hosted): Promise<void> {
    // at the try, not the read: a fork that fails is tried again in ~55 minutes, not each tick
    h.lastWarm = this.now();
    const { query, options } = await this.launch(h);
    const run = this.o.fork ?? query;
    const q = run({
      prompt: KEEP_PROMPT,
      options: {
        ...options,
        ...forkOptions(h.id, { ...h.status, model: h.picked }),
        stderr: () => {},
      },
    });
    const read: ForkRead = {};
    const timer = setTimeout(() => q.close(), KEEP_TIMEOUT_MS);
    this.forking = q;
    try {
      // leaving the for-await closes it: no reply is written, no tool runs
      for await (const m of q) if (readFork(read, m)) break;
    } finally {
      clearTimeout(timer);
      this.forking = undefined;
      q.close();
    }
    const claudeDir = this.o.projectsDir && path.dirname(this.o.projectsDir);
    // never the session's own: a fork that came up under its id would take its checkpoints
    if (read.fork && read.fork !== h.id && claudeDir) await sweepFork(claudeDir, read.fork);
    const id = h.id.slice(0, 8);
    if (!read.usage) {
      log.warn(`chat ${id}: keep warm fork ended before its request`);
      return;
    }
    log.info(`chat ${id}: kept warm, cache read ${read.usage.read}, write ${read.usage.write}`);
    if (read.usage.write > KEEP_MISS_TOKENS) {
      // the prefix did not match: forking again would write it again each time
      h.keepOff = true;
      log.warn(
        `chat ${id}: keep warm missed the cache (wrote ${read.usage.write}), not kept again`,
      );
    }
  }

  private async start(h: Hosted): Promise<void> {
    this.set(h, { starting: true, error: undefined });
    let q: Query | undefined;
    try {
      const { query, options, clearing } = await this.launch(h);
      h.clearing = clearing;
      if (!h.model && h.where.fresh && h.where.model) h.picked = h.where.model;
      q = query({
        prompt: h.prompts,
        options: {
          ...options,
          // a session grove made has no transcript to resume yet: claude starts one under its id
          ...(h.where.fresh ? { sessionId: h.id } : { resume: h.id }),
          // a pick in the window's menu, else the project's, for a session it starts
          ...(h.model
            ? { model: h.model }
            : h.where.fresh && h.where.model
              ? { model: h.where.model }
              : {}),
          ...(h.where.fresh && h.where.effort ? { effort: h.where.effort } : {}),
          // each turn's Stop says its wake-ups and crons whole (session_crons): no frame does.
          // never throws and answers at once, or the turn's end would wait on it
          hooks: {
            Stop: [
              {
                hooks: [
                  async (input) => {
                    try {
                      if (h.tasks.stop(input, this.now())) this.tasksChanged(h);
                    } catch (e) {
                      log.warn(`chat ${h.id.slice(0, 8)}: stop hook`, e);
                    }
                    return {};
                  },
                ],
              },
            ],
          },
          canUseTool: (tool, input, opts) => this.ask(h, tool, input, opts),
          // a refusal's fallback and auto's billed classifier come as cards, as in vs code
          onUserDialog: (req, opts) => this.dialog(h, req, opts.signal),
          // an MCP server's form or sign-in page: a card, not a silent decline
          onElicitation: (req, opts) => this.elicit(h, req, opts.signal),
          supportedDialogKinds: DIALOG_KINDS,
          stderr: (data) => log.warn(`chat ${h.id.slice(0, 8)}:`, data.trimEnd()),
        },
      });
      h.q = q;
      h.ended = this.pump(h, q);
      const init = await q.initializationResult();
      const mode = asMode((init as { current_permission_mode?: unknown }).current_permission_mode);
      h.commands = commandsOf(init.commands);
      this.set(h, {
        live: true,
        starting: false,
        mode,
        modes: modesFor(mode),
        models: (init.models ?? []).map((m) => ({
          value: m.value,
          label: m.displayName,
          ...(m.resolvedModel ? { id: m.resolvedModel } : {}),
          ...(m.description ? { description: m.description } : {}),
          ...(m.supportedEffortLevels?.length ? { efforts: [...m.supportedEffortLevels] } : {}),
          ...(m.supportsFastMode ? { fast: true } : {}),
        })),
        // the output styles there are, and the one it is in (init's answer, probe)
        ...stylesOf(init),
      });
      await this.settings(h);
      // a resumed session is as full as it was: the ring knows before the first turn
      await this.contextUsage(h);
    } catch (e) {
      log.warn(`chat ${h.id.slice(0, 8)} did not start:`, e);
      // what was sent goes back to the window, which puts it in the composer again. kept here too
      // it would go out twice with the next start. a query that did start lets go of it as it ends
      if (!q) h.prompts = new Prompts();
      q?.close();
      this.set(h, { starting: false, live: false, running: false, error: messageOf(e) });
    }
    this.o.onChange?.();
  }

  /** one loop for the whole life of the query. leaving a for-await would close it */
  private async pump(h: Hosted, q: Query): Promise<void> {
    try {
      for await (const m of q) this.take(h, m);
    } catch (e) {
      if (h.q === q) this.set(h, { error: messageOf(e) });
    }
    if (h.q !== q) return;
    // the process is gone: what it was asked dies with it, and the next send starts another
    h.q = undefined;
    h.prompts = new Prompts();
    for (const w of h.waiting.values()) w.resolve({ behavior: "deny", message: "Stopped." });
    h.waiting.clear();
    h.text = "";
    h.dirty = 0;
    // its agents ran inside it, and what it left running
    h.tasks.clear();
    for (const a of h.agents.values()) {
      if (a.state === "running") h.agents.set(a.id, { ...a, state: "stopped", ended: this.now() });
    }
    const after = h.afterTurn.splice(0);
    this.set(h, {
      live: false,
      starting: false,
      running: false,
      since: undefined,
      asks: [],
      tool: undefined,
      activity: undefined,
      thinking: undefined,
      queued: [],
      agents: [...h.agents.values()],
      tasks: [],
      rev: h.status.rev + 1,
    });
    this.flushNow(h);
    this.o.onChange?.();
    for (const run of after) run();
  }

  private take(h: Hosted, m: SDKMessage): void {
    h.lastActive = this.now();
    // first: a wake-up firing is a command_lifecycle frame with no queued row, returned from below
    if (h.tasks.take(m, h.lastActive)) this.tasksChanged(h);
    // what became of a message sent while a turn ran (probe): queued, then started (folded into
    // the turn, where the transcript shows it), completed, or cancelled. not in the sdk's types.
    // taken, its row stays as sent until the window reads it from the transcript: a read follows
    const life = m as unknown as { type: string; command_uuid?: string; state?: string };
    if (life.type === "command_lifecycle") {
      const row = h.status.queued.find((q) => q.id === life.command_uuid);
      if (!row || life.state === "queued") return;
      const taken = life.state === "started" || life.state === "completed";
      if (taken && row.taken) return;
      this.set(h, {
        queued: taken
          ? h.status.queued.map((q) => (q === row ? { ...q, taken: true } : q))
          : h.status.queued.filter((q) => q !== row),
        rev: h.status.rev + 1,
      });
      return;
    }
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          // the commands that only make sense in a terminal (exit, statusline...): `/` leaves them out
          h.terminalOnly = new Set(m.terminal_slash_commands ?? []);
          // every turn starts with one, a turn claude code started itself too: a queued message, a
          // background task that finished
          this.turnStarted(h);
          this.set(h, {
            mode: asMode(m.permissionMode) ?? h.status.mode,
            model: modelFor(h.status, m.model),
          });
        } else if (m.subtype === "commands_changed") {
          h.commands = commandsOf(m.commands);
        } else if (m.subtype === "status") {
          const mode = asMode(m.permissionMode);
          if (mode && mode !== h.status.mode) this.set(h, { mode });
          if (m.status === "compacting") this.set(h, { activity: "Compacting the conversation" });
          else if (h.status.activity) this.set(h, { activity: undefined });
        } else if (m.subtype === "api_retry") {
          this.set(h, { activity: retryLine(m) });
        } else if (m.subtype === "permission_denied") {
          // turned down without asking (don't ask, auto): nothing would say so otherwise
          const why = firstSentence(m.decision_reason || m.message, 200);
          const text = `${toolLabel(m.tool_name)} was turned down. ${why}`;
          if (
            m.decision_reason_type === "classifier" &&
            /unavailable/i.test(`${m.decision_reason} ${m.message}`)
          )
            void this.checkFailed(h, toolLabel(m.tool_name), text);
          else this.note(h, { kind: "denied", text });
        } else if (m.subtype === "model_refusal_fallback") {
          // the model turned it down and the turn ran again on another
          if (m.scope !== "local") {
            this.note(h, {
              kind: "info",
              text: `${m.original_model} turned this down, so ${m.fallback_model} answered it.`,
            });
          }
        } else if (m.subtype === "model_refusal_no_fallback") {
          this.note(h, { kind: "denied", text: `${m.original_model} turned this request down.` });
        } else if (m.subtype === "local_command_output") {
          this.note(h, { kind: "output", text: cut(m.content, 8000) });
        } else if (m.subtype === "informational") {
          // 'info' is for a transcript view, not a chat
          if (m.level !== "info") this.note(h, { kind: "info", text: cut(m.content, 2000) });
        } else if (
          m.subtype === "task_started" ||
          m.subtype === "task_progress" ||
          m.subtype === "task_updated" ||
          m.subtype === "task_notification" ||
          m.subtype === "background_tasks_changed"
        ) {
          this.task(h, m);
        }
        return;
      case "rate_limit_event": {
        // only worth a word when it is close or hit
        const r = m.rate_limit_info;
        const state =
          r.status === "allowed_warning"
            ? "warning"
            : r.status === "rejected"
              ? "rejected"
              : undefined;
        const limit: ChatStatus["limit"] = state && {
          state,
          window: LIMIT_WINDOW[r.rateLimitType ?? ""] ?? "usage limit",
          ...(typeof r.utilization === "number" ? { used: r.utilization } : {}),
          ...(typeof r.resetsAt === "number" ? { resets: r.resetsAt * 1000 } : {}),
        };
        if (limit || h.status.limit) this.set(h, { limit });
        return;
      }
      case "conversation_reset": {
        // /clear: this claude goes on as a new session. what the window shows moves with it
        if (m.new_conversation_id === h.id) return;
        const from = h.id;
        this.hosted.delete(from);
        h.id = m.new_conversation_id;
        this.hosted.set(h.id, h);
        this.set(h, { notes: [], rev: h.status.rev + 1 });
        this.o.onReset?.(from, h.id, { ...h.where, fresh: true });
        this.o.onChange?.();
        return;
      }
      case "stream_event": {
        // a subagent's stream is its own. the turn's own answer is what the window draws
        if (m.parent_tool_use_id) return;
        this.turnStarted(h);
        // something is coming back: a retry or a compaction is over
        if (h.status.activity) this.set(h, { activity: undefined });
        const ev = m.event;
        if (ev.type === "content_block_start") {
          if (ev.content_block.type === "thinking" && !h.status.thinking) {
            this.set(h, { thinking: { since: this.now() } });
          }
          if (ev.content_block.type === "text") this.setText(h, "");
          else if (ev.content_block.type === "tool_use")
            this.set(h, { tool: { name: ev.content_block.name, since: this.now() } });
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          this.setText(h, h.text + ev.delta.text);
        }
        return;
      }
      case "assistant": {
        // a whole message: it is in the transcript now
        if (m.parent_tool_use_id) return;
        this.setText(h, "");
        // a call's input is whole once its block is: what it acts on, for the live line
        const call = m.message.content.findLast((b) => b.type === "tool_use");
        const tool =
          call?.type === "tool_use"
            ? {
                name: call.name,
                target: toolTarget(call.name, call.input, h.where.cwd, os.homedir()),
                since: h.status.tool?.name === call.name ? h.status.tool.since : this.now(),
                id: call.id,
              }
            : h.status.tool;
        // a thinking block is whole: it is in the transcript, and the turn's thinking row has it
        const thought = m.message.content.some((b) => b.type === "thinking");
        this.set(h, {
          tool,
          ...(thought ? { thinking: undefined } : {}),
          rev: h.status.rev + 1,
        });
        return;
      }
      case "user":
        if (m.parent_tool_use_id) return;
        this.set(h, { tool: undefined, rev: h.status.rev + 1 });
        return;
      case "result": {
        // an interrupt ends like this too, as error_during_execution: it is still a turn's end.
        // the sdk keeps claude's own idle/running states to itself, so this is the end
        this.setText(h, "");
        this.set(h, {
          running: false,
          since: undefined,
          tool: undefined,
          activity: undefined,
          thinking: undefined,
          // taken in this turn: the transcript has had it a while. still queued: it runs as the
          // next turn, and is that turn's prompt once it starts
          queued: h.status.queued.flatMap((q) => (q.taken ? [] : [{ ...q, taken: true }])),
          rev: h.status.rev + 1,
        });
        this.o.onChange?.();
        for (const run of h.afterTurn.splice(0)) run();
        // the cache keeper's clock starts again. the turn wrote its prefix, so a miss is forgotten
        h.lastTurn = this.now();
        h.keepOff = false;
        void this.contextUsage(h);
        if (h.clearing && refusedClearing(m)) void this.unclear(h);
        return;
      }
    }
  }

  /**
   * the api refused the extra body, and refuses every request of this claude the same way: it is
   * started again without it, on the same session. the turn that failed has its "Try again"
   */
  private async unclear(h: Hosted): Promise<void> {
    this.clearingOff = true;
    log.warn(`chat ${h.id.slice(0, 8)}: the api refused clearing old reads, restarting without it`);
    h.q?.close();
    await h.ended;
    // a session grove made has its transcript now: the failed turn is in it, so it resumes
    h.where = { ...h.where, fresh: false };
    await this.warm(h.id, h.where).catch(() => {});
    // after the start: it clears the error line
    if (h.status.live) this.set(h, { error: CLEARING_REFUSED });
  }

  /**
   * auto mode's check failed, and claude code says only that its model is unavailable: the api's
   * own error is in the file it left in the session's folder. one about the extra body fails every
   * check the same way, so claude starts again without it once the turn is over
   */
  private async checkFailed(h: Hosted, tool: string, otherwise: string): Promise<void> {
    const error = await this.lastCheckError(h.id);
    this.note(h, {
      kind: "denied",
      text: error
        ? `${tool} was turned down: auto mode's check failed. The API said ${error}`
        : otherwise,
    });
    if (!error || !h.clearing || !refusedClearingCheck(error)) return;
    // once, however many checks fail before the turn ends
    h.clearing = false;
    // a message sent meanwhile runs as the next turn: closing this claude would lose it
    const restart = () => {
      if (h.status.running || h.status.queued.length) h.afterTurn.push(restart);
      else void this.unclear(h);
    };
    restart();
  }

  /** the error of a check that just failed, from the session's folder under any project */
  private async lastCheckError(id: string): Promise<string | undefined> {
    const dir = this.o.projectsDir;
    if (!dir) return undefined;
    for (const project of await readdir(dir).catch(() => [])) {
      const file = path.join(dir, project, id, CLASSIFIER_ERROR_FILE);
      const at = await stat(file).catch(() => undefined);
      // an old one is some earlier check's
      if (!at || Date.now() - at.mtimeMs > 60_000) continue;
      return classifierError(await readFile(file, "utf8").catch(() => ""));
    }
    return undefined;
  }

  /**
   * how full the conversation is, from claude's own count: the summary answers from the last
   * response's usage in ~30ms (probe) with no token-count call. a turn's result usage can't be used:
   * it is summed over every request of the turn
   */
  private async contextUsage(h: Hosted): Promise<void> {
    const u = await h.q?.getContextUsage({ detail: "summary" }).catch(() => undefined);
    if (typeof u?.totalTokens !== "number") return;
    const limit = u.autoCompactThreshold ?? u.maxTokens;
    if (typeof limit === "number" && limit > 0)
      this.set(h, { context: { used: u.totalTokens, limit } });
  }

  /** a line of what claude said along the way, under the turn. the last few */
  private note(h: Hosted, n: ChatNote): void {
    this.set(h, { notes: [...(h.status.notes ?? []), n].slice(-NOTES_MAX) });
  }

  /** the pane's rows, and the main window's: a row there reads ChatHost.tasks */
  private tasksChanged(h: Hosted): void {
    this.set(h, {
      tasks: h.tasks.tasks.map((t) => ({
        ...taskView(t, undefined),
        ...(t.monitor ? { monitor: true as const } : {}),
        ...(t.recurring ? { recurring: true as const } : {}),
        ...(t.command ? { command: t.command.slice(0, 300) } : {}),
      })),
    });
    this.o.onChange?.();
    clearTimeout(h.taskMinute);
    const now = this.now();
    const next = Math.min(
      ...h.tasks.tasks
        .filter((t) => t.kind === "command" && now - t.since < TASK_MIN_MS)
        .map((t) => t.since + TASK_MIN_MS - now),
    );
    if (Number.isFinite(next)) h.taskMinute = setTimeout(() => this.o.onChange?.(), next + 50);
  }

  /**
   * a subagent's life, from the task frames: started, its progress line, its end. a task id is
   * its agent id (probe). only agents: a Bash is a step of the turn, not a task to list
   */
  private task(
    h: Hosted,
    m: Extract<
      SDKMessage,
      {
        subtype:
          | "task_started"
          | "task_progress"
          | "task_updated"
          | "task_notification"
          | "background_tasks_changed";
      }
    >,
  ): void {
    const now = this.now();
    // the tool under way became a foreground task (~3s in, probe): it can go to the background now.
    // sent there (by anyone), it no longer can
    const tool = h.status.tool;
    if (
      m.subtype === "task_started" &&
      m.is_backgrounded === false &&
      tool?.id &&
      tool.id === m.tool_use_id
    ) {
      h.toolTask = m.task_id;
      this.set(h, { tool: { ...tool, bg: true } });
    } else if (
      m.subtype === "task_updated" &&
      m.patch.is_backgrounded === true &&
      tool?.bg &&
      m.task_id === h.toolTask
    ) {
      this.set(h, { tool: { ...tool, bg: false } });
    }
    const put = (a: ChatAgent) => h.agents.set(a.id, a);
    /** a workflow's end is its running agents' too: no progress snapshot comes after a stop (probe) */
    const end = (a: ChatAgent, state: ChatAgent["state"]) => {
      put({ ...a, state, ended: a.ended ?? now });
      if (a.kind !== "workflow") return;
      for (const c of h.agents.values()) {
        if (c.workflow === a.id && c.state === "running")
          put({ ...c, state: state === "done" ? "done" : "stopped", ended: now });
      }
    };
    if (m.subtype === "task_started") {
      // a Workflow is one task: its agents only show in its progress frames
      const workflow = m.task_type === "local_workflow";
      if (m.task_type !== "local_agent" && !workflow) return;
      put({
        id: m.task_id,
        description: m.description || m.workflow_name || "Workflow",
        ...(m.subagent_type ? { agentType: m.subagent_type } : {}),
        ...(m.tool_use_id ? { toolUseId: m.tool_use_id } : {}),
        ...(m.is_backgrounded || workflow ? { background: true } : {}),
        ...(workflow ? { kind: "workflow" as const } : {}),
        state: "running",
        since: now,
      });
    } else if (m.subtype === "background_tasks_changed") {
      // every live background task, whole: one this process started before it heard of it is
      // added, one it still thought running and is not in the set any more is over
      const live = new Set(m.tasks.map((t) => t.task_id));
      for (const t of m.tasks) {
        const workflow = t.task_type === "local_workflow";
        if ((t.task_type === "local_agent" || workflow) && !h.agents.has(t.task_id)) {
          put({
            id: t.task_id,
            description: t.description,
            ...(t.subagent_type ? { agentType: t.subagent_type } : {}),
            ...(workflow ? { kind: "workflow" as const, background: true } : {}),
            state: "running",
            since: now,
          });
        }
      }
      for (const a of h.agents.values()) {
        if (a.state === "running" && a.background && !live.has(a.id)) end(a, "done");
      }
    } else {
      const a = h.agents.get(m.task_id);
      if (!a) return;
      if (m.subtype === "task_progress") {
        if (a.kind === "workflow") {
          const progress = (m as { workflow_progress?: unknown }).workflow_progress;
          for (const c of workflowAgents(a.id, progress, h.agents, now)) put(c);
        } else put({ ...a, step: m.summary || m.description });
      } else if (m.subtype === "task_updated") {
        const state = TASK_STATE[m.patch.status ?? ""];
        if (m.patch.is_backgrounded !== undefined)
          put({ ...a, background: m.patch.is_backgrounded });
        if (state) end(h.agents.get(a.id) ?? a, state);
      } else {
        end(a, TASK_STATE[m.status] ?? "done");
      }
    }
    this.set(h, { agents: [...h.agents.values()] });
  }

  /**
   * effort and ultracode as claude applies them. no frame announces a change and an apply's ack
   * can't be trusted, so this is read again after every apply and every model change. getSettings
   * is in the sdk at runtime but not in its types
   */
  private async settings(h: Hosted): Promise<void> {
    const q = h.q as
      | (Query & {
          getSettings?: () => Promise<{ applied?: Applied; effective?: { fastMode?: unknown } }>;
        })
      | undefined;
    const got = await q?.getSettings?.().catch(() => undefined);
    const a = got?.applied;
    if (!a) return;
    this.set(h, {
      fast: got?.effective?.fastMode === true,
      // the model it is on before a turn has said so
      ...(typeof a.model === "string" && a.model ? { model: modelFor(h.status, a.model) } : {}),
      effort: typeof a.effort === "string" ? a.effort : undefined,
      ultracode: a.ultracode === true,
      ultracodeAvailable: a.ultracodeAvailable === true,
    });
  }

  private turnStarted(h: Hosted): void {
    if (h.status.running) return;
    this.set(h, {
      running: true,
      since: this.now(),
      // said once, for the turn that failed
      ...(h.status.error === CLEARING_REFUSED ? { error: undefined } : {}),
    });
    this.o.onChange?.();
  }

  private ask(
    h: Hosted,
    tool: string,
    input: Record<string, unknown>,
    opts: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const id = randomUUID();
    const view: ChatAsk =
      tool === "AskUserQuestion"
        ? { id, kind: "question", questions: questionsOf(input) }
        : tool === "ExitPlanMode"
          ? { id, kind: "plan", plan: typeof input.plan === "string" ? input.plan : "" }
          : {
              id,
              kind: "permission",
              tool,
              ...(opts.title ? { title: opts.title } : {}),
              detail: detailOf(input),
              ...(editDiff(tool, input) ? { diff: editDiff(tool, input) } : {}),
              canAlways: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
              // a subagent's call: the card names which one
              ...(opts.agentID
                ? { agent: h.agents.get(opts.agentID)?.description ?? "An agent" }
                : {}),
            };
    return new Promise<PermissionResult>((resolve) => {
      h.waiting.set(id, { input, suggestions: opts.suggestions, resolve });
      this.set(h, { asks: [...h.status.asks, view] });
      // Claude Code took the question back: an interrupt, the turn moved on
      opts.signal.addEventListener("abort", () =>
        this.settle(h, id, { behavior: "deny", message: "Cancelled." }),
      );
    });
  }

  /** a dialog claude code wants drawn: a card like an ask, its button the answer */
  private dialog(
    h: Hosted,
    req: UserDialogRequest,
    signal: AbortSignal,
  ): Promise<UserDialogResult> {
    const id = randomUUID();
    const view = dialogOf(id, req.dialogKind, req.payload ?? {});
    // a kind or a shape grove does not know: claude does what it does with no dialog
    if (!view) return Promise.resolve({ behavior: "cancelled" });
    return new Promise<UserDialogResult>((resolve) => {
      h.waiting.set(id, {
        input: {},
        resolve: () => resolve({ behavior: "cancelled" }),
        dialog: resolve,
      });
      this.set(h, { asks: [...h.status.asks, view] });
      signal.addEventListener("abort", () => {
        if (!h.waiting.delete(id)) return;
        this.set(h, { asks: h.status.asks.filter((a) => a.id !== id) });
        resolve({ behavior: "cancelled" });
      });
    });
  }

  private elicit(
    h: Hosted,
    req: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<ElicitationResult> {
    const id = randomUUID();
    const view = elicitOf(id, req);
    // a form grove cannot draw: turned down, as with no host at all
    if (!view) return Promise.resolve({ action: "decline" });
    return new Promise<ElicitationResult>((resolve) => {
      h.waiting.set(id, {
        input: {},
        resolve: () => resolve({ action: "cancel" }),
        elicit: resolve,
      });
      this.set(h, { asks: [...h.status.asks, view] });
      signal.addEventListener("abort", () => {
        if (!h.waiting.delete(id)) return;
        this.set(h, { asks: h.status.asks.filter((a) => a.id !== id) });
        resolve({ action: "cancel" });
      });
    });
  }

  private settle(h: Hosted, askId: string, result: PermissionResult): void {
    const w = h.waiting.get(askId);
    if (!w) return;
    h.waiting.delete(askId);
    this.set(h, { asks: h.status.asks.filter((a) => a.id !== askId) });
    w.resolve(result);
  }

  private set(h: Hosted, patch: Partial<ChatStatus>): void {
    const card = cardOf(h.status.asks);
    h.status = { ...h.status, ...patch };
    for (const w of h.windows) this.deliver(h, w, "grove:chat:status", h.status);
    this.o.onStatus?.(h.id, h.status);
    // every way a card comes or goes passes here: its answer, its abort, its claude going
    const now = cardOf(h.status.asks);
    if (now !== card) this.o.onCard?.(h.id, now);
  }

  private setText(h: Hosted, text: string): void {
    if (text === h.text) return;
    const from = text.startsWith(h.text) ? h.text.length : 0;
    h.text = text;
    h.dirty = Math.min(h.dirty ?? from, from);
    h.flush ??= setTimeout(() => this.flushNow(h), FLUSH_MS);
  }

  private flushNow(h: Hosted): void {
    if (h.flush) clearTimeout(h.flush);
    h.flush = undefined;
    if (h.dirty === null) return;
    const at = Math.min(h.dirty, h.text.length);
    h.dirty = null;
    for (const w of h.windows) {
      this.deliver(h, w, "grove:chat:text", { at, text: h.text.slice(at) });
    }
  }

  private deliver(h: Hosted, w: PushTarget, channel: string, payload: unknown): void {
    if (w.isDestroyed()) {
      h.windows.delete(w);
      return;
    }
    try {
      w.send(channel, payload);
    } catch {
      // the window went away between the check and the send
    }
  }
}
