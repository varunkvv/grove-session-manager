// main <-> the scorer process. what crosses is a prompt's cleaned text, its previous one and the
// answers: nothing is logged on either side.
import type { ModelEntry, Probs, Rubric, ScoreItem } from "@grove/core/pure";

/** `stub`: no model at all, the keyword stub (a test root). `llama`: node-llama-cpp and the weights */
export type ScorerMode = "stub" | "llama";

export type ToScorer =
  | { type: "load"; mode: ScorerMode; modelPath: string; model: ModelEntry; rubric: Rubric }
  | { type: "score"; id: number; items: ScoreItem[] }
  /** loads the runtime and no model: the packaged app's check that its native addon loads */
  | { type: "probe" };

export type FromScorer =
  | { type: "loaded"; gpu: string | false }
  | { type: "failed"; error: string }
  /** one answer per item, in order. null: not judged (longer than the context, or it failed) */
  | { type: "scored"; id: number; results: Array<Probs | null> }
  | { type: "probed"; gpu: string | false; error?: string };
