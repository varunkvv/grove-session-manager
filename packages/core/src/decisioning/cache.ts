// what the judge said, kept in grove's state dir: per transcript how far it was read and the
// prompts in it (ids, times and hashes), and per prompt the model's probabilities. NEVER the text
// of a prompt. its own file: the editor extension rewrites the session index without it.
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { isObject, readJsonGuarded, writeFileAtomic } from "../fsx.ts";
import type { FileState } from "./prompts.ts";
import type { Probs, Rubric } from "./rubric.ts";
import { rubricKey } from "./rubric.ts";

const SCHEMA = 1;

/** a new rubric version is a new file: the questions changed, so every answer did */
export const scoresFileName = (rubric: Rubric): string =>
  `scores.${rubricKey(rubric)}.v${SCHEMA}.json`;

/** one prompt's answer: who gave it, and a probability per level in the rubric's question order */
export interface Kept {
  /** `scorerKey` of the model entry */
  m: string;
  p: number[][];
}

export interface ScoreFile {
  v: number;
  rubric: string;
  /** by transcript path */
  files: Record<string, FileState>;
  /** by `uuid:hash` */
  scores: Record<string, Kept>;
}

export const scoreKey = (p: { uuid: string; hash: string }): string => `${p.uuid}:${p.hash}`;

export function emptyScores(rubric: Rubric): ScoreFile {
  return { v: SCHEMA, rubric: rubricKey(rubric), files: {}, scores: {} };
}

const round = (x: number): number => Math.round(x * 1e5) / 1e5;

export function toKept(rubric: Rubric, scorer: string, probs: Probs): Kept {
  return { m: scorer, p: rubric.questions.map((q) => (probs[q.id] ?? []).map(round)) };
}

export function fromKept(rubric: Rubric, kept: Kept): Probs {
  const out: Probs = {};
  rubric.questions.forEach((q, i) => {
    out[q.id] = kept.p[i] ?? [];
  });
  return out;
}

function validFile(v: unknown): v is FileState {
  return isObject(v) && typeof v.offset === "number" && Array.isArray(v.prompts);
}

/**
 * the file for this rubric. answers another model gave are dropped: a swapped model scores again.
 * anything unreadable is nothing, it is a cache
 */
export async function loadScores(dir: string, rubric: Rubric, scorer: string): Promise<ScoreFile> {
  const read = await readJsonGuarded(path.join(dir, scoresFileName(rubric)));
  const out = emptyScores(rubric);
  if (read.status !== "ok" || !isObject(read.value)) return out;
  const v = read.value;
  if (v.v !== SCHEMA || v.rubric !== out.rubric) return out;
  if (isObject(v.files)) {
    for (const [file, state] of Object.entries(v.files))
      if (validFile(state)) out.files[file] = state;
  }
  if (isObject(v.scores)) {
    for (const [key, kept] of Object.entries(v.scores)) {
      if (isObject(kept) && kept.m === scorer && Array.isArray(kept.p)) {
        out.scores[key] = kept as unknown as Kept;
      }
    }
  }
  return out;
}

export async function saveScores(dir: string, rubric: Rubric, file: ScoreFile): Promise<void> {
  await writeFileAtomic(path.join(dir, scoresFileName(rubric)), JSON.stringify(file));
}

/** the files an older rubric or schema left behind */
export async function sweepOldScores(dir: string, rubric: Rubric): Promise<void> {
  const keep = scoresFileName(rubric);
  try {
    for (const name of await readdir(dir)) {
      if (/^scores\..+\.v\d+\.json$/.test(name) && name !== keep) {
        await unlink(path.join(dir, name)).catch(() => {});
      }
    }
  } catch {
    // no state dir yet
  }
}
