import { isObject } from "../fsx.ts";

const REMINDER_OPEN = "<system-reminder>";
const REMINDER_CLOSE = "</system-reminder>";

/**
 * one content block -> the text a person typed, or null when the block is machinery.
 *
 * reminder spans are stripped only when anchored at the start or end of the block. a prompt
 * that merely mentions the tag in prose must survive untouched. filtering happens per block,
 * before joining: joining first and testing the result throws away every prompt that had an
 * injected block in front of it.
 */
export function cleanBlockText(text: string): string | null {
  let t = text.trim();
  while (t.startsWith(REMINDER_OPEN)) {
    const end = t.indexOf(REMINDER_CLOSE);
    if (end < 0) return null;
    t = t.slice(end + REMINDER_CLOSE.length).trim();
  }
  while (t.endsWith(REMINDER_CLOSE)) {
    const start = t.lastIndexOf(REMINDER_OPEN);
    if (start < 0) break;
    t = t.slice(0, start).trim();
  }
  if (!t) return null;
  if (t.startsWith("<")) return null;
  if (t.startsWith("Caveat:") || t.startsWith("[Request interrupted")) return null;
  return t;
}

function isCarrierEntry(entry: Record<string, unknown>): boolean {
  if (entry.isSidechain === true || entry.isMeta === true) return true;
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return true;
  if (entry.toolUseResult !== undefined && entry.toolUseResult !== null) return true;
  const origin = entry.origin;
  if (isObject(origin) && origin.kind === "task-notification") return true;
  return false;
}

/** text blocks of a user entry, or null when the entry is not a person's turn */
function userTextBlocks(entry: unknown): string[] | null {
  if (!isObject(entry) || entry.type !== "user" || isCarrierEntry(entry)) return null;
  const message = entry.message;
  if (!isObject(message)) return null;
  const content = message.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return null;
  const blocks: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "tool_result") return null;
    if (block.type === "text" && typeof block.text === "string") blocks.push(block.text);
  }
  return blocks;
}

/** the text the person typed in this entry, or undefined when there is none */
export function extractUserText(entry: unknown): string | undefined {
  const blocks = userTextBlocks(entry);
  if (!blocks) return undefined;
  const survivors: string[] = [];
  for (const block of blocks) {
    const clean = cleanBlockText(block);
    if (clean) survivors.push(clean);
  }
  return survivors.length ? survivors.join("\n") : undefined;
}

const COMMAND_NAME = /<command-name>\s*([^<]+?)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** "/mcp args" out of a slash-command envelope. last-resort title for sessions that are only commands. */
export function extractCommand(entry: unknown): string | undefined {
  const blocks = userTextBlocks(entry);
  if (!blocks) return undefined;
  for (const block of blocks) {
    const name = COMMAND_NAME.exec(block)?.[1];
    if (!name) continue;
    const args = COMMAND_ARGS.exec(block)?.[1]?.trim();
    const cmd = name.startsWith("/") ? name : `/${name}`;
    return args ? `${cmd} ${args}` : cmd;
  }
  return undefined;
}
