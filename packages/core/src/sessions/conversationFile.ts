import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import {
  ConversationFold,
  type ConversationState,
  EDITS,
  editDiff,
  MESSAGE_MAX,
} from "./conversation.ts";
import { type LineRef, TimelineFold, type TimelineState } from "./timeline.ts";
import { readWholeLines } from "./transcriptLines.ts";

/**
 * how a line starts when nothing in it is the conversation: the metadata Claude Code appends over
 * and over (titles, the last prompt, pr links...), and every attachment but a message typed while
 * it worked. these are most of a transcript's lines, so they are dropped on their bytes, before
 * anything is decoded.
 */
const META =
  /^\{"type":"(ai-title|custom-title|agent-name|last-prompt|atis-latch|bridge-session|pr-link|cost-state|file-history-[a-z]+|queue-operation|mode|permission-mode|summary|tag)"/;
const ATTACHMENT = Buffer.from('"attachment":{"type":"');
const QUEUED = Buffer.from("queued_command");
/** how far into a line its kind is looked for: past the parent uuid and the sidechain flag */
const HEAD = 256;

function noise(chunk: Buffer, start: number, end: number): boolean {
  const head = chunk.subarray(start, Math.min(end, start + HEAD));
  const at = head.indexOf(ATTACHMENT);
  if (at >= 0) {
    const kind = at + ATTACHMENT.length;
    return head.indexOf(QUEUED, kind) !== kind;
  }
  return head[2] === 0x74 /* {"t */ && META.test(head.toString("latin1"));
}

/**
 * a session's transcript folded into turns, from where `prev` stopped. whole lines only, read a
 * chunk at a time and decoded one line at a time, so the 100MB transcript is never one string. a
 * file shorter than `prev` read was rewritten, and is folded again from 0. throws when the file
 * cannot be opened: Claude Code deletes a transcript after 30 days.
 */
export async function readConversation(
  file: string,
  prev?: ConversationState,
  opts: { home?: string } = {},
): Promise<ConversationState> {
  const fh = await open(file, constants.O_RDONLY);
  try {
    const size = (await fh.stat()).size;
    const fold = new ConversationFold(prev && prev.offset <= size ? prev : undefined, {
      home: opts.home ?? os.homedir(),
    });
    if (fold.state.offset === size) return fold.state;
    fold.state.offset = await readWholeLines(
      fh,
      fold.state.offset,
      size,
      (text, at, length) => fold.line(text, at, length),
      noise,
    );
    return fold.state;
  } finally {
    await fh.close();
  }
}

/**
 * what one edit of a session changed, by its call's id: the two lines the fold kept for it (the
 * call, and its result) read back from the transcript, as `editDiff` draws them. null for a call
 * that is not an edit of this session's
 */
export async function readEditDiff(
  file: string,
  toolUseId: string,
  opts: { home?: string } = {},
): Promise<string[] | null> {
  const state = await readConversation(file, undefined, opts);
  for (const item of state.items) {
    if (item.kind !== "turn") continue;
    const step = item.work.steps.find((s) => s.kind === "tool" && s.id === toolUseId);
    if (step?.kind !== "tool" || !EDITS.has(step.name)) continue;
    const fh = await open(file, constants.O_RDONLY);
    try {
      const line = async (ref?: LineRef) => {
        if (!ref) return undefined;
        const buf = Buffer.alloc(ref.length);
        await fh.read(buf, 0, ref.length, ref.offset);
        try {
          return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      };
      const use = await line(step.use);
      const blocks = (use?.message as { content?: unknown } | undefined)?.content;
      const call = Array.isArray(blocks)
        ? blocks.find((b) => (b as { id?: unknown })?.id === toolUseId)
        : undefined;
      const result = (await line(step.ref))?.toolUseResult;
      return editDiff(step.name, (call as { input?: unknown } | undefined)?.input, result) ?? null;
    } finally {
      await fh.close();
    }
  }
  return null;
}

/**
 * a subagent's transcript folded whole, the way a turn's work is: its prompt, its steps, its
 * messages uncut. with `prev`, from where that read stopped: a running agent is followed by its tail
 */
export async function readAgentTimeline(
  file: string,
  opts: { home?: string } = {},
  /** the last read of it: only what was written since is read. a shorter file is read whole */
  prev?: TimelineState,
): Promise<TimelineState> {
  const fh = await open(file, constants.O_RDONLY);
  try {
    const size = (await fh.stat()).size;
    const from = prev && prev.offset <= size ? prev : undefined;
    if (from?.offset === size) return from;
    const fold = new TimelineFold(from, {
      home: opts.home ?? os.homedir(),
      inputPreview: 0,
      resultPreview: 0,
      textMax: MESSAGE_MAX,
    });
    fold.state.offset = await readWholeLines(fh, from?.offset ?? 0, size, (text, at, length) =>
      fold.line(text, at, length),
    );
    return fold.state;
  } finally {
    await fh.close();
  }
}
