// a session's own transcript lines, shaped like the real thing, for what the redacted fixture
// cannot show: its stretch of the real session has no api error, no interrupt and no Bash stderr,
// and older Claude Code versions wrote prompts without an `origin`.
const T0 = Date.parse("2026-09-24T09:00:00.000Z");
export const SESSION_T0 = T0;
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

let n = 0;
/** uuids that share no prefix, like the random ones Claude Code writes */
export const uuid = () => {
  n++;
  const hex = n.toString(16).padStart(8, "0");
  return `${hex}-${hex.slice(4)}-4000-8000-${hex}0000`;
};

const envelope = (s: number, extra: Record<string, unknown> = {}) => ({
  parentUuid: null,
  isSidechain: false,
  uuid: uuid(),
  timestamp: at(s),
  userType: "external",
  entrypoint: "claude-vscode",
  cwd: "/work/api",
  sessionId: "22222222-0000-4000-8000-000000000001",
  version: "2.1.281",
  gitBranch: "main",
  ...extra,
});

type Block = Record<string, unknown>;

/** a person's prompt. `origin: false` writes it the way versions before `origin` did. */
export function prompt(
  content: string | Block[],
  s: number,
  opts: { origin?: boolean; extra?: Record<string, unknown> } = {},
) {
  return {
    type: "user",
    message: { role: "user", content },
    ...envelope(s, {
      ...(opts.origin === false ? {} : { origin: { kind: "human" }, promptSource: "sdk" }),
      ...opts.extra,
    }),
  };
}

export function userLine(
  content: string | Block[],
  s: number,
  extra: Record<string, unknown> = {},
) {
  return { type: "user", message: { role: "user", content }, ...envelope(s, extra) };
}

export const text = (t: string): Block => ({ type: "text", text: t });
export const image = (): Block => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
});
export const thinking = (t: string): Block => ({ type: "thinking", thinking: t, signature: "sig" });
export const call = (id: string, name: string, input: Record<string, unknown>): Block => ({
  type: "tool_use",
  id,
  name,
  input,
  caller: { type: "direct" },
});

/** one line of a response. a response with several blocks is several lines with one message id. */
export function says(msg: string, block: Block, s: number, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    message: {
      model: "claude-opus-5",
      id: msg,
      type: "message",
      role: "assistant",
      content: [block],
      usage: {
        input_tokens: 2,
        output_tokens: 40,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 500,
      },
    },
    requestId: `req_${msg}`,
    ...envelope(s),
    ...extra,
  };
}

/** what Claude Code writes itself when the api call failed for good */
export function apiErrorMessage(s: number, said = "API Error: 529 Overloaded") {
  return {
    type: "assistant",
    message: {
      model: "<synthetic>",
      id: `synthetic-${s}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: said }],
    },
    isApiErrorMessage: true,
    ...envelope(s),
  };
}

export function result(
  toolUseId: string,
  content: string,
  s: number,
  opts: { isError?: boolean; told?: unknown } = {},
) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { tool_use_id: toolUseId, type: "tool_result", content, is_error: opts.isError ?? false },
      ],
    },
    ...(opts.told !== undefined ? { toolUseResult: opts.told } : {}),
    sourceToolAssistantUUID: "x",
    ...envelope(s),
  };
}

export function command(name: string, args: string, s: number, messageFirst = false) {
  const nameTag = `<command-name>/${name}</command-name>`;
  const messageTag = `<command-message>${name}</command-message>`;
  const body = messageFirst
    ? `${messageTag}\n${nameTag}\n<command-args>${args}</command-args>`
    : `${nameTag}\n            ${messageTag}\n            <command-args>${args}</command-args>`;
  return userLine(body, s);
}

export const stdout = (out: string, s: number) =>
  userLine(`<local-command-stdout>${out}</local-command-stdout>`, s);

export function localCommand(out: string, s: number) {
  return {
    type: "system",
    subtype: "local_command",
    content: `<local-command-stdout>${out}</local-command-stdout>`,
    level: "info",
    ...envelope(s),
  };
}

export function taskNotification(summary: string, s: number, opts: { origin?: boolean } = {}) {
  return userLine(
    `<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
    s,
    opts.origin === false ? {} : { origin: { kind: "task-notification" } },
  );
}

export function compactBoundary(s: number, trigger = "auto", pre = 1_000_000, post = 25_000) {
  return {
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    compactMetadata: { trigger, preTokens: pre, postTokens: post },
    ...envelope(s),
  };
}

export const compactSummary = (summary: string, s: number) =>
  userLine(
    `This session is being continued from a previous conversation that ran out of context. ${summary}`,
    s,
    { isCompactSummary: true, isVisibleInTranscriptOnly: true },
  );

export function apiError(s: number, attempt: number, max = 10) {
  return {
    type: "system",
    subtype: "api_error",
    level: "error",
    error: { message: "Connection error.", formatted: "Connection dropped (ECONNRESET)" },
    retryInMs: 500,
    retryAttempt: attempt,
    maxRetries: max,
    ...envelope(s),
  };
}

export function turnDuration(ms: number, s: number) {
  return { type: "system", subtype: "turn_duration", durationMs: ms, ...envelope(s) };
}

/** something typed while it worked, handed over mid-turn */
export function queued(textTyped: string, s: number, mode = "prompt") {
  return {
    type: "attachment",
    attachment: {
      type: "queued_command",
      prompt: [{ type: "text", text: textTyped }],
      commandMode: mode,
      origin: { kind: mode === "prompt" ? "human" : "task-notification" },
      timestamp: at(s),
    },
    ...envelope(s),
  };
}

export function hookNoise(s: number) {
  return {
    type: "attachment",
    attachment: { type: "hook_success", hookName: "PostToolUse", content: "", exitCode: 0 },
    ...envelope(s),
  };
}

export const title = (t: string) => ({
  type: "ai-title",
  sessionId: "22222222-0000-4000-8000-000000000001",
  aiTitle: t,
});

export const jsonl = (lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
