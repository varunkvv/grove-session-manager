import type { FileHandle } from "node:fs/promises";

const READ_BYTES = 1 << 20;
const NL = 0x0a;

/**
 * every whole line of a transcript from `from` to `size`, read a chunk at a time and handed over
 * one line at a time with the byte offset it starts at - so a 100MB file is never one string, and
 * whatever was folded out of a line can find that line again later. a line still being written
 * (no newline yet) is left for the next read: the offset returned is the end of the last whole
 * line, which is where that read starts.
 *
 * `onLine` gets the raw bytes first and may say no to a line before it is decoded - most lines of
 * a session's transcript are hook results and metadata nobody draws.
 */
export async function readWholeLines(
  fh: FileHandle,
  from: number,
  size: number,
  onLine: (text: string, offset: number, length: number) => void,
  skip?: (chunk: Buffer, start: number, end: number) => boolean,
): Promise<number> {
  let offset = from;
  if (from >= size) return offset;
  let carry: Buffer = Buffer.alloc(0);
  const buf = Buffer.alloc(Math.min(READ_BYTES, size - from));
  let at = from;
  while (at < size) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - at), at);
    if (bytesRead === 0) break;
    // where chunk[0] sits in the file: the unfinished line carried over starts before `at`
    const base = at - carry.length;
    at += bytesRead;
    const chunk = carry.length
      ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
      : buf.subarray(0, bytesRead);
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(NL, start);
      if (nl < 0) break;
      if (nl > start && !skip?.(chunk, start, nl)) {
        onLine(chunk.toString("utf8", start, nl), base + start, nl - start);
      }
      start = nl + 1;
    }
    // only whole lines count as read. one still being written is picked up next time.
    offset = base + start;
    carry = Buffer.from(chunk.subarray(start));
  }
  return offset;
}
