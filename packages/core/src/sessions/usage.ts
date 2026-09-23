import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { isObject } from "../fsx.ts";
import { agentLineText, conversationText } from "../transcript/text.ts";
import { emptyTally, UsageAccumulator, type UsageTally } from "../transcript/usage.ts";

const READ_BYTES = 1 << 20;
const NL = 0x0a;

/** receives the searchable text of the lines a scan reads. reset() means the scan starts from 0. */
export interface TextSink {
  reset(): void;
  push(text: string): void;
}

/**
 * token usage is the one thing the head + tail read cannot give us: it is spread over every
 * response in the file. so this reads the whole transcript once, then only what was appended.
 * a file that got shorter than the saved offset was rewritten, and is counted again from 0.
 */
export async function scanUsage(
  file: string,
  prev?: UsageTally,
  sink?: TextSink,
  textOf: (entry: Record<string, unknown>) => string | undefined = conversationText,
): Promise<UsageTally> {
  const fh = await open(file, constants.O_RDONLY);
  try {
    const size = (await fh.stat()).size;
    const resume = prev && prev.offset <= size ? prev : undefined;
    const tally: UsageTally = resume ? structuredClone(resume) : emptyTally();
    if (!resume) sink?.reset();
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
      foldLines(acc, chunk.subarray(0, lastNl).toString("utf8"), sink, textOf);
      // only whole lines count as read. a line still being written is picked up next time.
      offset += lastNl + 1;
      carry = Buffer.from(chunk.subarray(lastNl + 1));
    }
    return acc.finish(offset);
  } finally {
    await fh.close();
  }
}

function foldLines(
  acc: UsageAccumulator,
  text: string,
  sink: TextSink | undefined,
  textOf: (entry: Record<string, unknown>) => string | undefined,
): void {
  for (const line of text.split("\n")) {
    if (line.charCodeAt(0) !== 0x7b) continue;
    // most of the bytes are tool results and attachments. skip them before paying for a parse.
    // every assistant response carries usage. a person's turn is a user line that is not a tool
    // result - and an agent's tool results mostly carry no toolUseResult, so the block says it.
    const usage = line.includes('"usage"');
    const typed =
      !usage &&
      !!sink &&
      line.includes('"type":"user"') &&
      !line.includes('"toolUseResult":') &&
      !line.includes('"type":"tool_result"');
    if (!usage && !typed) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (!isObject(v)) continue;
      if (usage) acc.push(v);
      if (sink) {
        const t = textOf(v);
        if (t) sink.push(t);
      }
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

/**
 * `sink` gets the session's own conversation, and `agentSink` each subagent's, by the same key
 * as its tally - so a search can find what an agent said, and say which agent said it.
 */
export async function scanSessionUsage(
  transcriptPath: string,
  prev: SessionTallies = {},
  sink?: TextSink,
  agentSink?: (rel: string) => TextSink | undefined,
): Promise<SessionTallies> {
  const out: SessionTallies = {};
  const main = await scanUsage(transcriptPath, prev[""], sink).catch(() => undefined);
  if (main) out[""] = main;
  const base = path.dirname(transcriptPath);
  for (const file of await subagentTranscripts(transcriptPath)) {
    const rel = path.relative(base, file);
    const tally = await scanUsage(file, prev[rel], agentSink?.(rel), agentLineText).catch(
      () => undefined,
    );
    if (tally) out[rel] = tally;
  }
  return out;
}

/** `<sessionId>/subagents/…/agent-<id>.jsonl` -> the id. a workflow's journal is not an agent. */
export function agentIdOfTally(rel: string): string | null {
  const m = /(?:^|\/)agent-([^./]+)\.jsonl$/.exec(rel);
  return m?.[1] ?? null;
}
