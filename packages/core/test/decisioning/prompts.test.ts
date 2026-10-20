import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyScores,
  fromKept,
  loadScores,
  saveScores,
  scoreKey,
  scoresFileName,
  sweepOldScores,
  toKept,
} from "../../src/decisioning/cache.ts";
import { type FileState, knownOf, readPrompts, textHash } from "../../src/decisioning/prompts.ts";
import { GAVEL } from "../../src/decisioning/rubric.ts";
import { assistantEntry, makeSandbox, toJsonl, userEntry } from "../helpers/transcript.ts";

// every prompt here is made up
const queued = (prompt: string, extra: Record<string, unknown> = {}) => ({
  type: "attachment",
  attachment: {
    type: "queued_command",
    prompt,
    origin: { kind: "human" },
    timestamp: "2026-09-01T11:00:00.000Z",
  },
  uuid: `q-${prompt.length}-${prompt.slice(0, 4)}`,
  timestamp: "2026-09-01T11:00:00.000Z",
  ...extra,
});

function transcript(lines: object[]): string {
  const file = path.join(makeSandbox("grove-prompts-"), "s.jsonl");
  writeFileSync(file, toJsonl(lines));
  return file;
}

const texts = (fresh: Array<{ text: string }>) => fresh.map((p) => p.text);

describe("reading a person's prompts", () => {
  it("finds typed prompts and messages queued mid-turn, each beside the one before", async () => {
    const file = transcript([
      userEntry("rename the parser module to reader please"),
      assistantEntry("done"),
      queued("also update the imports that use it"),
      userEntry([{ type: "tool_result", tool_use_id: "x", content: "ok" }]),
      userEntry("now run the unit tests for the reader"),
    ]);
    const { fresh, state } = await readPrompts(file, undefined, knownOf([]));
    expect(texts(fresh)).toEqual([
      "rename the parser module to reader please",
      "now run the unit tests for the reader",
      "also update the imports that use it",
    ]);
    expect(fresh[0]?.prev).toBeUndefined();
    expect(fresh[1]?.prev).toBe("rename the parser module to reader please");
    expect(state.prompts).toHaveLength(3);
    // the cache never holds the text
    expect(JSON.stringify(state)).not.toContain("parser");
    expect(state.prompts[0]?.hash).toBe(textHash("rename the parser module to reader please"));
  });

  it("leaves out turns a program started, other sessions' words, sidechains and slash commands", async () => {
    const file = transcript([
      userEntry("a headless run asked this of the agent", { turnOrigin: "sdk" }),
      userEntry("a scheduled wake up asked this one", { turnOrigin: "scheduled" }),
      userEntry("a script ran claude -p with this", { entrypoint: "sdk-cli" }),
      userEntry("another session sent this message here", { origin: { kind: "peer" } }),
      userEntry("a subagent's prompt from its parent", { isSidechain: true }),
      userEntry("/review the open branch please"),
      queued("not typed by a person at all", {
        attachment: { type: "queued_command", prompt: "x y z w", origin: { kind: "task" } },
      }),
      userEntry("this one is mine and it counts"),
    ]);
    const { fresh } = await readPrompts(file, undefined, knownOf([]));
    expect(texts(fresh)).toEqual(["this one is mine and it counts"]);
  });

  it("keeps a short prompt for the order but marks it, and skips a repeat of the same words", async () => {
    const file = transcript([
      userEntry("ok go"),
      userEntry("now add the missing test case"),
      userEntry("now add the missing test case"),
    ]);
    const { fresh } = await readPrompts(file, undefined, knownOf([]));
    expect(fresh.map((p) => [p.text, p.short === true])).toEqual([
      ["ok go", true],
      ["now add the missing test case", false],
    ]);
    expect(fresh[1]?.prev).toBe("ok go");
  });

  it("ignores a transcript whose session ran in a temp folder", async () => {
    const file = transcript([
      userEntry("a trial run's scripted prompt", { cwd: "/private/tmp/x" }),
    ]);
    const { fresh, state } = await readPrompts(file, undefined, knownOf([]));
    expect(fresh).toEqual([]);
    expect(state.ignored).toBe(true);
    // unless the caller reads temp folders too (a test root)
    const again = await readPrompts(file, undefined, knownOf([]), { ignore: () => false });
    expect(again.fresh).toHaveLength(1);
  });

  it("reads only what was appended, and judges the next prompt beside the last one", async () => {
    const file = transcript([userEntry("first we fix the flaky login test")]);
    const one = await readPrompts(file, undefined, knownOf([]));
    appendFileSync(file, toJsonl([assistantEntry("fixed"), userEntry("then bump the version")]));
    // this process still has the last prompt's text
    const warm = await readPrompts(file, one.state, knownOf([one.state]), { last: one.last });
    expect(texts(warm.fresh)).toEqual(["then bump the version"]);
    expect(warm.fresh[0]?.prev).toBe("first we fix the flaky login test");
    // a restart has no text: it reads the last prompt's line again for it
    const cold = await readPrompts(file, one.state, knownOf([one.state]));
    expect(texts(cold.fresh)).toEqual(["then bump the version"]);
    expect(cold.fresh[0]?.prev).toBe("first we fix the flaky login test");
    expect(cold.state.prompts).toHaveLength(2);
    // nothing new: nothing fresh
    const none = await readPrompts(file, cold.state, knownOf([cold.state]));
    expect(none.fresh).toEqual([]);
  });

  it("waits for a line still being written", async () => {
    const file = transcript([userEntry("the first whole prompt here")]);
    const line = JSON.stringify(userEntry("the second one arrives in two parts"));
    appendFileSync(file, line.slice(0, 40));
    const part = await readPrompts(file, undefined, knownOf([]));
    expect(part.fresh).toHaveLength(1);
    appendFileSync(file, `${line.slice(40)}\n`);
    const rest = await readPrompts(file, part.state, knownOf([part.state]), { last: part.last });
    expect(texts(rest.fresh)).toEqual(["the second one arrives in two parts"]);
  });

  it("skips a prompt copied into another transcript, and reads a rewritten one again", async () => {
    const original = userEntry("the copied prompt from the fork");
    const a = transcript([original]);
    const read = await readPrompts(a, undefined, knownOf([]));
    const b = transcript([original, userEntry("then something new in the fork")]);
    const known = knownOf([read.state]);
    const fork = await readPrompts(b, undefined, known);
    expect(texts(fork.fresh)).toEqual(["then something new in the fork"]);

    writeFileSync(a, toJsonl([userEntry("rewritten from the start")]));
    const again = await readPrompts(a, read.state, knownOf([read.state]));
    expect(texts(again.fresh)).toEqual(["rewritten from the start"]);
  });
});

