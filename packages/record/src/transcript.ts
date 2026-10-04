// claude code's own transcript of a session, read for two things: what the person last typed
// (kept on a conclusion as `said` when it is recorded) and the turn around the call that
// recorded it (read when someone asks for the conclusion in full).
//
// the transcript is an internal format of claude code and reaches 100MB. so nothing here throws,
// nothing here reads a whole file into memory, and a file that cannot be read gives nothing.
import fs from "node:fs";
import path from "node:path";
import { cut } from "./format.ts";
import type { Turn } from "./types.ts";

export type { Turn } from "./types.ts";

/**
 * how far back from a call the person's message is looked for. measured on 303 real transcripts:
 * it is within 64KB of 15% of tool calls, 1MB of 76%, 4MB of 95% and 8MB of 99%.
 * ponytail: past 8MB there is no `said` and no prompt. claude code's `last-prompt` records are
 * closer (64KB for 96%) but name the turn's first prompt, not something typed after it.
 */
const BACK = 8 << 20;
const CHUNK = 1 << 20;

/** how much of the person's message and of the agent's own text a turn carries. */
export const TURN_MAX = 2000;

/** <claude config>/projects/<slug of the cwd>/<session>.jsonl. the slug is lossy, so the folders are searched. */
export function transcriptFile(projectsDir: string, session: string): string | null {
  // a session id is written into a path here. "person" and "unknown" name no file
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(session)) return null;
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const file = path.join(projectsDir, dir, `${session}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {
    // no projects folder
  }
  return null;
}

/** the whole lines that end at or before `end`, newest first, from at most BACK bytes. */
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
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null; // a line still being written, or one cut by the window
  }
}

const REMINDER = ["<system-reminder>", "</system-reminder>"] as const;

/** one text block as the person typed it. reminders around it go, and a block that is only machinery is nothing. */
function clean(block: string): string {
  let t = block.trim();
  while (t.startsWith(REMINDER[0])) {
    const end = t.indexOf(REMINDER[1]);
    if (end < 0) return "";
    t = t.slice(end + REMINDER[1].length).trim();
  }
  while (t.endsWith(REMINDER[1])) {
    const start = t.lastIndexOf(REMINDER[0]);
    if (start < 0) break;
    t = t.slice(0, start).trim();
  }
  if (t.startsWith("<")) {
    // a slash command with arguments is the person's words: "/loop watch the rollout". with
    // none it says nothing. everything else in angle brackets is the editor's context
    const name = /<command-name>\s*\/?([^<]+?)\s*<\/command-name>/.exec(t)?.[1];
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
    return name && args ? `/${name} ${args}` : "";
  }
  // claude code's own notes
  return t.startsWith("Caveat:") || t.startsWith("[Request interrupted") ? "" : t;
}

/**
 * what the person typed, when this line is that: a prompt, or something typed while the agent
 * worked (claude code writes that as a `queued_command` attachment, never as a user line).
 * not a tool result, not a meta or task-notification line, not hook output, not another agent.
 */
function typed(line: Buffer): string | undefined {
  // on the raw bytes first: most of a transcript is tool results, and those are the big lines.
  // a quote inside a JSON string is \", so these only ever match a real key
  const user = line.includes('"type":"user"') && !line.includes('"toolUseResult":');
  if (!user && !line.includes('"type":"queued_command"')) return undefined;
  const e = parse(line);
  if (!e) return undefined;
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  let content: unknown;
  if (e.type === "attachment") {
    const a = obj(e.attachment);
    if (a.type !== "queued_command" || a.commandMode !== "prompt") return undefined;
    if (obj(a.origin).kind !== "human") return undefined;
    content = a.prompt;
  } else {
    if (e.type !== "user" || e.isSidechain || e.isMeta || e.isCompactSummary) return undefined;
    if (e.isVisibleInTranscriptOnly) return undefined;
    // lines from before claude code wrote an origin have none
    if (e.origin && obj(e.origin).kind !== "human") return undefined;
    content = obj(e.message).content;
  }
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks) || blocks.some((b) => obj(b).type === "tool_result")) return undefined;
  const text = blocks
    .map((b) => {
      const { type, text } = obj(b);
      return type === "text" && typeof text === "string" ? clean(text) : "";
    })
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function withFile<T>(file: string, read: (fd: number, size: number) => T): T | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      return read(fd, fs.fstatSync(fd).size);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** the newest thing the person typed in this transcript. undefined when there is none within reach. */
export function lastSaid(file: string): string | undefined {
  return (
    withFile(file, (fd, size) => {
      for (const line of linesBack(fd, size)) {
        const text = typed(line);
        if (text) return text;
      }
    }) ?? undefined
  );
}

/** where `needle` first is in the file, or -1. */
function find(fd: number, size: number, needle: Buffer, from = 0): number {
  const buf = Buffer.alloc(CHUNK + needle.length);
  for (let at = from; at < size; at += CHUNK) {
    const n = fs.readSync(fd, buf, 0, buf.length, at);
    const i = buf.subarray(0, n).indexOf(needle);
    if (i >= 0) return at + i;
  }
  return -1;
}

/**
 * the turn around one tool call: the person's message before it and the agent's own words between
 * that and the call. null when the file cannot be read or the call is not in it (a subagent's
 * call is in the subagent's own file).
 * ponytail: the call is found by reading the file from its start, about 1ms a MB. store the
 * call's byte offset on the record if that ever shows.
 */
export function turnAround(file: string, toolUseId: string): Turn | null {
  if (!/^[A-Za-z0-9_-]+$/.test(toolUseId)) return null;
  return withFile(file, (fd, size) => {
    // the tool_use block's own key. a result names its call as "tool_use_id", which this is not
    const at = find(fd, size, Buffer.from(`"id":"${toolUseId}"`));
    if (at < 0) return null;
    const nl = find(fd, size, Buffer.from("\n"), at);
    const texts: string[] = [];
    let chars = 0;
    let call = true;
    for (const line of linesBack(fd, nl < 0 ? size : nl + 1)) {
      const prompt = typed(line);
      if (prompt) return turn(prompt, texts);
      if ((call || chars < TURN_MAX) && line.includes('"type":"assistant"')) {
        const e = parse(line);
        const content = (e?.message as { content?: unknown } | undefined)?.content;
        if (e?.type === "assistant" && !e.isSidechain && Array.isArray(content)) {
          const blocks = content as { type?: unknown; id?: unknown; text?: unknown }[];
          // in the call's own message, only what comes before the call
          const until = call ? blocks.findIndex((b) => b?.id === toolUseId) : blocks.length;
          for (const b of blocks.slice(0, until < 0 ? blocks.length : until).reverse()) {
            if (b?.type !== "text" || typeof b.text !== "string" || !b.text.trim()) continue;
            texts.unshift(b.text.trim());
            chars += b.text.length;
          }
        }
      }
      call = false;
    }
    return turn(undefined, texts);
  });
}

function turn(prompt: string | undefined, texts: string[]): Turn {
  const text = Array.from(texts.join("\n\n"));
  return {
    ...(prompt ? { prompt: cut(prompt, TURN_MAX) } : {}),
    // the end of it: what the agent said last is what led to the call
    ...(text.length
      ? { text: text.length > TURN_MAX ? `…${text.slice(1 - TURN_MAX).join("")}` : text.join("") }
      : {}),
  };
}
