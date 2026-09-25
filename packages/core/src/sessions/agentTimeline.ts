import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isObject, readJsonGuarded, writeFileAtomic } from "../fsx.ts";
import { type Question, questionsOf, withPicks } from "./conversation.ts";
import {
  type LineRef,
  resultText,
  TIMELINE_VERSION,
  TimelineFold,
  type TimelineState,
} from "./timeline.ts";
import { readWholeLines } from "./transcriptLines.ts";

const READ_BYTES = 1 << 20;
const NL = 0x0a;
/** one line is never read back past this for a step's detail. a real tool result tops out near 40KB. */
const DETAIL_LINE_MAX = 16 << 20;
/** what an opened step shows. a scroller, not a file viewer. */
export const DETAIL_MAX_CHARS = 200_000;

/**
 * an agent's transcript folded into a timeline, from where `prev` stopped. whole lines only,
 * read a chunk at a time and decoded one line at a time, so a 4MB transcript is never one string -
 * and every step knows the byte offset of its line, which is how the full result is found again
 * without keeping it. a file shorter than `prev` read was rewritten, and is folded again from 0.
 */
export async function readAgentTimeline(
  file: string,
  prev?: TimelineState,
  opts: { home?: string } = {},
): Promise<TimelineState> {
  const fh = await open(file, constants.O_RDONLY);
  try {
    const size = (await fh.stat()).size;
    const resume =
      prev && prev.version === TIMELINE_VERSION && prev.offset <= size ? prev : undefined;
    const fold = new TimelineFold(resume, { home: opts.home ?? os.homedir() });
    if (fold.state.offset === size) return fold.state;
    fold.state.offset = await readWholeLines(fh, fold.state.offset, size, (text, at, length) =>
      fold.line(text, at, length),
    );
    return fold.state;
  } finally {
    await fh.close();
  }
}

async function readLine(file: string, ref: LineRef): Promise<Record<string, unknown> | null> {
  if (ref.length <= 0 || ref.length > DETAIL_LINE_MAX) return null;
  const fh = await open(file, constants.O_RDONLY);
  try {
    const buf = Buffer.alloc(ref.length);
    const { bytesRead } = await fh.read(buf, 0, ref.length, ref.offset);
    const entry: unknown = JSON.parse(buf.toString("utf8", 0, bytesRead));
    return isObject(entry) ? entry : null;
  } catch {
    // the file moved under us. the step just has no detail.
    return null;
  } finally {
    await fh.close();
  }
}

function contentOf(entry: Record<string, unknown> | null): unknown[] {
  const message = entry?.message;
  return isObject(message) && Array.isArray(message.content) ? message.content : [];
}

const clip = (s: string) =>
  s.length > DETAIL_MAX_CHARS
    ? { text: s.slice(0, DETAIL_MAX_CHARS), truncated: true }
    : { text: s, truncated: false };

/** one hunk of a unified diff: lines start with " ", "+" or "-" */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ToolDetail {
  /** the whole input, as indented json */
  input: string;
  result?: string;
  isError?: boolean;
  /** the result was longer than DETAIL_MAX_CHARS */
  truncated: boolean;
  /**
   * what the call did to files, as Claude Code worked it out: an Edit's or a Write's patch, or
   * the files a Bash command changed. a new file is its whole content, added.
   */
  diffs?: Array<{ path: string; hunks: DiffHunk[]; created?: boolean }>;
  /** a Bash call's two streams, apart */
  bash?: {
    stdout: string;
    stderr: string;
    interrupted: boolean;
    /** a big output went to a file instead: the path Claude Code says, never read */
    persisted?: string;
    /** Claude Code's reading of the exit code ("No matches found") */
    exit?: string;
    /** it went on in the background, under this task id */
    background?: string;
  };
  /** an AskUserQuestion: every question with every option, and what was picked */
  questions?: Question[];
  /** an ExitPlanMode: the plan, whole */
  plan?: string;
}

/**
 * everything about one tool call, read back from the two lines a step points at. this is the only
 * place a whole tool result is ever read: a step carries a preview and the offsets.
 */
