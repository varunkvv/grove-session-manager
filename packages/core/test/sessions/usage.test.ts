import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionIndex } from "../../src/sessions/indexer.ts";
import { scanSessionUsage, scanUsage } from "../../src/sessions/usage.ts";
import {
  formatTokens,
  modelLabel,
  summarizeUsage,
  type UsageTally,
} from "../../src/transcript/usage.ts";
import {
  assistantEntry,
  makeSandbox,
  SID,
  toJsonl,
  userEntry,
  writeTranscript,
} from "../helpers/transcript.ts";

/** one content block of a response. Claude Code writes one line per block, all with the same id. */
function block(
  id: string,
  model: string,
  u: { in?: number; out?: number; read?: number; write?: number },
) {
  const e = assistantEntry("x");
  return {
    ...e,
    requestId: `req_${id}`,
    message: {
      ...e.message,
      id,
      model,
      usage: {
        input_tokens: u.in ?? 0,
        output_tokens: u.out ?? 0,
        cache_read_input_tokens: u.read ?? 0,
        cache_creation_input_tokens: u.write ?? 0,
      },
    },
  };
}

const OPUS = "claude-opus-5";
const HAIKU = "claude-haiku-4-5-20251001";

function setup(lines: Array<object | string>) {
  const base = makeSandbox("grove-usage-");
  const projectsDir = path.join(base, "projects");
  mkdirSync(projectsDir);
  const file = writeTranscript(projectsDir, "/Users/you/src/api", SID.a, lines);
  return { base, projectsDir, file };
}

const models = (t: UsageTally) => summarizeUsage([t]);

