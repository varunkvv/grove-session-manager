// the token check: grove's prompt, tokenized the way the scorer does it, against OneJev's own
// renderer and tokenizer (qev) on made-up cases. a manual check: it loads a model's vocabulary.
//
//   uv run ... python -I ../../../../packages/core/scripts/decisioning/golden_qev.py <rubric> <cases> <out.json>
//   node scripts/decisioning/tokens.ts <file.gguf> <out.json>
//
// prints counts only. every case should match on the prefix, every branch and the letters.
import { readFileSync } from "node:fs";
import { DEFAULT_MODEL, GAVEL } from "@grove/core/pure";
import { letterTokens, loadRuntime, promptTokens } from "../../src/scorer/llama.ts";

const [gguf, golden] = process.argv.slice(2);
if (!gguf || !golden)
  throw new Error("usage: node scripts/decisioning/tokens.ts <file.gguf> <golden_qev out.json>");
const ref = JSON.parse(readFileSync(golden, "utf8"));
const llama = await loadRuntime();
const model = await llama.loadModel({ modelPath: gguf, vocabOnly: true });
const entry = {
  ...DEFAULT_MODEL,
  layout: "context-in-state" as const,
  readout: { kind: "score" as const },
  hint: true,
};
const same = (x: readonly number[], y: readonly number[]) =>
  x.length === y.length && x.every((v, i) => v === y[i]);
const letters = letterTokens(model, 5);
let prefix = 0;
let branches = 0;
for (const c of ref.cases) {
  const mine = promptTokens(model, entry, GAVEL, {
    text: c.text,
    ...(c.prev ? { prev: c.prev } : {}),
  });
  prefix += same(mine.prefix, c.tokens.prefix) ? 1 : 0;
  branches += mine.branches.every((b, i) => same(b, c.tokens.suffixes[i])) ? 1 : 0;
}
console.log(
  JSON.stringify({
    cases: ref.cases.length,
    prefixEqual: prefix,
    branchesEqual: branches,
    lettersEqual: same(
      letters,
      ref.letters.map((l: number[]) => l[0]),
    ),
  }),
);
await model.dispose();
await llama.dispose();
