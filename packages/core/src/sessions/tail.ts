// the end of a session's transcript: what the person last typed, and what the agent has said
// since. read backwards from the end of the file and never past the newest prompt.
//
// the transcript is an internal format of claude code and reaches 100MB. so nothing here throws,
// nothing here reads a whole file into memory, and a file that cannot be read gives nothing.
import fs from "node:fs";
import { isObject } from "../fsx.ts";
import { extractCommand, extractUserText } from "../transcript/prompt.ts";

/**
 * how far back from the end the person's message is looked for. measured on 303 real transcripts:
 * it is within 1MB of 76% of tool calls, 4MB of 95% and 8MB of 99%.
 * ponytail: past 8MB there is no prompt, and the caller falls back to the index's `lastPrompt`
 */
const BACK = 8 << 20;
const CHUNK = 1 << 20;

/** what is sent to the page at most. a prompt keeps its start, a message its end: the question is there */
export const TAIL_PROMPT_MAX = 4000;
export const TAIL_TEXT_MAX = 20_000;

export interface SessionTail {
  /** the newest thing the person typed */
  prompt?: string;
  /** the agent's newest words since then. absent while it has only called tools */
  text?: string;
}

/** the whole lines that end at or before `end`, newest first, from at most BACK bytes */
function* linesBack(fd: number, end: number): Generator<Buffer> {
  const floor = Math.max(0, end - BACK);
  let carry: Buffer = Buffer.alloc(0);
  for (let hi = end; hi > floor; ) {
    const lo = Math.max(floor, hi - CHUNK);
    const buf = Buffer.alloc(hi - lo + carry.length);
    fs.readSync(fd, buf, 0, hi - lo, lo);
    carry.copy(buf, hi - lo);
    let stop = buf.length;
    while (stop > 0) {
      const nl = buf.lastIndexOf(10, stop - 1);
      if (nl < 0) break;
      if (nl + 1 < stop) yield buf.subarray(nl + 1, stop);
      stop = nl;
    }
    // the start of a line whose rest is in the chunk before
    carry = buf.subarray(0, stop);
    hi = lo;
  }
  if (floor === 0 && carry.length) yield carry;
}

function parse(line: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line.toString("utf8"));
    return isObject(v) ? v : null;
  } catch {
    return null; // a line still being written, or one cut by the window
  }
}

/**
 * what the person typed, when this line is that: a prompt, a slash command with arguments, or
 * something typed while the agent worked (claude code writes that as a `queued_command`
 * attachment, never as a user line)
 */
function typed(e: Record<string, unknown>): string | undefined {
  if (e.type === "attachment") {
    const a = isObject(e.attachment) ? e.attachment : {};
    if (a.type !== "queued_command" || a.commandMode !== "prompt") return undefined;
    if (!isObject(a.origin) || a.origin.kind !== "human") return undefined;
    return extractUserText({ type: "user", message: { content: a.prompt } });
  }
  const said = extractUserText(e);
  if (said) return said;
  // `/loop watch the rollout` is the person's words. `/model` alone says nothing
  const command = extractCommand(e);
  return command?.includes(" ") ? command : undefined;
}

/** an assistant line's own text. a response with several blocks is several lines */
function said(e: Record<string, unknown>): string | undefined {
  if (e.type !== "assistant" || e.isSidechain === true || !isObject(e.message)) return undefined;
  const content = e.message.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((b) =>
      isObject(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : [],
    )
    .join("\n\n")
    .trim();
  return text || undefined;
}

export function sessionTail(file: string): SessionTail {
  const out: SessionTail = {};
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    for (const line of linesBack(fd, fs.fstatSync(fd).size)) {
      // on the raw bytes first: most of a transcript is tool results, and those are the big lines.
      // a quote inside a JSON string is \", so these only ever match a real key
      const user = line.includes('"type":"user"') && !line.includes('"toolUseResult":');
      const agent = out.text === undefined && line.includes('"type":"assistant"');
      if (!user && !agent && !line.includes('"type":"queued_command"')) continue;
      const e = parse(line);
      if (!e) continue;
      const prompt = typed(e);
      if (prompt) {
        out.prompt =
          prompt.length > TAIL_PROMPT_MAX ? `${prompt.slice(0, TAIL_PROMPT_MAX - 1)}…` : prompt;
        break;
      }
      const text = agent ? said(e) : undefined;
      if (text) {
        out.text = text.length > TAIL_TEXT_MAX ? `…${text.slice(1 - TAIL_TEXT_MAX)}` : text;
      }
    }
  } catch {
    // gone, or not readable: what was found until then
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return out;
}
