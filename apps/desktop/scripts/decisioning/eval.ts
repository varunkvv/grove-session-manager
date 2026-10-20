// judgment day's eval, the real run: the app's own scorer (node-llama-cpp, the same prompt and
// readout as the scorer process) over a labelled dataset, held to evals/metrics.md's bars. never in
// CI and never in a test: it loads a real model. it prints numbers only, never a prompt.
//
//   node scripts/decisioning/eval.ts --data <evals dir> --model <file.gguf> [--entry <id>] [--limit N]
//   node scripts/decisioning/eval.ts --data <evals dir> --scores <scores.jsonl> [--margin 0.2]
//   node scripts/decisioning/eval.ts --regression --model <file.gguf>
//
// --data is a folder with prompts.jsonl (id, text, prev_text, session_id, day, ts, skipped) and a
// target (--target, default target-v3.1h.jsonl: id, deference, gratitude, blame, source). they are
// someone's own prompts: the scores and the report are written next to them, in reports/, and
// nowhere else. --scores evaluates answers already given, with the entry's calibration and margin,
// so a margin or a calibration can be tried without the model. --regression runs the repo's
// made-up set (packages/core/src/decisioning/regression.jsonl) and writes nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_MODEL,
  type EvalItem,
  type EvalTask,
  evaluate,
  GAVEL,
  MODELS,
  runTask,
  type Scored,
} from "@grove/core/pure";
import { openLlama } from "../../src/scorer/llama.ts";

const { values: a } = parseArgs({
  options: {
    data: { type: "string" },
    target: { type: "string", default: "target-v3.1h.jsonl" },
    model: { type: "string" },
    entry: { type: "string" },
    scores: { type: "string" },
    margin: { type: "string" },
    limit: { type: "string" },
    regression: { type: "boolean", default: false },
  },
});

const entry = a.entry ? MODELS.find((m) => m.id === a.entry) : DEFAULT_MODEL;
if (!entry) throw new Error(`no model entry ${a.entry}: ${MODELS.map((m) => m.id).join(", ")}`);
const reading = {
  ...(entry.calibration ? { calibration: entry.calibration } : {}),
  tieMargin: a.margin === undefined ? entry.tieMargin : Number(a.margin),
};
const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

let items: EvalItem[];
if (a.regression) {
  items = lines(
    path.join(import.meta.dirname, "../../../../packages/core/src/decisioning/regression.jsonl"),
  );
} else {
  if (!a.data) throw new Error("--data <evals dir>, or --regression");
  const target = new Map(lines(path.join(a.data, a.target ?? "")).map((t) => [t.id, t]));
  items = lines(path.join(a.data, "prompts.jsonl")).flatMap((p): EvalItem[] => {
    const t = target.get(p.id);
    if (p.skipped || !t) return [];
    return [
      {
        id: p.id,
        text: p.text,
        ...(p.prev_text ? { prev: p.prev_text } : {}),
        session: p.session_id,
        day: p.day,
        at: Date.parse(p.ts),
        labels: { deference: t.deference, gratitude: t.gratitude, blame: t.blame },
        ...(t.source ? { source: t.source.startsWith("gold") ? "gold" : t.source } : {}),
      },
    ];
  });
}
if (a.limit) items = items.slice(0, Number(a.limit));
const task: EvalTask = { id: `${GAVEL.id}-${GAVEL.ledger.version}`, rubric: GAVEL, items };

let scored: Scored[];
if (a.scores) {
  scored = lines(a.scores);
} else {
  if (!a.model) throw new Error("--model <file.gguf>, or --scores <scores.jsonl>");
  const t0 = performance.now();
  const llama = await openLlama(a.model, entry, GAVEL);
  console.error(
    `loaded ${entry.id} in ${Math.round(performance.now() - t0)} ms on ${llama.gpu || "cpu"}`,
  );
  scored = await runTask(
    task,
    (item) => llama.score(item),
    (done, total) => {
      if (done % 100 === 0 || done === total) console.error(`${done} of ${total}`);
    },
  );
  await llama.dispose();
}

const report = { entry: entry.id, reading, ...evaluate(task, scored, reading) };
if (!a.regression && a.data) {
  const dir = path.join(a.data, "reports");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  if (!a.scores) {
    const file = path.join(dir, `scores-${entry.id}-${stamp}.jsonl`);
    // ids, answers and times: no text
    writeFileSync(file, `${scored.map((s) => JSON.stringify(s)).join("\n")}\n`);
    console.error(file);
  }
  const file = path.join(dir, `eval-${entry.id}-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
  console.error(file);
}
console.log(JSON.stringify(report, null, 1));
