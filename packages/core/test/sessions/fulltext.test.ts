import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { textSnippet } from "../../src/sessions/fulltext.ts";
import { createSessionIndex } from "../../src/sessions/indexer.ts";
import { agentLineText, conversationText } from "../../src/transcript/text.ts";
import {
  agentPrompt,
  agentResult,
  agentSays,
  call,
  jsonl,
  text as said,
  thinking,
} from "../helpers/agentTranscript.ts";
import {
  assistantEntry,
  makeSandbox,
  SID,
  text,
  toJsonl,
  userEntry,
  writeTranscript,
} from "../helpers/transcript.ts";

function reply(t: string, id: string) {
  const e = assistantEntry(t);
  return {
    ...e,
    message: { ...e.message, id, model: "claude-opus-5", usage: { output_tokens: 1 } },
  };
}

function toolCall(input: Record<string, unknown>, id: string) {
  const e = assistantEntry("");
  return {
    ...e,
    message: {
      ...e.message,
      id,
      model: "claude-opus-5",
      usage: { output_tokens: 1 },
      content: [{ type: "tool_use", id: "t1", name: "Edit", input }],
    },
  };
}

function toolResult(out: string) {
  return {
    ...userEntry([{ type: "tool_result", tool_use_id: "t1", content: out }]),
    toolUseResult: { stdout: out },
  };
}

function setup() {
  const base = makeSandbox("grove-text-");
  const projectsDir = path.join(base, "projects");
  const cacheDir = path.join(base, "cache");
  mkdirSync(projectsDir);
  const open = () => createSessionIndex({ projectsDir, cacheDir, usage: true, fullText: true });
  return { projectsDir, cacheDir, open };
}

async function textOf(index: ReturnType<ReturnType<typeof setup>["open"]>, file: string) {
  return (await index.texts()).get(file)?.text ?? "";
}

describe("conversation text", () => {
  it("keeps what people typed, what Claude wrote, and the files and commands it touched", () => {
    expect(
      conversationText(
        userEntry([text("<ide_opened_file>x</ide_opened_file>"), text("why is the queue stuck")]),
      ),
    ).toBe("why is the queue stuck");
    expect(conversationText(reply("the retry drops on a 429", "m1"))).toBe(
      "the retry drops on a 429",
    );
    expect(
      conversationText(toolCall({ file_path: "src/rate_limiter.py", old_string: "noise" }, "m2")),
    ).toBe("src/rate_limiter.py");
    // tool output is most of the bytes and none of what people remember
    expect(conversationText(toolResult("40MB of logs"))).toBeUndefined();
  });

  it("the index keeps it, follows appends without repeating itself, and survives a restart", async () => {
    const { projectsDir, open } = setup();
    const file = writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [
      userEntry("why is the queue stuck"),
      reply("the retry drops on a 429", "m1"),
      toolResult("QUEUE_SECRET_OUTPUT"),
    ]);
    const index = open();
    await index.refresh();
    expect(await textOf(index, file)).toBe("why is the queue stuck\nthe retry drops on a 429\n");

    appendFileSync(file, toJsonl([toolCall({ command: "pytest tests/test_backoff.py" }, "m2")]));
    await index.refreshFile(file);
    await index.refreshFile(file);
    const after = await textOf(index, file);
    expect(after.match(/queue stuck/g)).toHaveLength(1);
    expect(after).toContain("pytest tests/test_backoff.py");
    expect(after).not.toContain("QUEUE_SECRET_OUTPUT");
    await index.flush();

    const again = open();
    await again.load();
    await again.refresh();
    expect(await textOf(again, file)).toBe(after);
  });

  it("a lost text file is rebuilt, not left half empty", async () => {
    const { projectsDir, cacheDir, open } = setup();
    const file = writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [
      userEntry("find the flaky webhook test"),
    ]);
    const index = open();
    await index.refresh();
    await index.flush();
    rmSync(path.join(cacheDir, "text"), { recursive: true });
    appendFileSync(file, toJsonl([reply("it sleeps on a real clock", "m1")]));

    const again = open();
    await again.load();
    await again.refresh();
    expect(await textOf(again, file)).toBe(
      "find the flaky webhook test\nit sleeps on a real clock\n",
    );
  });

  it("a removed transcript takes its text with it", async () => {
    const { projectsDir, cacheDir, open } = setup();
    const file = writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [userEntry("hello")]);
    const index = open();
    await index.refresh();
    expect(readdirSync(path.join(cacheDir, "text"))).toHaveLength(1);
    rmSync(file);
    await index.refreshFile(file);
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(path.join(cacheDir, "text"))).toHaveLength(0);
  });

  it("a snippet is cut around the match, on one line", () => {
    const t = `${"a ".repeat(100)}the\nretry drops on a 429${" b".repeat(100)}`;
    const snip = textSnippet({ text: t, lower: t.toLowerCase() }, ["429"], 20);
    expect(snip).toMatch(/^….*retry drops on a 429.*…$/);
    expect(snip).not.toContain("\n");
    // the line the match is on starts it, so the match is not pushed off the end of a row
    expect(snip?.startsWith("…retry drops")).toBe(true);
    const long = `${"word ".repeat(40)}the retry drops on a 429`;
    const cut = textSnippet({ text: long, lower: long.toLowerCase() }, ["429"], 60) ?? "";
    expect(cut.indexOf("429")).toBeLessThanOrEqual(30);
  });

  it("an index without full text leaves nothing on disk", async () => {
    const { projectsDir, cacheDir } = setup();
    writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [userEntry("hello")]);
    const index = createSessionIndex({ projectsDir, cacheDir, usage: true });
    await index.refresh();
    expect(readdirSync(cacheDir)).not.toContain("text");
    expect((await index.texts()).size).toBe(0);
  });
});

