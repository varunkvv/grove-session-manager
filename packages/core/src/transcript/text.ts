import { isObject } from "../fsx.ts";
import { extractUserText } from "./prompt.ts";

/** tool inputs worth finding a session by: the files it touched, the commands it ran */
const TOOL_FIELDS = ["file_path", "path", "command", "pattern", "url", "query"] as const;
const TOOL_FIELD_MAX = 300;

/**
 * the searchable words of one transcript line: what the person typed, what Claude wrote back,
 * and the file paths and commands of its tool calls. tool output and thinking are left out -
 * they are most of the bytes and almost none of what people remember.
 */
export function conversationText(entry: Record<string, unknown>): string | undefined {
  if (entry.isSidechain === true) return undefined;
  return lineText(entry, TOOL_FIELDS);
}

/** an agent's words, for finding it later: what it was for and what it said, as well as its paths */
const AGENT_TOOL_FIELDS = [...TOOL_FIELDS, "description", "prompt"] as const;

/**
 * the searchable words of one line of an agent's own transcript: the prompt it was given and
 * anything sent to it, what it wrote (its result is the last of that), and the inputs of its
 * calls. every line of it is a sidechain line, which the session's own text leaves out. tool
 * output and thinking stay out here too - they are other people's files and pages.
 */
export function agentLineText(entry: Record<string, unknown>): string | undefined {
  if (entry.type === "user") {
    // Claude Code's own notes are meta. a message sent to a running agent is meta too, and counts.
    const origin = entry.origin;
    if (entry.isMeta === true && !(isObject(origin) && origin.kind === "coordinator")) {
      return undefined;
    }
    const message = entry.message;
    if (!isObject(message)) return undefined;
    const content = message.content;
    const blocks =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((b) =>
              isObject(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : [],
            )
          : [];
    const text = blocks.join("\n").trim();
    return text && !text.startsWith("[Request interrupted") ? text : undefined;
  }
  return lineText(entry, AGENT_TOOL_FIELDS);
}

function lineText(entry: Record<string, unknown>, fields: readonly string[]): string | undefined {
  if (entry.type === "user") return extractUserText(entry);
  if (entry.type !== "assistant") return undefined;
  const message = entry.message;
  if (!isObject(message) || !Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const block of message.content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool_use" && isObject(block.input)) {
      for (const field of fields) {
        const v = block.input[field];
        if (typeof v === "string" && v) parts.push(v.slice(0, TOOL_FIELD_MAX));
      }
    }
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}
