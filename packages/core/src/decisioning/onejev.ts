// OneJev's `qev-labels-v2` prompt, the way the scorer renders it: a port of qev/prompt.py
// (render_question, state_block, build_messages) and the Qwen3.5 chat template with thinking off.
// text only. the scorer tokenizes it and reads the letters' logits. pure, so it is tested without a
// model: test/decisioning/onejev.test.ts holds it to qev's own rendering, character for character.
import type { ModelEntry } from "./models.ts";
import type { Probs, Rubric, RubricQuestion } from "./rubric.ts";

export const PROMPT_VERSION = "qev-labels-v2";
export const SYSTEM_PROMPT =
  "Apply the question to the state. Choose exactly one of the listed options. " +
  "Respond with only its uppercase letter, with no explanation or reasoning.";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NOUL_TRUE = "the statement is true / the answer is yes";
const NOUL_FALSE = "the statement is false / the answer is no";

/** one prompt as the model reads it: what was typed, and the person's prompt before it */
export interface ScoreItem {
  text: string;
  prev?: string;
}

export type JudgeState = string | Record<string, string>;

/** python's json.dumps(x, ensure_ascii=False, indent=2) gives the same bytes for these */
export function renderState(state: JudgeState | null | undefined): string {
  if (state == null) return "";
  if (typeof state === "string") return state;
  return JSON.stringify(state, null, 2);
}

export function stateBlock(state: JudgeState): string {
  return `<state>\n${renderState(state)}\n</state>\n\n`;
}

/** a Score question with its levels listed in `order` (each keeps its own number) */
export function scoreSuffix(instructions: string, criteria: readonly string[], order?: number[]) {
  const letters = LETTERS.slice(0, criteria.length).split("");
  const levels = order ?? criteria.map((_, i) => i);
  const opts = levels
    .map((orig, pos) => {
      const text = String(criteria[orig] ?? "").trim();
      return text ? `${letters[pos]}. level ${orig}: ${text}` : `${letters[pos]}. level ${orig}`;
    })
    .join("\n");
  const instr = String(instructions ?? "").trim() || "Which level describes the state?";
  return `Rate the state: ${instr}\n\nOptions:\n${opts}\n\nAnswer with one letter: ${letters.join(", ")}.`;
}

/** a yes/no question with qev's default options */
export function noulSuffix(instructions: string): string {
  return `Question: ${String(instructions).trim()}\n\nOptions:\nA. yes: ${NOUL_TRUE}\nB. no: ${NOUL_FALSE}\n\nAnswer with one letter: A, B.`;
}

export function noulInstructions(q: RubricQuestion, level: number): string {
  return `${q.instructions.trim()}\n\nDoes this describe the message? ${String(q.criteria[level]).trim()}`;
}

/** Qwen3.5's chat template: two messages, the generation prompt, thinking switched off */
export function chatPrompt(system: string, user: string): string {
  return (
    `<|im_start|>system\n${system}<|im_end|>\n` +
    `<|im_start|>user\n${user}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n\n</think>\n\n`
  );
}

/** the rubric's context, with its judge hint when the entry asks for it */
export function judgeContext(entry: Pick<ModelEntry, "hint">, rubric: Rubric): string {
  return entry.hint && rubric.judge_hint
    ? `${rubric.context} ${rubric.judge_hint}`
    : rubric.context;
}

export function modelState(
  entry: Pick<ModelEntry, "hint" | "layout">,
  rubric: Rubric,
  item: ScoreItem,
) {
  const s: Record<string, string> = {};
  if (entry.layout === "context-in-state") s.context = judgeContext(entry, rubric);
  if (item.prev) s.previous_message = item.prev;
  s.message = item.text;
  return s;
}

export function modelQuestions(
  entry: Pick<ModelEntry, "hint" | "layout">,
  rubric: Rubric,
): RubricQuestion[] {
  if (entry.layout === "context-in-state") return rubric.questions;
  const context = judgeContext(entry, rubric);
  return rubric.questions.map((q) => ({ ...q, instructions: `${context}\n\n${q.instructions}` }));
}

/** one forward pass's question: its text after the shared state, and how its letters map back */
export interface Branch {
  /** the question's index in the rubric */
  q: number;
  suffix: string;
  /** how many letters it offers */
  slots: number;
  /** score / shift: the level at each letter */
  order?: number[];
  /** noul: the level it asks about */
  level?: number;
}

export function branchPlan(entry: Pick<ModelEntry, "readout" | "hint" | "layout">, rubric: Rubric) {
  const out: Branch[] = [];
  modelQuestions(entry, rubric).forEach((q, qi) => {
    const k = q.criteria.length;
    if (entry.readout.kind === "noul") {
      for (let level = 0; level < k; level++) {
        out.push({ q: qi, suffix: noulSuffix(noulInstructions(q, level)), slots: 2, level });
      }
      return;
    }
    const n = entry.readout.kind === "shift" ? Math.min(entry.readout.shifts, k) : 1;
    for (let s = 0; s < n; s++) {
      const order = Array.from({ length: k }, (_, i) => (i + s) % k);
      out.push({ q: qi, suffix: scoreSuffix(q.instructions, q.criteria, order), slots: k, order });
    }
  });
  return out;
}

/** each branch's letter probabilities -> a probability per level, per question */
export function foldBranches(rubric: Rubric, plan: readonly Branch[], letters: number[][]): Probs {
  const sums = rubric.questions.map((q) => new Array<number>(q.criteria.length).fill(0));
  plan.forEach((b, i) => {
    const p = letters[i] ?? [];
    const acc = sums[b.q];
    if (!acc) return;
    if (b.level !== undefined) acc[b.level] = p[0] ?? 0;
    else {
      for (const [pos, level] of (b.order ?? []).entries()) {
        acc[level] = (acc[level] ?? 0) + (p[pos] ?? 0);
      }
    }
  });
  const out: Probs = {};
  rubric.questions.forEach((q, i) => {
    const s = sums[i] ?? [];
    const total = s.reduce((n, v) => n + v, 0);
    out[q.id] = total > 0 ? s.map((v) => v / total) : s.map(() => 1 / s.length);
  });
  return out;
}

/** every branch's whole prompt, and the text the branches share, cut where the state ends */
export function promptTexts(
  entry: Pick<ModelEntry, "readout" | "hint" | "layout">,
  rubric: Rubric,
  item: ScoreItem,
): { prefix: string; full: string[] } {
  const state = modelState(entry, rubric, item);
  const MARK = "QEV_PREFIX_MARK";
  const head = chatPrompt(SYSTEM_PROMPT, stateBlock(state) + MARK);
  return {
    prefix: head.slice(0, head.indexOf(MARK)),
    full: branchPlan(entry, rubric).map((b) =>
      chatPrompt(SYSTEM_PROMPT, stateBlock(state) + b.suffix),
    ),
  };
}

export function softmax(logits: readonly number[], temperature = 1): number[] {
  const z = logits.map((x) => x / temperature);
  const top = Math.max(...z);
  const e = z.map((x) => Math.exp(x - top));
  const sum = e.reduce((n, v) => n + v, 0);
  return e.map((v) => v / sum);
}

export const optionLetters = (n: number): string[] => LETTERS.slice(0, n).split("");
