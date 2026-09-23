// agent transcript lines shaped like the real thing, for what the fixtures cannot show: nothing on
// the machine they came from has a nested agent, a result in several blocks, or thinking with text.
const T0 = Date.parse("2026-09-22T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const envelope = (agentId: string, s: number) => ({
  isSidechain: true,
  agentId,
  timestamp: at(s),
  userType: "external",
  entrypoint: "claude-vscode",
  cwd: "/work/api",
  sessionId: "11111111-0000-4000-8000-000000000001",
  version: "2.1.278",
});

export const AGENT_T0 = T0;

export function agentPrompt(agentId: string, text: string, s = 0) {
  return { type: "user", message: { role: "user", content: text }, ...envelope(agentId, s) };
}

type Block = Record<string, unknown>;

/** one line of a response. a response with several blocks is several lines with one message id. */
export function agentSays(
  agentId: string,
  msg: string,
  block: Block,
  s: number,
  usage = {
    input_tokens: 2,
    output_tokens: 40,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 200,
  },
) {
  return {
    type: "assistant",
    message: {
      model: "claude-sonnet-5",
      id: msg,
      type: "message",
      role: "assistant",
      content: [block],
      usage,
    },
    requestId: `req_${msg}`,
    ...envelope(agentId, s),
  };
}

export const text = (t: string): Block => ({ type: "text", text: t });
export const thinking = (t: string): Block => ({ type: "thinking", thinking: t, signature: "sig" });
export const call = (id: string, name: string, input: Record<string, unknown>): Block => ({
  type: "tool_use",
  id,
  name,
  input,
  caller: { type: "direct" },
});

export function agentResult(
  agentId: string,
  toolUseId: string,
  content: string,
  s: number,
  isError = false,
) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: toolUseId, type: "tool_result", content, is_error: isError }],
    },
    sourceToolAssistantUUID: "x",
    ...envelope(agentId, s),
  };
}

export function agentNote(agentId: string, content: string, s: number, extra: Block = {}) {
  return { type: "user", message: { role: "user", content }, ...envelope(agentId, s), ...extra };
}

export function hookAttachment(agentId: string, s: number) {
  return {
    type: "attachment",
    attachment: { type: "hook_success", hookName: "PostToolUse", content: "", exitCode: 0 },
    ...envelope(agentId, s),
  };
}

export const jsonl = (lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
