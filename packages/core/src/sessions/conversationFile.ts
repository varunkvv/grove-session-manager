import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isObject, readJsonGuarded, writeFileAtomic } from "../fsx.ts";
import { CONVERSATION_VERSION, ConversationFold, type ConversationState } from "./conversation.ts";
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
 * chunk at a time and decoded one line at a time, so the 100MB transcript is never one string -
 * and every step knows the byte offset of its line, which is how the full result is found again
 * without keeping it. a file shorter than `prev` read was rewritten, and is folded again from 0.
 */
export async function readConversation(
  file: string,
  prev?: ConversationState,
  opts: { home?: string } = {},
): Promise<ConversationState> {
  const fh = await open(file, constants.O_RDONLY);
  try {
    const size = (await fh.stat()).size;
    const resume =
      prev && prev.version === CONVERSATION_VERSION && prev.offset <= size ? prev : undefined;
    const fold = new ConversationFold(resume, { home: opts.home ?? os.homedir() });
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

/** a session's folded conversation, kept so the next look reads only what was appended since */
export function conversationCacheDir(stateDir: string): string {
  return path.join(stateDir, `conversations.v${CONVERSATION_VERSION}`);
}

function cacheFileFor(dir: string, transcript: string): string {
  return path.join(dir, `${createHash("sha1").update(transcript).digest("hex").slice(0, 24)}.json`);
}

interface CachedConversation {
  file: string;
  /** mtime:size of the transcript when it was folded */
  mark: string;
  state: ConversationState;
}

/**
 * what was cached for this transcript, and the mark it was cached at. a state is returned even
 * when the file has grown since: it carries its offset, so the next read folds only what was
 * appended - a transcript only ever grows.
 */
export async function loadCachedConversation(
  dir: string,
  transcript: string,
): Promise<{ state: ConversationState; mark: string } | null> {
  const read = await readJsonGuarded<CachedConversation>(cacheFileFor(dir, transcript));
  if (read.status !== "ok" || !isObject(read.value)) return null;
  const { file, mark, state } = read.value;
  if (file !== transcript || typeof mark !== "string" || !isObject(state)) return null;
  if (state.version !== CONVERSATION_VERSION || typeof state.offset !== "number") return null;
  if (!Array.isArray(state.items) || !Array.isArray(state.seen)) return null;
  return { state, mark };
}

export async function saveCachedConversation(
  dir: string,
  transcript: string,
  mark: string,
  state: ConversationState,
): Promise<void> {
  const entry: CachedConversation = { file: transcript, mark, state };
  await writeFileAtomic(cacheFileFor(dir, transcript), JSON.stringify(entry));
}
