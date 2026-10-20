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
 * OneJev 1.6 4B at Q4_K_M, picked by the model bench on 2026-10-20 against the v3.1h target (his gold
 * labels where he gave them, the harsher silver elsewhere). its calibration (a temperature and a
 * bias per level, per question) and the 0.1 margin for "borderline goes harsher" were fit there and
 * held out by session: session end odds Spearman 0.764, median odds difference 2.8, day odds
 * Spearman 0.81, neutral prompts read as an offence 0.08%. on an M4 Max: about 1.4 s a prompt, 3.5
 * GB resident while it judges, 1.5 s to load. the longest of his prompts is 1,301 tokens
 */
const ONEJEV_4B: ModelEntry = {
  id: "onejev1.6-4b-q4_k_m",
  label: "OneJev 1.6 4B",
  repo: "mradermacher/OneJev1.6-4B-GGUF",
  file: "OneJev1.6-4B.Q4_K_M.gguf",
  revision: "2b605ac93b0fc86f50e4836ac1eb0d33f1311bac",
  sha256: "8a12b976e7d2ea60fb603720ce07e2ef5e85b9b8a2a5519cb0bf2cc72aacac8d",
  size: 2_708_805_024,
  license: "Apache-2.0",
  prompt: "qev-labels-v2",
  layout: "context-in-state",
  readout: { kind: "score" },
  hint: true,
  contextSize: 2048,
  calibration: {
    deference: { temperature: 0.8257, bias: [0.5297, 0.9147, 1.0645, 0.4327, -2.9416] },
    gratitude: { temperature: 0.5587, bias: [0.1794, 0.01, -0.0394, -0.103, -0.047] },
    blame: { temperature: 0.7641, bias: [0.4665, 0.1712, 0.4032, 0.0399, -1.0809] },
  },
  tieMargin: 0.1,
  minMemoryGB: 16,
};

export const MODELS: readonly ModelEntry[] = [ONEJEV_4B];

/** the one grove downloads */
export const DEFAULT_MODEL: ModelEntry = ONEJEV_4B;

/**
 * the weights' name on disk: their hash, not the upstream file name. the same bytes moved to
 * another repo or renamed are never downloaded again, and two entries never share a path
 */
export const weightsFileName = (sha256: string): string => `${sha256.slice(0, 16)}.gguf`;

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