export async function readToolDetail(
  file: string,
  step: { id: string; use: LineRef; ref?: LineRef },
): Promise<ToolDetail | null> {
  const useLine = await readLine(file, step.use);
  const call = contentOf(useLine).find(
    (b) =>
      isObject(b) && (b.type === "tool_use" || b.type === "server_tool_use") && b.id === step.id,
  );
  if (!isObject(call)) return null;
  const input = clip(JSON.stringify(call.input ?? {}, null, 2));
  const detail: ToolDetail = { input: input.text, truncated: input.truncated };
  if (!step.ref) {
    structured(detail, call, null);
    return detail;
  }
  const resultLine = await readLine(file, step.ref);
  const result = contentOf(resultLine).find(
    (b) => isObject(b) && b.type === "tool_result" && b.tool_use_id === step.id,
  );
  if (!isObject(result)) {
    structured(detail, call, null);
    return detail;
  }
  const text = clip(resultText(result.content));
  detail.result = text.text;
  detail.truncated ||= text.truncated;
  if (result.is_error === true) detail.isError = true;
  structured(detail, call, resultLine);
  return detail;
}

/** diff lines kept across every file of one call. a scroller, not a file viewer. */
const DIFF_LINES_MAX = 4_000;

function hunksOf(value: unknown, budget: { lines: number; chars: number }): DiffHunk[] {
  if (!Array.isArray(value)) return [];
  const hunks: DiffHunk[] = [];
  for (const h of value) {
    if (!isObject(h) || !Array.isArray(h.lines) || budget.lines <= 0) continue;
    const lines: string[] = [];
    for (const l of h.lines) {
      if (typeof l !== "string" || budget.lines <= 0 || budget.chars <= 0) break;
      lines.push(l);
      budget.lines--;
      budget.chars -= l.length;
    }
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    hunks.push({
      oldStart: n(h.oldStart),
      oldLines: n(h.oldLines),
      newStart: n(h.newStart),
      newLines: n(h.newLines),
      lines,
    });
  }
  return hunks;
}

/**
 * the parts of `toolUseResult` worth drawing rather than dumping: Claude Code writes it beside
 * every tool result in a session's own transcript (rarely in an agent's). `originalFile` is the
 * whole file before the edit, and is never copied out.
 */
function structured(
  detail: ToolDetail,
  call: Record<string, unknown>,
  line: Record<string, unknown> | null,
): void {
  const told = line?.toolUseResult;
  const name = call.name;
  const input = call.input;
  if (name === "ExitPlanMode" && isObject(input) && typeof input.plan === "string") {
    detail.plan = clip(input.plan).text;
  }
  if (name === "AskUserQuestion") {
    const questions = questionsOf(input);
    if (questions.length) {
      detail.questions = withPicks(questions, isObject(told) ? told.answers : undefined);
    }
  }
  if (!isObject(told)) return;
  const budget = { lines: DIFF_LINES_MAX, chars: DETAIL_MAX_CHARS };
  const diffs: NonNullable<ToolDetail["diffs"]> = [];
  if (typeof told.filePath === "string" && Array.isArray(told.structuredPatch)) {
    const hunks = hunksOf(told.structuredPatch, budget);
    if (hunks.length) diffs.push({ path: told.filePath, hunks });
    else if (told.type === "create" && typeof told.content === "string") {
      // a new file has no patch: all of it was added
      const lines = told.content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const added = hunksOf(
        [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: lines.length,
            lines: lines.map((l) => `+${l}`),
          },
        ],
        budget,
      );
      diffs.push({ path: told.filePath, hunks: added, created: true });
    }
  }
  const edited = isObject(told.bashEditDiff) ? told.bashEditDiff.files : undefined;
  if (Array.isArray(edited)) {
    for (const f of edited) {
      if (!isObject(f) || typeof f.filePath !== "string") continue;
      const hunks = hunksOf(f.hunks, budget);
      if (hunks.length) diffs.push({ path: f.filePath, hunks });
    }
  }
  if (diffs.length) detail.diffs = diffs;
  if (typeof told.stdout === "string" || typeof told.stderr === "string") {
    const out = clip(typeof told.stdout === "string" ? told.stdout : "");
    const err = clip(typeof told.stderr === "string" ? told.stderr : "");
    detail.truncated ||= out.truncated || err.truncated;
    detail.bash = { stdout: out.text, stderr: err.text, interrupted: told.interrupted === true };
    if (typeof told.persistedOutputPath === "string")
      detail.bash.persisted = told.persistedOutputPath;
    if (typeof told.returnCodeInterpretation === "string" && told.returnCodeInterpretation) {
      detail.bash.exit = told.returnCodeInterpretation;
    }
    if (typeof told.backgroundTaskId === "string") detail.bash.background = told.backgroundTaskId;
  }
}

/**
 * `workflows/<run>/journal.jsonl`: which agent each step of a workflow ran, and what it returned.
 * a workflow agent with an output schema ends in a StructuredOutput call rather than text, so
 * this is the result for any agent under a workflow.
 */
