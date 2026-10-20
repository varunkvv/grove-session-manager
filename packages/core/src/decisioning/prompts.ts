// the person's own prompts out of a transcript, read from where the last read stopped. grove's own
// rule for a person's turn (extractUserText), plus what the eval set added: messages typed mid-turn
// (queued commands), minus turns a program started, prompts another session wrote, temp folders
// and copies of a prompt that was already read. nothing here keeps the text: the caller scores it
// and forgets it. evals/scripts/extract.py is the reference.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isObject } from "../fsx.ts";
import { cleanBlockText, extractUserText } from "../transcript/prompt.ts";
import { cleanForScoring, isSlashCommand, MIN_WORDS, ownWords, previousText } from "./clean.ts";

/** one prompt as the score cache keeps it: never its text */
export interface PromptRef {
  /** the transcript line's */
  uuid: string;
  /** epoch ms */
  at: number;
  /** of the text the model reads. a score is kept under uuid + this */
  hash: string;
  /** of the text as typed: a copy of a prompt is found by it */
  raw: string;
  /** too short to judge. kept so the next prompt knows what came before it */
  short?: true;
}

/** how far a transcript has been read, and the prompts found in it, in file order */
export interface FileState {
  /** bytes read, whole lines only */
  offset: number;
  /** where the last prompt's line starts: a restart reads it again for the next one's context */
  lastAt?: number;
  /** the first cwd in the file: the session's */
  cwd?: string;
  /** its cwd is one not to read (a temp folder): nothing in it counts */
  ignored?: true;
  prompts: PromptRef[];
}

/** a prompt just read, with what the model needs to judge it */
export interface FreshPrompt extends PromptRef {
  text: string;
  /** the person's prompt before it in the same transcript, cut */
  prev?: string;
}

/** what was read in every transcript, so a copy in another one is skipped */
export interface Known {
  uuids: Set<string>;
  /** `at|raw` */
  copies: Set<string>;
}

export const emptyFileState = (): FileState => ({ offset: 0, prompts: [] });

const TEMP = ["/tmp", "/private/tmp", "/private/var/folders"];
/** trial runs and test harnesses: someone's scripted prompts, not theirs */
export const isTempCwd = (cwd: string): boolean => TEMP.some((t) => cwd.startsWith(t));

export const textHash = (t: string): string =>
  createHash("sha256").update(t).digest("hex").slice(0, 16);

export function knownOf(files: Iterable<FileState>): Known {
  const k: Known = { uuids: new Set(), copies: new Set() };
  for (const f of files) {
    for (const p of f.prompts) {
      k.uuids.add(p.uuid);
      k.copies.add(`${p.at}|${p.raw}`);
    }
  }
  return k;
}

interface Typed {
  uuid: string;
  at: number;
  text: string;
}

