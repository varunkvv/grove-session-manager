// what the scorer process does with each message, apart from the process itself: main.ts plugs it
// into electron's parent port, and a test into a fake child. one message at a time, in order.
// it never logs what it is given.
import { stubScore } from "@grove/core/pure";
import { type LlamaScorer, loadRuntime, openLlama } from "./llama.ts";
import type { FromScorer, ScorerMode, ToScorer } from "./protocol.ts";

export function scorerHandler(send: (m: FromScorer) => void): (m: ToScorer) => Promise<void> {
  let mode: ScorerMode | null = null;
  let llama: LlamaScorer | null = null;
  let rubric: Extract<ToScorer, { type: "load" }>["rubric"] | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function handle(m: ToScorer): Promise<void> {
    if (m.type === "probe") {
      try {
        const l = await loadRuntime();
        send({ type: "probed", gpu: l.gpu });
        await l.dispose();
      } catch (e) {
        send({ type: "probed", gpu: false, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (m.type === "load") {
      try {
        await llama?.dispose();
        llama = null;
        rubric = m.rubric;
        mode = m.mode;
        if (m.mode === "llama") llama = await openLlama(m.modelPath, m.model, m.rubric);
        send({ type: "loaded", gpu: llama?.gpu ?? false });
      } catch (e) {
        mode = null;
        send({ type: "failed", error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    const results = [];
    for (const item of m.items) {
      try {
        if (mode === "stub" && rubric) results.push(stubScore(rubric, item.text));
        else if (mode === "llama" && llama) results.push(await llama.score(item));
        else results.push(null);
      } catch {
        results.push(null);
      }
    }
    send({ type: "scored", id: m.id, results });
  }

  return (m) => {
    queue = queue.then(() => handle(m));
    return queue;
  };
}
