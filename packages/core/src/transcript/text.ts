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
  if (entry.type === "user") return extractUserText(entry);
  if (entry.type !== "assistant") return undefined;
  const message = entry.message;
  if (!isObject(message) || !Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const block of message.content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool_use" && isObject(block.input)) {
      for (const field of TOOL_FIELDS) {
        const v = block.input[field];
        if (typeof v === "string" && v) parts.push(v.slice(0, TOOL_FIELD_MAX));
      }
    }
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}
