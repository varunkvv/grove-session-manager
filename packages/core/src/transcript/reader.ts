import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** same chunk size the official CLI and VS Code extension use */
export const CHUNK_BYTES = 65536;
const NL = 0x0a;

export interface HeadTail {
  /** complete lines from the start of the file */
  head: string;
  /** complete lines from the end. null when the whole file was read into `head`. */
  tail: string | null;
  size: number;
  mtimeMs: number;
}

/**
 * reads at most 2 * chunkBytes, never the whole transcript (they reach 100MB).
 * cuts happen at the byte level before decoding, so a multibyte character split by a chunk
 * edge only ever lands in a discarded partial line.
 */
export async function readHeadTail(
  file: string,
  chunkBytes: number = CHUNK_BYTES,
): Promise<HeadTail> {
  const fh = await open(file, constants.O_RDONLY);
  try {
    // stat the open handle: a live transcript can grow between a path stat and the read
    const st = await fh.stat();
    const size = st.size;
    if (size <= chunkBytes * 2) {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, 0);
      return {
        head: buf.subarray(0, bytesRead).toString("utf8"),
        tail: null,
        size,
        mtimeMs: st.mtimeMs,
      };
    }

    const headBuf = Buffer.alloc(chunkBytes);
    const headRead = (await fh.read(headBuf, 0, chunkBytes, 0)).bytesRead;
    const headEnd = headBuf.subarray(0, headRead).lastIndexOf(NL);
    const head = headEnd < 0 ? "" : headBuf.subarray(0, headEnd).toString("utf8");

    // one extra byte in front tells us whether the chunk starts on a line boundary
    const tailStart = size - chunkBytes - 1;
    const tailBuf = Buffer.alloc(chunkBytes + 1);
    const tailRead = (await fh.read(tailBuf, 0, chunkBytes + 1, tailStart)).bytesRead;
    const view = tailBuf.subarray(0, tailRead);
    const firstNl = view.indexOf(NL);
    const tail = firstNl < 0 ? "" : view.subarray(firstNl + 1).toString("utf8");

    return { head, tail, size, mtimeMs: st.mtimeMs };
  } finally {
    await fh.close();
  }
}