/** a person's prompt on this line, or null. carriers, programs and other sessions are not */
function typedOn(entry: Record<string, unknown>): Typed | null {
  if (entry.isSidechain === true) return null;
  if (entry.turnOrigin === "sdk" || entry.turnOrigin === "scheduled") return null;
  if (entry.entrypoint === "sdk-cli") return null;
  let text: string | undefined;
  let origin: unknown;
  let stamp: unknown = entry.timestamp;
  if (entry.type === "user") {
    text = extractUserText(entry);
    origin = entry.origin;
  } else if (
    entry.type === "attachment" &&
    isObject(entry.attachment) &&
    entry.attachment.type === "queued_command"
  ) {
    // typed while the agent worked: grove's turn rule never sees these
    const a = entry.attachment;
    origin = a.origin;
    if (!isObject(origin) || origin.kind !== "human") return null;
    const p = a.prompt;
    const blocks =
      typeof p === "string"
        ? [p]
        : Array.isArray(p)
          ? p.flatMap((b) =>
              isObject(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : [],
            )
          : [];
    const kept = blocks.map(cleanBlockText).filter((b): b is string => !!b);
    text = kept.length ? kept.join("\n") : undefined;
    stamp = a.timestamp ?? entry.timestamp;
  } else {
    return null;
  }
  if (!text) return null;
  if (isObject(origin) && origin.kind === "peer") return null;
  const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
  const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  if (!uuid || !Number.isFinite(at)) return null;
  return { uuid, at, text };
}

const NL = 0x0a;
const CHUNK = 1 << 20;

/**
 * the prompts appended to `file` since `prev`. `last` is the text of the transcript's last prompt
 * when this process still has it: without it, a read starts again at the last prompt's line so the
 * next one is judged beside it, as the eval set's were. a file shorter than its offset was
 * rewritten and is read again from 0
 */
export async function readPrompts(
  file: string,
  prev: FileState | undefined,
  known: Known,
  o: { last?: string; ignore?: (cwd: string) => boolean } = {},
): Promise<{ state: FileState; fresh: FreshPrompt[]; last?: string }> {
  const ignore = o.ignore ?? isTempCwd;
  const fh = await open(file, constants.O_RDONLY);
  try {
    const size = (await fh.stat()).size;
    const resume = prev && prev.offset <= size ? prev : undefined;
    // rewritten: what it held before is not a copy of what it holds now
    if (prev && !resume) {
      for (const p of prev.prompts) {
        known.uuids.delete(p.uuid);
        known.copies.delete(`${p.at}|${p.raw}`);
      }
    }
    const state: FileState = resume
      ? { ...resume, prompts: [...resume.prompts] }
      : emptyFileState();
    if (state.ignored) return { state, fresh: [] };
    const already = new Set(state.prompts.map((p) => p.uuid));
    const seenRaw = new Set(state.prompts.map((p) => p.raw));
    let last = resume ? o.last : undefined;
    let from = state.offset;
    if (last === undefined && state.lastAt !== undefined && state.prompts.length) {
      from = Math.min(state.lastAt, state.offset);
    }
    const found: Array<Typed & { lineAt: number }> = [];
    let at = from;
    let carry = Buffer.alloc(0);
    let carryAt = from;
    const buf = Buffer.alloc(CHUNK);
    while (at < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - at), at);
      if (bytesRead === 0) break;
      const chunk = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      const base = carry.length ? carryAt : at;
      at += bytesRead;
      let start = 0;
      for (let nl = chunk.indexOf(NL, start); nl >= 0; nl = chunk.indexOf(NL, start)) {
        const lineAt = base + start;
        const line = chunk.subarray(start, nl);
        start = nl + 1;
        if (line[0] !== 0x7b) continue;
        const s = line.toString("utf8");
        if (state.cwd === undefined) {
          const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(s);
          if (m?.[1] !== undefined) {
            state.cwd = JSON.parse(`"${m[1]}"`) as string;
            if (ignore(state.cwd)) {
              return {
                state: { offset: size, cwd: state.cwd, ignored: true, prompts: [] },
                fresh: [],
              };
            }
          }
        }
        // most bytes are tool results and the agent's answers: skip them before a parse
        const user =
          s.includes('"type":"user"') &&
          !s.includes('"toolUseResult":') &&
          !s.includes('"type":"tool_result"');
        if (!user && !s.includes('"queued_command"')) continue;
        let v: unknown;
        try {
          v = JSON.parse(s);
        } catch {
          continue;
        }
        if (!isObject(v)) continue;
        const typed = typedOn(v);
        if (typed) found.push({ ...typed, lineAt });
      }
      // a line still being written is read next time
      carryAt = base + start;
      carry = Buffer.from(chunk.subarray(start));
      state.offset = carryAt;
    }

    const fresh: FreshPrompt[] = [];
    // the eval set gave each prompt the one before it in time order
    found.sort((a, b) => a.at - b.at);
    for (const t of found) {
      if (already.has(t.uuid)) {
        // read again for its text: the one after it is judged beside it
        const ref = state.prompts.find((p) => p.uuid === t.uuid);
        if (ref) last = cleanForScoring(t.text);
        continue;
      }
      const raw = textHash(t.text.trim());
      if (known.uuids.has(t.uuid) || known.copies.has(`${t.at}|${raw}`) || seenRaw.has(raw)) {
        continue;
      }
      known.uuids.add(t.uuid);
      known.copies.add(`${t.at}|${raw}`);
      seenRaw.add(raw);
      if (isSlashCommand(t.text)) continue;
      const text = cleanForScoring(t.text);
      const ref: PromptRef = { uuid: t.uuid, at: t.at, hash: textHash(text), raw };
      if (ownWords(text) < MIN_WORDS) ref.short = true;
      state.prompts.push(ref);
      already.add(t.uuid);
      state.lastAt = Math.max(state.lastAt ?? 0, t.lineAt);
      fresh.push({ ...ref, text, ...(last !== undefined ? { prev: previousText(last) } : {}) });
      last = text;
    }
    return { state, fresh, ...(last !== undefined ? { last } : {}) };
  } finally {
    await fh.close();
  }
}
