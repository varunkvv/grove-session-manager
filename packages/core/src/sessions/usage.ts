import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { isObject } from "../fsx.ts";
import { emptyTally, UsageAccumulator, type UsageTally } from "../transcript/usage.ts";

const READ_BYTES = 1 << 20;
const NL = 0x0a;

/**
 * token usage is the one thing the head + tail read cannot give us: it is spread over every
 * response in the file. so this reads the whole transcript once, then only what was appended.
 * a file that got shorter than the saved offset was rewritten, and is counted again from 0.
 */
export async function scanUsage(file: string, prev?: UsageTally): Promise<UsageTally> {
  const fh = await open(file, constants.O_RDONLY);
  try {
    const size = (await fh.stat()).size;
    const resume = prev && prev.offset <= size ? prev : undefined;
    const tally: UsageTally = resume ? structuredClone(resume) : emptyTally();
    const acc = new UsageAccumulator(tally);
    let offset = tally.offset;
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.alloc(READ_BYTES);
    let at = offset;
    while (at < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(READ_BYTES, size - at), at);
      if (bytesRead === 0) break;
      at += bytesRead;
      const chunk = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      const lastNl = chunk.lastIndexOf(NL);
      if (lastNl < 0) {
        carry = Buffer.from(chunk);
        continue;
      }
      foldLines(acc, chunk.subarray(0, lastNl).toString("utf8"));
      // only whole lines count as read. a line still being written is picked up next time.
      offset += lastNl + 1;
      carry = Buffer.from(chunk.subarray(lastNl + 1));
    }
    return acc.finish(offset);
  } finally {
    await fh.close();
  }
}

function foldLines(acc: UsageAccumulator, text: string): void {
  for (const line of text.split("\n")) {
    // most lines are prompts, tool results and attachments. skip them before paying for a parse.
    if (line.charCodeAt(0) !== 0x7b || !line.includes('"usage"')) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObject(v)) acc.push(v);
    } catch {
      // junk or a torn line. the rest of the file still counts.
    }
  }
}

/**
 * subagent transcripts live next to the session, in `<id>/subagents/`, and workflows nest one
 * level further. they are real spend, often on a different model.
 */
export async function subagentTranscripts(transcriptPath: string): Promise<string[]> {
  const dir = path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath, ".jsonl"),
    "subagents",
  );
  try {
    const names = await readdir(dir, { recursive: true });
    return names
      .map(String)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** per file under one session. the session's own transcript is keyed "". */
export type SessionTallies = Record<string, UsageTally>;

export async function scanSessionUsage(
  transcriptPath: string,
  prev: SessionTallies = {},
): Promise<SessionTallies> {
  const out: SessionTallies = {};
  const main = await scanUsage(transcriptPath, prev[""]).catch(() => undefined);
  if (main) out[""] = main;
  const base = path.dirname(transcriptPath);
  for (const file of await subagentTranscripts(transcriptPath)) {
    const rel = path.relative(base, file);
    const tally = await scanUsage(file, prev[rel]).catch(() => undefined);
    if (tally) out[rel] = tally;
  }
  return out;
}