describe("what agents said", () => {
  const AGENT = "a7e3000000000001";
  const agentLines = (s = 0) => [
    agentPrompt(AGENT, "Find every writer of the retry lease.", s),
    agentSays(AGENT, "m1", thinking("THOUGHT_NOBODY_SEES"), s + 1),
    agentSays(AGENT, "m2", call("t1", "Grep", { pattern: "lease_expires", path: "/w/q" }), s + 2),
    agentResult(AGENT, "t1", "LEASE_TOOL_OUTPUT_BODY", s + 3),
    agentSays(AGENT, "m3", said("The lease is renewed only on success."), s + 4),
  ];
  const withAgent = (projectsDir: string) => {
    const file = writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [
      userEntry("why do retries vanish"),
    ]);
    const sub = path.join(path.dirname(file), SID.a, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, `agent-${AGENT}.jsonl`), jsonl(agentLines()));
    return { file, agentFile: path.join(sub, `agent-${AGENT}.jsonl`) };
  };

  it("an agent's line gives its prompt, its words and its paths - not tool output, not thinking", () => {
    const [prompt, think, grep, result, words] = agentLines();
    expect(agentLineText(prompt as Record<string, unknown>)).toBe(
      "Find every writer of the retry lease.",
    );
    expect(agentLineText(think as Record<string, unknown>)).toBeUndefined();
    expect(agentLineText(grep as Record<string, unknown>)).toBe("/w/q\nlease_expires");
    expect(agentLineText(result as Record<string, unknown>)).toBeUndefined();
    expect(agentLineText(words as Record<string, unknown>)).toBe(
      "The lease is renewed only on success.",
    );
    // the session's own text never had any of it: every line of an agent is a sidechain line
    expect(conversationText(words as Record<string, unknown>)).toBeUndefined();
  });

  it("the index keeps each agent's words beside its session's, and follows what it appends", async () => {
    const { projectsDir, open } = setup();
    const { file, agentFile } = withAgent(projectsDir);
    const index = open();
    await index.refresh();
    expect(await textOf(index, file)).toBe("why do retries vanish\n");
    const words = (await index.agentTexts(file)).get(AGENT)?.text ?? "";
    expect(words).toContain("Find every writer of the retry lease.");
    expect(words).toContain("The lease is renewed only on success.");
    expect(words).not.toContain("LEASE_TOOL_OUTPUT_BODY");
    expect(words).not.toContain("THOUGHT_NOBODY_SEES");

    // an agent's transcript is read again with its session's, from where it stopped
    appendFileSync(agentFile, jsonl([agentSays(AGENT, "m4", said("Checked the backoff too."), 9)]));
    appendFileSync(file, toJsonl([reply("thanks", "m9")]));
    await index.refreshFile(file);
    const after = (await index.agentTexts(file)).get(AGENT)?.text ?? "";
    expect(after.match(/renewed only on success/g)).toHaveLength(1);
    expect(after).toContain("Checked the backoff too.");
  });

  it("a lost text dir is rebuilt for agents too, from the start, not half empty", async () => {
    const { projectsDir, cacheDir, open } = setup();
    const { file } = withAgent(projectsDir);
    const index = open();
    await index.refresh();
    await index.flush();
    rmSync(path.join(cacheDir, "text"), { recursive: true });
    const again = open();
    await again.load();
    await again.refresh();
    expect((await again.agentTexts(file)).get(AGENT)?.text).toContain("renewed only on success");
  });
});