describe("the score cache", () => {
  it("keeps scores by prompt, per rubric version, and drops another model's", async () => {
    const dir = makeSandbox("grove-scores-");
    const file = emptyScores(GAVEL);
    const state: FileState = {
      offset: 10,
      prompts: [{ uuid: "u1", at: 1, hash: "h1", raw: "r1" }],
    };
    file.files["/t/a.jsonl"] = state;
    const probs = {
      deference: [0, 1, 0, 0, 0],
      gratitude: [1, 0, 0, 0, 0],
      blame: [1, 0, 0, 0, 0],
    };
    file.scores[scoreKey({ uuid: "u1", hash: "h1" })] = toKept(GAVEL, "model-a", probs);
    await saveScores(dir, GAVEL, file);
    expect(scoresFileName(GAVEL)).toBe("scores.gavel-v3.1.v1.json");

    const same = await loadScores(dir, GAVEL, "model-a");
    expect(same.files["/t/a.jsonl"]).toEqual(state);
    expect(fromKept(GAVEL, same.scores["u1:h1"]!)).toEqual(probs);
    // a swapped model scores again: its answers are not these
    const other = await loadScores(dir, GAVEL, "model-b");
    expect(other.scores).toEqual({});
    expect(other.files["/t/a.jsonl"]).toEqual(state);

    writeFileSync(path.join(dir, "scores.gavel-v3.v1.json"), "{}");
    await sweepOldScores(dir, GAVEL);
    expect((await import("node:fs")).readdirSync(dir)).toEqual(["scores.gavel-v3.1.v1.json"]);
  });

  it("is nothing when it cannot be read", async () => {
    const dir = makeSandbox("grove-scores-");
    writeFileSync(path.join(dir, scoresFileName(GAVEL)), "{not json");
    expect(await loadScores(dir, GAVEL, "m")).toEqual(emptyScores(GAVEL));
  });
});
