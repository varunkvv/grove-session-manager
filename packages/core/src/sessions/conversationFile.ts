import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import { ConversationFold, type ConversationState } from "./conversation.ts";
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
