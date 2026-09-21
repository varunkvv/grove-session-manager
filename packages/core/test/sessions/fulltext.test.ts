import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { textSnippet } from "../../src/sessions/fulltext.ts";
import { createSessionIndex } from "../../src/sessions/indexer.ts";
import { conversationText } from "../../src/transcript/text.ts";
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
