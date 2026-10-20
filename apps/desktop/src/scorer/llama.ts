// a model's answers through node-llama-cpp: the prompt is rendered as OneJev's qev-labels-v2 (core's
// onejev.ts), tokenized, and each question's letter logits are read off one sequence. the state is
// evaluated once and checkpointed, and every question is read from that checkpoint. the constant
// head (system prompt + rubric context) is checkpointed once for all prompts.
// port of the model bench's lib/onejev.mjs and lib/readouts.mjs, which held it to qev serve.
import {
  branchPlan,
  foldBranches,
  type ModelEntry,
  optionLetters,
  type Probs,
  promptTexts,
  type Rubric,
  type ScoreItem,
  softmax,
} from "@grove/core/pure";
import type { LlamaModel, Token } from "node-llama-cpp";

export interface LlamaScorer {
  gpu: string | false;
  score(item: ScoreItem): Promise<Probs | null>;
  dispose(): Promise<void>;
}

/** never builds or downloads llama.cpp: a missing binary is an error, not a network call */
export async function loadRuntime() {
  const { getLlama, LlamaLogLevel } = await import("node-llama-cpp");
  return getLlama({
    build: "never",
    skipDownload: true,
    progressLogs: false,
    logLevel: LlamaLogLevel.error,
  });
}

/** the letters A.. as one token each, the way OneJev was trained to answer */
export function letterTokens(model: LlamaModel, n: number): Token[] {
  return optionLetters(n).map((l) => {
    const t = model.tokenize(l, false);
    if (t.length !== 1 || model.detokenize(t) !== l) throw new Error(`slot ${l} is not one token`);
    return t[0] as Token;
  });
}

const sameUpTo = (a: readonly Token[], b: readonly Token[], n: number) => {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * tokenize every branch whole, then share the longest common token prefix that ends at or before
 * the end of the state (qev engine._prefix_and_suffix_ids). token lists are never concatenated
 */
export function promptTokens(
  model: LlamaModel,
  entry: ModelEntry,
  rubric: Rubric,
  item: ScoreItem,
) {
  const { prefix, full } = promptTexts(entry, rubric, item);
  const whole = full.map((t) => model.tokenize(t, true));
  const head = model.tokenize(prefix, true);
  let n = head.length;
  while (n > 0 && !whole.every((ids) => sameUpTo(ids, head, n))) n--;
  return { prefix: head.slice(0, n), branches: whole.map((ids) => ids.slice(n)) };
}

export async function openLlama(
  modelPath: string,
  entry: ModelEntry,
  rubric: Rubric,
): Promise<LlamaScorer> {
  const llama = await loadRuntime();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: entry.contextSize, sequences: 1 });
  const seq = context.getSequence();
  const plan = branchPlan(entry, rubric);
  const slots = letterTokens(model, Math.max(...plan.map((b) => b.slots)));

  // the head every prompt shares: where two different states' tokens part, less two for the merge
  const a = promptTokens(model, entry, rubric, { text: "a", prev: "b" }).prefix;
  const b = promptTokens(model, entry, rubric, { text: "c", prev: "d" }).prefix;
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  const head = a.slice(0, Math.max(0, n - 2));
  await seq.adaptStateToTokens(head, false);
  await seq.evaluateWithoutGeneratingNewTokens(head.slice(seq.nextTokenIndex));
  await seq.takeCheckpoint();

  return {
    gpu: llama.gpu,
    async score(item) {
      const { prefix, branches } = promptTokens(model, entry, rubric, item);
      // past the context it would be cut, and judged on less than was said: not judged at all
      if (branches.some((br) => prefix.length + br.length > entry.contextSize)) return null;
      if (branches.some((br) => br.length === 0)) return null;
      await seq.adaptStateToTokens(prefix, false);
      await seq.evaluateWithoutGeneratingNewTokens(prefix.slice(seq.nextTokenIndex));
      await seq.takeCheckpoint();
      const letters: number[][] = [];
      for (const [bi, br] of branches.entries()) {
        await seq.adaptStateToTokens(prefix, false);
        const want = slots.slice(0, plan[bi]?.slots ?? 0);
        const last = br.length - 1;
        const res = await seq.controlledEvaluate(
          br.map((t, i) =>
            i === last ? [t, { generateNext: { logits: { filter: { tokens: want } } } }] : t,
          ),
        );
        const logits = res[last]?.next?.logits;
        if (!logits) throw new Error("no logits");
        letters.push(softmax(want.map((t) => logits.get(t) ?? Number.NEGATIVE_INFINITY)));
      }
      return foldBranches(rubric, plan, letters);
    },
    async dispose() {
      await context.dispose();
      await model.dispose();
      await llama.dispose();
    },
  };
}
