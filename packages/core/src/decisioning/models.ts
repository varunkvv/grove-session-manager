// the local models grove can judge prompts with. one entry is everything that decides a model's
// answers: the file, how the prompt is laid out, how a level is read off it, and what is done to the
// probabilities after. swapping the model is swapping the entry, nothing else.
import type { Calibration } from "./rubric.ts";

/**
 * how a question is read off the model:
 * - `score`: every level listed with a letter, the next-token logits of the letters
 * - `shift`: the same under `shifts` cyclic orders of the levels, mapped back and averaged
 * - `noul`: one yes/no per level ("does this level describe the message?"), P(yes) normalised
 */
export type Readout = { kind: "score" } | { kind: "shift"; shifts: number } | { kind: "noul" };

/**
 * what the model reads as the state:
 * - `context-in-state`: `{context, previous_message?, message}`, the context first so it is a
 *   shared prefix every prompt reuses
 * - `message-only`: `{previous_message?, message}`, the context moved into each question
 */
export type Layout = "context-in-state" | "message-only";

export interface ModelEntry {
  /** kept with every answer: a different id is a different model, and its answers are dropped */
  id: string;
  /** as Settings names it */
  label: string;
  /** Hugging Face repo, file and the commit it is pinned to */
  repo: string;
  file: string;
  revision: string;
  /** of the whole file. a download that does not hash to it is thrown away */
  sha256: string;
  /** bytes */
  size: number;
  license: string;
  /** the chat prompt it was trained on. one today: OneJev's own */
  prompt: "qev-labels-v2";
  layout: Layout;
  readout: Readout;
  /** the rubric's judge hint is appended to the context */
  hint: boolean;
  /** tokens. the longest prompt is cut to fit, never scored past it */
  contextSize: number;
  /** per question, on log probabilities. absent is none */
  calibration?: Calibration;
  /** "harsher on ties": adjacent top two within this much take the harsher level */
  tieMargin: number;
  /** the least memory a mac needs to run it, in GB */
  minMemoryGB: number;
}

/**
 * PLACEHOLDER until phase 0 picks the model (plans/2026-10-20-judgment-day-odds.md): OneJev 1.6
 * 0.8B at Q8_0, which passes on speed and memory and not on quality. the tile stays off until a
 * model clears the bars, and this entry is the only thing that changes when one does
 */
const ONEJEV_08B: ModelEntry = {
  id: "onejev1.6-0.8b-q8_0",
  label: "OneJev 1.6 0.8B",
  repo: "mradermacher/OneJev1.6-0.8B-GGUF",
  file: "OneJev1.6-0.8B.Q8_0.gguf",
  revision: "74d2d1a64836edfd866293008c7265ed32b95f4d",
  sha256: "1225c4f8d907636c2d4725ae5ca33a2ba32a64e84efc6a09052839790970b3ae",
  size: 811_844_096,
  license: "Apache-2.0",
  prompt: "qev-labels-v2",
  layout: "context-in-state",
  readout: { kind: "score" },
  hint: true,
  contextSize: 2048,
  tieMargin: 0.2,
  minMemoryGB: 8,
};

export const MODELS: readonly ModelEntry[] = [ONEJEV_08B];

/** the one grove downloads */
export const DEFAULT_MODEL: ModelEntry = ONEJEV_08B;

export const modelUrl = (m: Pick<ModelEntry, "repo" | "revision" | "file">): string =>
  `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`;

/** what an answer was given by: the model, how it was asked and how it was read */
export const scorerKey = (m: ModelEntry): string =>
  [
    m.id,
    m.prompt,
    m.layout,
    m.readout.kind === "shift" ? `shift${m.readout.shifts}` : m.readout.kind,
    m.hint ? "hint" : "nohint",
  ].join("/");
