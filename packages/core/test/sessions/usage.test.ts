import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cacheFileName, USAGE_SCHEMA } from "../../src/sessions/cache.ts";
import { createSessionIndex } from "../../src/sessions/indexer.ts";
import { scanSessionUsage, scanUsage } from "../../src/sessions/usage.ts";
import { costOf, priceOf } from "../../src/transcript/pricing.ts";
import {
  formatTokens,
  GAP_CAP_MS,
  localDay,
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

  it("a record's model is its own transcript's, however much its subagents spent", async () => {
    const { projectsDir, file } = setup([userEntry("hi"), block("msg_1", OPUS, { out: 10 })]);
    const dir = path.join(path.dirname(file), SID.a, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "agent-a.jsonl"), toJsonl([block("msg_2", HAIKU, { out: 500 })]));
    const index = createSessionIndex({ projectsDir, cacheDir: null, usage: true });
    await index.refresh();
    const [record] = index.list();
    expect(record?.usage?.[0]?.model).toBe(HAIKU);
    expect(record?.model).toBe(OPUS);
  });
});

const FABLE = "claude-fable-5-1";

/** a time on the test machine's own clock, as a transcript writes it */
const at = (h: number, m: number, sec = 0, day = 1) =>
  new Date(2026, 8, day, h, m, sec).toISOString();
const on = (line: object, timestamp: string) => ({ ...line, timestamp });
const DAY1 = "2026-09-01";
const DAY2 = "2026-09-02";
const MIN = 60_000;

/** a prompt the person typed */
const asks = (text: string, timestamp: string) =>
  on(userEntry(text, { origin: { kind: "human" } }), timestamp);
/** a response block, with what it ends on */
const says = (id: string, timestamp: string, extra: Record<string, unknown> = {}) => {
  const b = block(id, OPUS, { out: 1 });
  return { ...b, timestamp, message: { ...b.message, ...extra } };
};
const toolUse = (name: string) => ({
  content: [{ type: "tool_use", id: "toolu_1", name, input: {} }],
  stop_reason: "tool_use",
});
const toolResult = (timestamp: string) =>
  on(userEntry([{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]), timestamp);
const ms = (t: UsageTally, day = DAY1) =>
  Object.values(t.days[day]?.models ?? {}).reduce((n, m) => n + m.ms, 0);
/** the 5-minute slots of a day that hold working time */
const slots = (t: UsageTally, day = DAY1) =>
  (t.days[day]?.slots ?? []).flatMap((word, w) =>
    [...Array(32).keys()].filter((b) => (word >>> b) & 1).map((b) => w * 32 + b),
  );

describe("what a response cost, by day", () => {
  it("an advisor's tokens are in the iterations, and are its own model's", async () => {
    // measured: the top-level numbers are the two `message` iterations, the advisor beside them
    const line = block("msg_1", OPUS, { in: 4, out: 648, read: 501_312, write: 3_032 });
    const iteration = (type: string, u: Record<string, number>, model?: string) => ({
      type,
      ...(model ? { model } : {}),
      input_tokens: u.in ?? 0,
      output_tokens: u.out ?? 0,
      cache_read_input_tokens: u.read ?? 0,
      cache_creation_input_tokens: u.write ?? 0,
      cache_creation: {
        ephemeral_5m_input_tokens: u.w5 ?? 0,
        ephemeral_1h_input_tokens: u.w1 ?? 0,
      },
    });
    Object.assign(line.message.usage, {
      // the top-level split is the first iteration's alone: only the iterations add up
      cache_creation: { ephemeral_1h_input_tokens: 1_736, ephemeral_5m_input_tokens: 0 },
      iterations: [
        iteration("message", { in: 2, out: 99, read: 249_788, write: 1_736, w1: 1_736 }),
        iteration("advisor_message", { in: 237_384, out: 15_916 }, FABLE),
        iteration("message", { in: 2, out: 549, read: 251_524, write: 1_296, w5: 1_296 }),
      ],
    });
    const { file } = setup([on(line, at(10, 0))]);
    const t = await scanUsage(file);
    expect(t.days[DAY1]?.models).toEqual({
      [OPUS]: {
        input: 4,
        output: 648,
        cacheRead: 501_312,
        cacheWrite: 3_032,
        cacheWrite1h: 1_736,
        messages: 1,
        ms: 0,
      },
      [FABLE]: {
        input: 237_384,
        output: 15_916,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        messages: 1,
        ms: 0,
      },
    });
    // a session row's totals now hold the advisor too
    expect(models(t).map((m) => [m.model, m.input])).toEqual([
      [OPUS, 4],
      [FABLE, 237_384],
    ]);
  });

  it("a cache write with no split is the 5-minute kind, and a split says how much is 1h", async () => {
    const split = block("msg_2", OPUS, { write: 100 });
    Object.assign(split.message.usage, {
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 },
    });
    const { file } = setup([
      on(block("msg_1", OPUS, { write: 50 }), at(10, 0)),
      on(split, at(10, 1)),
    ]);
    const m = (await scanUsage(file)).days[DAY1]?.models[OPUS];
    expect(m).toMatchObject({ cacheWrite: 150, cacheWrite1h: 70 });
  });

  it("a response whose blocks straddle midnight is counted once, on the day of its last block", async () => {
    const { file } = setup([
      on(block("msg_1", OPUS, { out: 10 }), at(23, 59, 50)),
      on(block("msg_1", OPUS, { out: 40 }), at(0, 0, 5, 2)),
    ]);
    const t = await scanUsage(file);
    expect(t.days[DAY1]?.models[OPUS]).toMatchObject({ output: 0, messages: 0 });
    expect(t.days[DAY2]?.models[OPUS]).toMatchObject({ output: 40, messages: 1 });
  });

  it("a block that arrives in a later scan takes the response out of the day it was counted on", async () => {
    const { file } = setup([on(block("msg_1", OPUS, { out: 10 }), at(23, 59, 50))]);
    const before = await scanUsage(file);
    expect(before.days[DAY1]?.models[OPUS]).toMatchObject({ output: 10, messages: 1 });
    appendFileSync(file, toJsonl([on(block("msg_1", OPUS, { out: 40 }), at(0, 0, 5, 2))]));
    const after = await scanUsage(file, before);
    expect(after.days[DAY1]?.models[OPUS]).toMatchObject({ output: 0, messages: 0 });
    expect(after.days[DAY2]?.models[OPUS]).toMatchObject({ output: 40, messages: 1 });
    expect(models(after)).toMatchObject([{ output: 40, messages: 1 }]);
  });
});