export async function readWorkflowJournal(dir: string): Promise<Map<string, unknown>> {
  const results = new Map<string, unknown>();
  let text: string;
  try {
    text = await readFile(path.join(dir, "journal.jsonl"), "utf8");
  } catch {
    return results;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isObject(entry) && entry.type === "result" && typeof entry.agentId === "string") {
        results.set(entry.agentId, entry.result);
      }
    } catch {
      // a torn last line while the workflow is still writing
    }
  }
  return results;
}

export interface WorkflowRun {
  /** `wf_...`, the name of the run's directory under subagents/workflows/ */
  runId: string;
  name?: string;
  summary?: string;
}

const RUN_NEEDLE = Buffer.from('"runId":"');

/**
 * the name of every workflow a session ran, from the Workflow tool's result in the session's own
 * transcript (`toolUseResult.runId` is the run's directory). the transcript can be 100MB, so the
 * bytes are searched and only a line that names a run is decoded.
 */
export async function readWorkflowRuns(transcriptPath: string): Promise<Map<string, WorkflowRun>> {
  const runs = new Map<string, WorkflowRun>();
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(transcriptPath, constants.O_RDONLY);
  } catch {
    return runs;
  }
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(READ_BYTES, Math.max(1, size)));
    let carry: Buffer = Buffer.alloc(0);
    let at = 0;
    while (at < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - at), at);
      if (bytesRead === 0) break;
      at += bytesRead;
      const chunk = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      const lastNl = chunk.lastIndexOf(NL);
      const whole = lastNl < 0 ? 0 : lastNl + 1;
      let from = 0;
      for (;;) {
        const hit = chunk.indexOf(RUN_NEEDLE, from);
        if (hit < 0 || hit >= whole) break;
        const start = chunk.lastIndexOf(NL, hit) + 1;
        const end = chunk.indexOf(NL, hit);
        from = end + 1;
        try {
          const entry: unknown = JSON.parse(chunk.toString("utf8", start, end));
          const r = isObject(entry) ? entry.toolUseResult : undefined;
          if (isObject(r) && typeof r.runId === "string") {
            runs.set(r.runId, {
              runId: r.runId,
              ...(typeof r.workflowName === "string" ? { name: r.workflowName } : {}),
              ...(typeof r.summary === "string" ? { summary: r.summary } : {}),
            });
          }
        } catch {
          // the needle sat inside something else. keep looking.
        }
      }
      carry = Buffer.from(chunk.subarray(whole));
    }
  } finally {
    await fh.close();
  }
  return runs;
}

/** a finished agent's folded timeline, kept so the next look is a file read instead of a fold */
export function timelineCacheDir(stateDir: string): string {
  return path.join(stateDir, `agent-timelines.v${TIMELINE_VERSION}`);
}

function cacheFileFor(dir: string, agentFile: string): string {
  return path.join(dir, `${createHash("sha1").update(agentFile).digest("hex").slice(0, 24)}.json`);
}

interface CachedTimeline {
  file: string;
  /** mtime:size of the agent's own file when it was folded */
  mark: string;
  state: TimelineState;
}

export function fileMark(info: { mtimeMs: number; size: number }): string {
  return `${info.mtimeMs}:${info.size}`;
}

/**
 * what was cached for this agent file, and the mark it was cached at. a state is returned even
 * when the file has grown since: it carries its offset, so the next read folds only what was
 * appended.
 */
export async function loadCachedTimeline(
  dir: string,
  agentFile: string,
): Promise<{ state: TimelineState; mark: string } | null> {
  const read = await readJsonGuarded<CachedTimeline>(cacheFileFor(dir, agentFile));
  if (read.status !== "ok" || !isObject(read.value)) return null;
  const { file, mark, state } = read.value;
  if (file !== agentFile || typeof mark !== "string" || !isObject(state)) return null;
  if (state.version !== TIMELINE_VERSION || !Array.isArray(state.steps)) return null;
  if (typeof state.offset !== "number") return null;
  return { state, mark };
}

export async function saveCachedTimeline(
  dir: string,
  agentFile: string,
  mark: string,
  state: TimelineState,
): Promise<void> {
  const entry: CachedTimeline = { file: agentFile, mark, state };
  await writeFileAtomic(cacheFileFor(dir, agentFile), JSON.stringify(entry));
}

/**
 * Claude Code deletes a transcript after 30 days, so a cache entry nobody has written for longer
 * almost certainly describes a file that is gone. if it is not, it is folded again - cheap.
 */
export async function sweepTimelineCache(
  dir: string,
  maxAgeMs = 35 * 24 * 3_600_000,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > maxAgeMs) await unlink(file).catch(() => {});
  }
}