describe("token usage", () => {
  it("a response written as several blocks counts once, with the last block's usage", async () => {
    const { file } = setup([
      userEntry("hi"),
      block("msg_1", OPUS, { in: 2, out: 10, read: 100, write: 50 }),
      block("msg_1", OPUS, { in: 2, out: 40, read: 100, write: 50 }),
      block("msg_2", OPUS, { in: 1, out: 5, read: 200 }),
      // blocks of one response are not always adjacent
      block("msg_1", OPUS, { in: 2, out: 60, read: 100, write: 50 }),
    ]);
    expect(models(await scanUsage(file))).toEqual([
      { model: OPUS, input: 3, output: 65, cacheRead: 300, cacheWrite: 50, messages: 2 },
    ]);
  });

  it("synthetic entries and lines without usage are not spend", async () => {
    const { file } = setup([
      block("msg_1", "<synthetic>", { out: 999 }),
      assistantEntry("no usage here"),
      "{not json",
      block("msg_2", HAIKU, { in: 7, out: 3 }),
    ]);
    expect(models(await scanUsage(file))).toEqual([
      { model: HAIKU, input: 7, output: 3, cacheRead: 0, cacheWrite: 0, messages: 1 },
    ]);
  });

  it("an append is read from where the last scan stopped, and lands on the same totals", async () => {
    const first = [block("msg_1", OPUS, { out: 10 }), block("msg_2", OPUS, { out: 5 })];
    const more = [block("msg_2", OPUS, { out: 25 }), block("msg_3", HAIKU, { in: 4, out: 1 })];
    const { file } = setup(first);
    const before = await scanUsage(file);
    appendFileSync(file, toJsonl(more));
    const incremental = await scanUsage(file, before);
    expect(incremental.offset).toBeGreaterThan(before.offset);

    const whole = setup([...first, ...more]).file;
    expect(models(incremental)).toEqual(models(await scanUsage(whole)));
    // the response that straddled the two scans was replaced, not counted twice
    expect(models(incremental).find((m) => m.model === OPUS)).toMatchObject({
      output: 35,
      messages: 2,
    });
  });

  it("a half-written last line is left for the next scan", async () => {
    const { file } = setup([block("msg_1", OPUS, { out: 10 })]);
    const line = JSON.stringify(block("msg_2", OPUS, { out: 5 }));
    appendFileSync(file, line.slice(0, 40));
    const partial = await scanUsage(file);
    expect(models(partial)[0]?.messages).toBe(1);
    appendFileSync(file, `${line.slice(40)}\n`);
    expect(models(await scanUsage(file, partial))[0]).toMatchObject({ output: 15, messages: 2 });
  });

  it("a file shorter than the saved offset was rewritten, and is counted from the start", async () => {
    const { file } = setup([block("msg_1", OPUS, { out: 10 }), block("msg_2", OPUS, { out: 10 })]);
    const before = await scanUsage(file);
    writeFileSync(file, toJsonl([block("msg_9", HAIKU, { out: 3 })]));
    expect(models(await scanUsage(file, before))).toEqual([
      { model: HAIKU, input: 0, output: 3, cacheRead: 0, cacheWrite: 0, messages: 1 },
    ]);
  });

  it("subagents and workflow agents count toward their session", async () => {
    const { file } = setup([block("msg_1", OPUS, { out: 10 })]);
    const dir = path.join(path.dirname(file), SID.a, "subagents");
    mkdirSync(path.join(dir, "workflows", "wf_1"), { recursive: true });
    writeFileSync(path.join(dir, "agent-a.jsonl"), toJsonl([block("msg_2", HAIKU, { out: 4 })]));
    writeFileSync(
      path.join(dir, "workflows", "wf_1", "agent-b.jsonl"),
      toJsonl([block("msg_3", HAIKU, { out: 6 })]),
    );
    const files = await scanSessionUsage(file);
    expect(Object.keys(files).sort()).toEqual([
      "",
      path.join(SID.a, "subagents", "agent-a.jsonl"),
      path.join(SID.a, "subagents", "workflows", "wf_1", "agent-b.jsonl"),
    ]);
    expect(summarizeUsage(Object.values(files)).map((m) => [m.model, m.output])).toEqual([
      [HAIKU, 10],
      [OPUS, 10],
    ]);
  });

  it("the index counts in a second pass, keeps it in the cache, and follows appends", async () => {
    const { base, projectsDir, file } = setup([userEntry("hi"), block("msg_1", OPUS, { out: 10 })]);
    const cacheDir = path.join(base, "cache");
    const index = createSessionIndex({ projectsDir, cacheDir, usage: true });
    await index.refresh();
    expect(index.list()[0]?.usage).toEqual([
      { model: OPUS, input: 0, output: 10, cacheRead: 0, cacheWrite: 0, messages: 1 },
    ]);

    appendFileSync(file, toJsonl([block("msg_2", HAIKU, { out: 3 })]));
    const { changed, record } = await index.refreshFile(file);
    expect(changed).toBe(true);
    expect(record?.usage?.map((m) => m.model)).toEqual([OPUS, HAIKU]);

    // a fresh index gets the counts from the cache without reading the transcript again
    const again = createSessionIndex({ projectsDir, cacheDir, usage: true });
    await again.load();
    await again.refresh();
    expect(again.list()[0]?.usage?.map((m) => m.output)).toEqual([10, 3]);

    // off by default: the extension has no use for it and should not read whole files
    const plain = createSessionIndex({ projectsDir, cacheDir: null });
    await plain.refresh();
    expect(plain.list()[0]?.usage).toBeUndefined();
  });
});

describe("usage labels", () => {
  it("model ids read as a name and a version", () => {
    expect(modelLabel("claude-opus-5")).toBe("opus 5");
    expect(modelLabel("claude-fable-5-1")).toBe("fable 5.1");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
    expect(modelLabel("claude-opus-5[1m]")).toBe("opus 5 1m");
    expect(modelLabel("some-other-model")).toBe("some-other-model");
  });

  it("token counts are short", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(999_700)).toBe("1M");
    expect(formatTokens(3_450_000)).toBe("3.5M");
    expect(formatTokens(1_100_000_000)).toBe("1.1B");
  });
});