describe("agent time", () => {
  it("the wait for a response is the agent's, the wait for a prompt is the person's", async () => {
    const { file } = setup([
      asks("go", at(10, 0)),
      says("msg_1", at(10, 0, 30), toolUse("Bash")),
      toolResult(at(10, 2)),
      says("msg_2", at(10, 2, 30), { stop_reason: "end_turn" }),
      // twenty minutes of the person thinking
      asks("and now", at(10, 22, 30)),
      says("msg_3", at(10, 23), { stop_reason: "end_turn" }),
    ]);
    const t = await scanUsage(file);
    // 30s to answer, 2m of tool and answer, 30s to answer again
    expect(ms(t)).toBe(3 * MIN);
    expect(t.days[DAY1]?.models[OPUS]?.ms).toBe(3 * MIN);
    // the longest turn is the first one
    expect(t.days[DAY1]?.turn).toBe(2.5 * MIN);
    expect(slots(t)).toEqual([120, 124]);
  });

  it("nothing counts after a turn ended or a question to the person, whatever restarts it", async () => {
    const { file } = setup([
      asks("go", at(10, 0)),
      says("msg_1", at(10, 1), toolUse("AskUserQuestion")),
      // he answers ten minutes later: a tool result, and still his time
      toolResult(at(10, 11)),
      says("msg_2", at(10, 11, 30), { stop_reason: "end_turn" }),
      // a background task's news restarts it, with no prompt. the turn it is in goes on
      on(userEntry("<task-notification>done</task-notification>"), at(10, 30)),
      says("msg_3", at(10, 31), { stop_reason: "end_turn" }),
      // and so does a line with nothing before it at all
      says("msg_4", at(10, 50)),
    ]);
    const t = await scanUsage(file);
    expect(ms(t)).toBe(2 * MIN);
    expect(t.days[DAY1]?.turn).toBe(2 * MIN);
  });

  it("a gap past the cap is a sleeping laptop, and none of it counts", async () => {
    const { file } = setup([
      asks("go", at(10, 0)),
      says("msg_1", at(10, 1), toolUse("Bash")),
      says("msg_2", new Date(Date.parse(at(10, 1)) + GAP_CAP_MS + 1000).toISOString()),
      says("msg_3", new Date(Date.parse(at(10, 1)) + 2 * GAP_CAP_MS).toISOString()),
    ]);
    expect(ms(await scanUsage(file))).toBe(1 * MIN + GAP_CAP_MS - 1000);
  });

  it("the clock and the turn carry over a scan boundary", async () => {
    const first = [asks("go", at(10, 0)), says("msg_1", at(10, 1), toolUse("Bash"))];
    const more = [says("msg_2", at(10, 4)), says("msg_3", at(10, 6), { stop_reason: "end_turn" })];
    const { file } = setup(first);
    const before = await scanUsage(file);
    appendFileSync(file, toJsonl(more));
    const after = await scanUsage(file, before);
    const whole = await scanUsage(setup([...first, ...more]).file);
    expect(ms(after)).toBe(6 * MIN);
    expect(after.days).toEqual(whole.days);
    expect(after.days[DAY1]?.turn).toBe(6 * MIN);
  });

  it("a gap over midnight is the next day's time, and each day keeps its own slots", async () => {
    const { file } = setup([
      asks("go", at(23, 58)),
      says("msg_1", at(0, 1, 0, 2), { stop_reason: "end_turn" }),
    ]);
    const t = await scanUsage(file);
    expect([ms(t, DAY1), ms(t, DAY2)]).toEqual([0, 3 * MIN]);
    expect([slots(t, DAY1), slots(t, DAY2)]).toEqual([[287], [0]]);
    expect(t.days[DAY2]?.turn).toBe(3 * MIN);
  });

  it("an agent's own transcript is timed from its brief, and has no turn: nobody asked it", async () => {
    const side = { isSidechain: true };
    const { file } = setup([
      on(userEntry("look into the flaky test", side), at(10, 0)),
      on({ ...says("msg_1", at(10, 2), { stop_reason: "end_turn" }), ...side }, at(10, 2)),
    ]);
    const t = await scanUsage(file);
    expect(ms(t)).toBe(2 * MIN);
    expect(t.days[DAY1]?.turn).toBeUndefined();
  });

  it("days are the local calendar's", () => {
    expect(localDay(new Date(2026, 0, 5, 0, 0, 1).getTime())).toBe("2026-01-05");
    expect(localDay(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe("2026-12-31");
  });
});

describe("the index keeps usage past its transcript", () => {
  const cached = (cacheDir: string) =>
    JSON.parse(readFileSync(path.join(cacheDir, cacheFileName()), "utf8"));
  const retired = (cacheDir: string) =>
    JSON.parse(readFileSync(path.join(cacheDir, "usage-retired.json"), "utf8")).retired;

  it("an entry counted the old way is counted again from the start, once, and its text is not doubled", async () => {
    const { base, projectsDir, file } = setup([
      asks("find the invoice bug", at(10, 0)),
      on(block("msg_1", OPUS, { out: 10 }), at(10, 1)),
    ]);
    const cacheDir = path.join(base, "cache");
    const open = () => createSessionIndex({ projectsDir, cacheDir, usage: true, fullText: true });
    const first = open();
    await first.refresh();
    const text = (await first.texts()).get(file)?.text;
    expect(text).toContain("find the invoice bug");

    // what 0.14 wrote: totals per model and an offset at the end of the file, no schema number
    const old = cached(cacheDir);
    const usage = old.entries[file].usage;
    const offset = usage.files[""].offset;
    old.entries[file].usage = {
      key: usage.key,
      textChars: usage.textChars,
      files: {
        "": {
          offset,
          models: { [OPUS]: { input: 0, output: 999, cacheRead: 0, cacheWrite: 0, messages: 1 } },
          recent: [],
        },
      },
    };
    writeFileSync(path.join(cacheDir, cacheFileName()), JSON.stringify(old));

    const next = open();
    await next.load();
    // until it is counted again the session says nothing, not the old totals
    expect(next.usageSources()).toEqual([]);
    await next.refresh();
    expect(next.usageProgress()).toEqual({ counted: 1, total: 1 });
    expect(next.list()[0]?.usage).toMatchObject([{ model: OPUS, output: 10 }]);
    expect(next.usageSources()[0]?.files[""]?.[DAY1]?.models[OPUS]?.output).toBe(10);
    expect((await next.texts()).get(file)?.text).toBe(text);
    expect(cached(cacheDir).entries[file].usage.v).toBe(USAGE_SCHEMA);

    // and not a third time
    const again = open();
    await again.load();
    expect(again.usageSources()).toHaveLength(1);
  });

  it("a deleted transcript's days stay, with where it ran, and go when the file is back", async () => {
    const { base, projectsDir, file } = setup([
      asks("go", at(10, 0)),
      on(block("msg_1", OPUS, { out: 10 }), at(10, 1)),
    ]);
    const agent = path.join(path.dirname(file), SID.a, "subagents", "agent-a.jsonl");
    mkdirSync(path.dirname(agent), { recursive: true });
    writeFileSync(agent, toJsonl([on(block("msg_2", HAIKU, { out: 4 }), at(11, 0))]));
    const cacheDir = path.join(base, "cache");
    const index = createSessionIndex({ projectsDir, cacheDir, usage: true });
    await index.load();
    await index.refresh();
    const live = index.usageSources();
    expect(live).toMatchObject([
      {
        path: file,
        sessionId: SID.a,
        cwd: "/Users/you/src/api",
        projectDirName: "-Users-you-src-api",
      },
    ]);

    // Claude Code deletes old transcripts, and a full scan is what notices
    const away = `${file}.away`;
    renameSync(file, away);
    await index.refresh();
    expect(index.list()).toEqual([]);
    expect(index.usageSources()).toEqual(live);
    expect(Object.keys(retired(cacheDir)[file].files).sort()).toEqual([
      "",
      path.join(SID.a, "subagents", "agent-a.jsonl"),
    ]);
    expect(cached(cacheDir).entries[file]).toBeUndefined();

    // a new process still has them
    const next = createSessionIndex({ projectsDir, cacheDir, usage: true });
    await next.load();
    await next.refresh();
    expect(next.usageSources()).toEqual(live);

    // back on disk: counted from the file again, and not twice
    renameSync(away, file);
    await next.refresh();
    expect(next.usageSources()).toEqual(live);
    expect(retired(cacheDir)).toEqual({});

    // the watcher's way out keeps them too
    unlinkSync(file);
    await next.refreshFile(file);
    expect(next.usageSources()).toEqual(live);
  });

  it("an index that does not count leaves a counted entry for the one that does", async () => {
    const { base, projectsDir, file } = setup([on(block("msg_1", OPUS, { out: 10 }), at(10, 0))]);
    const cacheDir = path.join(base, "cache");
    const app = createSessionIndex({ projectsDir, cacheDir, usage: true });
    await app.refresh();
    unlinkSync(file);
    // the editor extension's index: same cache file, no usage
    const extension = createSessionIndex({ projectsDir, cacheDir });
    await extension.load();
    await extension.refresh();
    await extension.flush();
    expect(cached(cacheDir).entries[file].usage.v).toBe(USAGE_SCHEMA);

    const next = createSessionIndex({ projectsDir, cacheDir, usage: true });
    await next.load();
    await next.refresh();
    expect(next.usageSources()).toMatchObject([{ path: file }]);
    expect(Object.keys(retired(cacheDir))).toEqual([file]);
  });

  it("the retired are dropped with the index when the projects dir is another one", async () => {
    const { base, projectsDir, file } = setup([on(block("msg_1", OPUS, { out: 10 }), at(10, 0))]);
    const cacheDir = path.join(base, "cache");
    const index = createSessionIndex({ projectsDir, cacheDir, usage: true });
    await index.refresh();
    unlinkSync(file);
    await index.refresh();
    expect(index.usageSources()).toHaveLength(1);
    const other = path.join(base, "other-projects");
    mkdirSync(other);
    const moved = createSessionIndex({ projectsDir: other, cacheDir, usage: true });
    await moved.load();
    expect(moved.usageSources()).toEqual([]);
  });
});

describe("api-equivalent cost", () => {
  const M = 1_000_000;
  const counts = (
    c: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h", number>>,
  ) => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    ...c,
  });

  it("each kind of token has its own price, and an hour's cache write costs more than five minutes'", () => {
    expect(costOf("claude-opus-5-5", counts({ input: M }))).toBe(4);
    expect(costOf("claude-opus-5-5", counts({ output: M }))).toBe(20);
    expect(costOf("claude-opus-5-5", counts({ cacheRead: M }))).toBeCloseTo(0.2);
    expect(costOf("claude-opus-5-5", counts({ cacheWrite: M }))).toBe(5);
    expect(costOf("claude-opus-5-5", counts({ cacheWrite: M, cacheWrite1h: M }))).toBe(8);
    expect(costOf("claude-fable-5-1", counts({ cacheRead: M }))).toBe(0.25);
    expect(costOf("claude-fable-5", counts({ cacheRead: M }))).toBe(1);
    expect(costOf("claude-haiku-4-5", counts({ input: M, output: M }))).toBe(6);
  });

  it("a dated id and a [1m] id are their base model", () => {
    expect(priceOf("claude-haiku-4-5-20251001")).toBe(priceOf("claude-haiku-4-5"));
    expect(priceOf("claude-opus-5[1m]")).toBe(priceOf("claude-opus-5"));
    expect(priceOf("claude-opus-5-5[1m]")).toBe(priceOf("claude-opus-5-5"));
    expect(priceOf("claude-opus-5")).not.toBe(priceOf("claude-opus-5-5"));
  });

  it("a model the table has never heard of gets its family's newest price", () => {
    expect(priceOf("claude-opus-6")).toBe(priceOf("claude-opus-5-5"));
    expect(priceOf("claude-sonnet-9-1-20270101")).toBe(priceOf("claude-sonnet-5-5"));
    expect(priceOf("claude-3-5-haiku-20241022")).toBe(priceOf("claude-haiku-5-5"));
    expect(priceOf("claude-fable-7")).toBe(priceOf("claude-fable-5-1"));
  });

  it("a model of no family has no price, and says so instead of costing nothing", () => {
    expect(priceOf("some-other-model")).toBeNull();
    expect(costOf("some-other-model", counts({ input: M }))).toBeNull();
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
