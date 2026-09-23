import { appendFileSync, existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DETAIL_MAX_CHARS,
  loadCachedTimeline,
  readAgentTimeline,
  readToolDetail,
  readWorkflowJournal,
  readWorkflowRuns,
  saveCachedTimeline,
  sweepTimelineCache,
} from "../../src/sessions/agentTimeline.ts";
import {
  agentParents,
  failureOf,
  firstSentence,
  RESULT_PREVIEW,
  type ToolStep,
  timelineView,
  toolLabel,
  toolTarget,
  workflowResultText,
} from "../../src/sessions/timeline.ts";
import { squash } from "../../src/transcript/title.ts";
import {
  AGENT_T0,
  agentNote,
  agentPrompt,
  agentResult,
  agentSays,
  call,
  hookAttachment,
  jsonl,
  text,
  thinking,
} from "../helpers/agentTranscript.ts";
import { makeSandbox } from "../helpers/transcript.ts";

// real agent transcripts with every string replaced (scripts/redact-agents.ts), each next to the
// lines of its parent session that started it and got its result back
const fixtures = path.join(import.meta.dirname, "../fixtures/timeline");
const EXPLORE = {
  session: path.join(fixtures, "9dda0000-0000-4000-8000-000000000001.jsonl"),
  agent: path.join(
    fixtures,
    "9dda0000-0000-4000-8000-000000000001/subagents/agent-a9dda000000000002.jsonl",
  ),
  id: "a9dda000000000002",
};
const WORKFLOW = {
  session: path.join(fixtures, "89950000-0000-4000-8000-000000000001.jsonl"),
  dir: path.join(
    fixtures,
    "89950000-0000-4000-8000-000000000001/subagents/workflows/wf_a8995000-003",
  ),
  run: "wf_a8995000-003",
  id: "a8995000000000002",
};
const ERRORED = path.join(
  fixtures,
  "1f4d0000-0000-4000-8000-000000000001/subagents/agent-a1f4d000000000002.jsonl",
);
const INTERRUPTED = {
  afterResult: path.join(
    fixtures,
    "d8970000-0000-4000-8000-000000000001/subagents/agent-ad897000000000002.jsonl",
  ),
  afterRejection: path.join(
    fixtures,
    "d8970000-0000-4000-8000-000000000001/subagents/agent-ad897000000000036.jsonl",
  ),
};

/** what the parent session got back from its Agent call: Claude Code's own account of the agent */
function parentReturn(session: string, agentId: string): Record<string, unknown> {
  for (const line of readFileSync(session, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.toolUseResult?.agentId === agentId) return entry.toolUseResult;
  }
  throw new Error(`no Agent result for ${agentId}`);
}

describe("an agent's timeline, from a real transcript", () => {
  it("agrees with what Claude Code told the parent session", async () => {
    const view = timelineView(await readAgentTimeline(EXPLORE.agent));
    const told = parentReturn(EXPLORE.session, EXPLORE.id);
    expect(told.status).toBe("completed");
    // the result is the text of the final message, which is exactly what the parent was handed
    expect(view.result).toBe((told.content as Array<{ text: string }>)[0]!.text);
    expect(view.prompt).toBe(told.prompt);
    expect(view.toolCount).toBe(told.totalToolUseCount);
    // the context the last response ran with, not a sum over every response
    expect(view.tokens).toBe(told.totalTokens);
    expect(
      Math.abs(view.lastAt! - view.startedAt! - (told.totalDurationMs as number)),
    ).toBeLessThan(1000);
    expect(view.model).toBe("claude-sonnet-5");
    expect(view.error).toBeUndefined();
  });

  it("pairs every call with its result, and keeps the advisor out of the count", async () => {
    const view = timelineView(await readAgentTimeline(EXPLORE.agent));
    const tools = view.steps.filter((s): s is ToolStep => s.kind === "tool");
    const server = tools.filter((s) => s.server);
    expect(server.map((s) => s.name)).toEqual(["advisor"]);
    expect(tools.length - server.length).toBe(view.toolCount);
    for (const s of tools) {
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
      if (!s.server) expect(s.ref).toBeDefined();
    }
    // every thinking block on that machine is redacted - a signature and nothing to show
    expect(view.steps.some((s) => s.kind === "thinking")).toBe(false);
    // the final message is the result, and is not repeated as a step
    expect(view.steps.some((s) => s.kind === "text" && s.text === view.result)).toBe(false);
  });

  it("reads a step's whole input and result back from the lines it points at", async () => {
    const state = await readAgentTimeline(EXPLORE.agent);
    const read = state.steps.find(
      (s): s is ToolStep => s.kind === "tool" && s.name === "Read" && !!s.result,
    )!;
    const detail = await readToolDetail(EXPLORE.agent, read);
    expect(detail).not.toBeNull();
    expect(JSON.parse(detail!.input)).toHaveProperty("file_path");
    expect(squash(detail!.result!, RESULT_PREVIEW)).toBe(read.result);
    expect(detail!.truncated).toBe(false);
    // a step pointing at the wrong line gets nothing rather than someone else's result
    expect(await readToolDetail(EXPLORE.agent, { ...read, id: "toolu_not_this_one" })).toBeNull();
  });

  it("a workflow agent's result is the journal's, and the run's name comes from the session", async () => {
    const view = timelineView(
      await readAgentTimeline(path.join(WORKFLOW.dir, `agent-${WORKFLOW.id}.jsonl`)),
    );
    const journal = await readWorkflowJournal(WORKFLOW.dir);
    const result = journal.get(WORKFLOW.id);
    expect(typeof result).toBe("string");
    // this one ended in plain text, so the two agree. one with an output schema would not.
    expect(workflowResultText(result)).toBe(view.result);
    const runs = await readWorkflowRuns(WORKFLOW.session);
    expect(runs.get(WORKFLOW.run)?.name).toMatch(/\S/);
    expect(runs.get(WORKFLOW.run)?.summary).toMatch(/\S/);
  });

  it("an agent that died on an api error says so, and has no result", async () => {
    const view = timelineView(await readAgentTimeline(ERRORED));
    expect(view.error).toMatch(/^API Error:/);
    expect(view.result).toBeUndefined();
    expect(view.toolCount).toBeGreaterThan(0);
    // the error line is Claude Code's and carries no usage: the context it died with stays
    expect(view.tokens).toBeGreaterThan(0);
    expect(view.model).not.toBe("<synthetic>");
  });

  it("an interrupted agent ends on the interrupt, rejected tool or not", async () => {
    const after = timelineView(await readAgentTimeline(INTERRUPTED.afterResult));
    expect(after.interrupted).toBe(true);
    expect(after.steps.at(-1)).toMatchObject({ kind: "message", interrupted: true });
    expect(after.result).toBeUndefined();

    const rejected = timelineView(await readAgentTimeline(INTERRUPTED.afterRejection));
    expect(rejected.interrupted).toBe(true);
    const last = rejected.steps.filter((s): s is ToolStep => s.kind === "tool").at(-1)!;
    expect(last).toMatchObject({ isError: true, failure: "rejected" });
  });
});

describe("what the fixtures cannot show", () => {
  const PARENT = "a100";
  const CHILD = "a200";

  function nested(dir: string) {
    const parent = path.join(dir, `agent-${PARENT}.jsonl`);
    const child = path.join(dir, `agent-${CHILD}.jsonl`);
    writeFileSync(
      parent,
      jsonl([
        agentPrompt(PARENT, "Find where the retry is lost"),
        hookAttachment(PARENT, 1),
        agentSays(PARENT, "msg_1", thinking("the queue first, then the worker"), 2),
        agentSays(PARENT, "msg_1", text("Starting with the queue."), 2),
        agentSays(PARENT, "msg_1", call("toolu_1", "Read", { file_path: "/work/api/queue.ts" }), 3),
        agentResult(PARENT, "toolu_1", "export class Queue {}", 4),
        agentSays(
          PARENT,
          "msg_2",
          call("toolu_2", "Agent", {
            description: "Survey the worker",
            prompt: "look",
            subagent_type: "Explore",
          }),
          5,
        ),
        agentResult(PARENT, "toolu_2", "the worker drops it", 65),
        agentNote(
          PARENT,
          "The coordinator sent a message while you were working:\nalso check the dead letter queue",
          66,
          { isMeta: true, origin: { kind: "coordinator" } },
        ),
        agentNote(PARENT, "[Image: original 2360x1520]", 67, { isMeta: true }),
        // one final response, two text blocks, two lines. the second carries the final usage.
        agentSays(PARENT, "msg_3", text("The worker drops the retry."), 70),
        agentSays(PARENT, "msg_3", text("Fixed in `worker.ts`."), 71, {
          input_tokens: 3,
          output_tokens: 90,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 400,
        }),
      ]),
    );
    writeFileSync(
      child,
      jsonl([
        agentPrompt(CHILD, "look", 6),
        agentSays(
          CHILD,
          "msg_9",
          call("toolu_9", "Grep", { pattern: "retry", path: "/work/api/src" }),
          7,
        ),
        agentResult(CHILD, "toolu_9", "src/worker.ts:12", 8),
        agentSays(CHILD, "msg_10", text("the worker drops it"), 60),
      ]),
    );
    return { parent, child };
  }

  it("a result spread over several text blocks is all of them", async () => {
    const dir = makeSandbox("grove-timeline-");
    const view = timelineView(await readAgentTimeline(nested(dir).parent));
    expect(view.result).toBe("The worker drops the retry.\n\nFixed in `worker.ts`.");
    // last line per response id wins, and only the last response counts
    expect(view.tokens).toBe(3 + 90 + 5000 + 400);
    expect(view.startedAt).toBe(AGENT_T0);
    expect(view.lastAt).toBe(AGENT_T0 + 71_000);
  });

  it("thinking with words in it is a step, and so is a message sent mid-run", async () => {
    const dir = makeSandbox("grove-timeline-");
    const view = timelineView(await readAgentTimeline(nested(dir).parent));
    expect(view.prompt).toBe("Find where the retry is lost");
    expect(view.steps.map((s) => s.kind)).toEqual(["thinking", "text", "tool", "tool", "message"]);
    // the coordinator's preamble is Claude Code's, the rest is what was said
    expect(view.steps[4]).toMatchObject({
      kind: "message",
      text: "also check the dead letter queue",
    });
    // an image-size note is Claude Code talking to itself
    expect(view.steps.some((s) => s.kind === "message" && s.text.includes("Image"))).toBe(false);
  });

  it("an agent another agent started links back through the Agent call", async () => {
    const dir = makeSandbox("grove-timeline-");
    const files = nested(dir);
    const parent = timelineView(await readAgentTimeline(files.parent));
    const child = timelineView(await readAgentTimeline(files.child));
    const parents = agentParents(
      [
        { id: PARENT, toolUseId: "toolu_session" },
        { id: CHILD, toolUseId: "toolu_2" },
      ],
      new Map([
        [PARENT, parent.steps],
        [CHILD, child.steps],
      ]),
    );
    expect([...parents]).toEqual([[CHILD, PARENT]]);
    expect(parent.steps[3]).toMatchObject({ name: "Agent", target: "Survey the worker" });
  });

  it("a tool still running has no duration yet, and a failed one says how it failed", async () => {
    const dir = makeSandbox("grove-timeline-");
    const file = path.join(dir, "agent-a1.jsonl");
    writeFileSync(
      file,
      jsonl([
        agentPrompt("a1", "run the tests"),
        agentSays("a1", "m1", call("t1", "Bash", { command: "cd /work/api && pnpm test" }), 1),
        agentResult("a1", "t1", "Exit code 1\nFAIL src/queue.test.ts", 9, true),
        agentSays("a1", "m2", call("t2", "Bash", { command: "pnpm test --watch" }), 10),
      ]),
    );
    const view = timelineView(await readAgentTimeline(file));
    expect(view.steps[0]).toMatchObject({
      kind: "tool",
      target: "pnpm test",
      durationMs: 8000,
      isError: true,
      failure: "exit 1",
    });
    expect((view.steps[1] as ToolStep).durationMs).toBeUndefined();
    // it is mid-tool, so there is no result and nothing ended
    expect(view.result).toBeUndefined();
    expect(view.interrupted).toBeUndefined();
  });
});

describe("reading a transcript that is still being written", () => {
  function lines(n: number) {
    const out: object[] = [agentPrompt("a1", "go")];
    for (let i = 1; i <= n; i++) {
      out.push(
        agentSays("a1", `m${i}`, call(`t${i}`, "Read", { file_path: `/work/api/f${i}.ts` }), i * 2),
      );
      out.push(agentResult("a1", `t${i}`, `contents of ${i}`, i * 2 + 1));
    }
    return out;
  }

  it("carries on from where it stopped, and ends up where one read would", async () => {
    const dir = makeSandbox("grove-timeline-");
    const file = path.join(dir, "agent-a1.jsonl");
    const all = lines(6);
    writeFileSync(file, jsonl(all.slice(0, 6)));
    const first = await readAgentTimeline(file);
    expect(first.offset).toBe(readFileSync(file).length);

    // the call without its result yet, and a line still being written
    const rest = jsonl(all.slice(6));
    appendFileSync(file, rest.slice(0, rest.length - 40));
    const second = await readAgentTimeline(file, first);
    // the torn line is not read: the offset stops at the last whole line
    expect(readFileSync(file, "utf8").slice(second.offset)).not.toContain("\n");

    appendFileSync(file, rest.slice(rest.length - 40));
    const third = await readAgentTimeline(file, second);
    const once = await readAgentTimeline(file);
    expect(timelineView(third)).toEqual(timelineView(once));
    expect(third.offset).toBe(once.offset);
  });

  it("a step nothing happened to is the same object after the next read", async () => {
    const dir = makeSandbox("grove-timeline-");
    const file = path.join(dir, "agent-a1.jsonl");
    const all = lines(3);
    // the last call is still waiting for its result
    writeFileSync(file, jsonl(all.slice(0, -1)));
    const before = await readAgentTimeline(file);
    appendFileSync(file, jsonl(all.slice(-1)));
    const after = await readAgentTimeline(file, before);
    expect(after.steps[0]).toBe(before.steps[0]);
    expect(after.steps[2]).not.toBe(before.steps[2]);
    expect((after.steps[2] as ToolStep).durationMs).toBe(1000);
    // and the earlier read is left as it was
    expect((before.steps[2] as ToolStep).durationMs).toBeUndefined();
  });

  it("a file that got shorter was rewritten, and is read again from the start", async () => {
    const dir = makeSandbox("grove-timeline-");
    const file = path.join(dir, "agent-a1.jsonl");
    writeFileSync(file, jsonl(lines(5)));
    const long = await readAgentTimeline(file);
    writeFileSync(file, jsonl(lines(2)));
    const short = await readAgentTimeline(file, long);
    expect(short.toolCount).toBe(2);
  });

  it("a line cut by the read chunk, mid character, reads the same as one read whole", async () => {
    const dir = makeSandbox("grove-timeline-");
    const file = path.join(dir, "agent-a1.jsonl");
    // 1.2MB of two-byte characters: it straddles the first 1MB chunk, at an odd byte
    const big = `é${"é".repeat(600_000)}`;
    writeFileSync(
      file,
      jsonl([
        agentPrompt("a1", "go"),
        agentSays("a1", "m1", text(`x${big}`), 1),
        agentSays("a1", "m2", call("t1", "Read", { file_path: "/work/api/ü.ts" }), 2),
        agentResult("a1", "t1", big, 3),
        agentSays("a1", "m3", text("done ✓"), 4),
      ]),
    );
    const view = timelineView(await readAgentTimeline(file));
    expect(view.result).toBe("done ✓");
    const tool = view.steps.find((s): s is ToolStep => s.kind === "tool")!;
    expect(tool.target).toBe("ü.ts");
    expect(tool.result).toBe(squash(big, RESULT_PREVIEW));
    const detail = await readToolDetail(file, tool);
    // the whole result is only ever read here, and even here it is capped
    expect(detail!.result).toHaveLength(DETAIL_MAX_CHARS);
    expect(detail!.truncated).toBe(true);
  });
});

describe("the cache", () => {
  it("keeps a folded timeline per agent file, and nothing for another file", async () => {
    const dir = makeSandbox("grove-timeline-cache-");
    const state = await readAgentTimeline(EXPLORE.agent);
    await saveCachedTimeline(dir, EXPLORE.agent, "1:2", state);
    const loaded = await loadCachedTimeline(dir, EXPLORE.agent);
    expect(loaded?.mark).toBe("1:2");
    expect(timelineView(loaded!.state)).toEqual(timelineView(state));
    expect(await loadCachedTimeline(dir, ERRORED)).toBeNull();
    // what a cached state is for: a resumed read of an unchanged file does nothing at all
    expect(await readAgentTimeline(EXPLORE.agent, loaded!.state)).toEqual(state);
  });

  it("an entry nobody wrote for longer than Claude Code keeps a transcript is swept", async () => {
    const dir = makeSandbox("grove-timeline-cache-");
    const old = path.join(dir, "old.json");
    const fresh = path.join(dir, "fresh.json");
    writeFileSync(old, "{}");
    writeFileSync(fresh, "{}");
    const monthsAgo = (Date.now() - 60 * 24 * 3_600_000) / 1000;
    utimesSync(old, monthsAgo, monthsAgo);
    await sweepTimelineCache(dir);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("an older shape is not trusted", async () => {
    const dir = makeSandbox("grove-timeline-cache-");
    const state = await readAgentTimeline(EXPLORE.agent);
    await saveCachedTimeline(dir, EXPLORE.agent, "1:2", { ...state, version: 0 });
    expect(await loadCachedTimeline(dir, EXPLORE.agent)).toBeNull();
  });
});

describe("words for a step", () => {
  const cwd = "/Users/you/src/api";
  const home = "/Users/you";

  it("a target says the file, the command or the search, as short as it can", () => {
    expect(toolTarget("Read", { file_path: `${cwd}/src/queue.ts` }, cwd, home)).toBe(
      "src/queue.ts",
    );
    expect(toolTarget("Edit", { file_path: `${home}/notes/todo.md` }, cwd, home)).toBe(
      "~/notes/todo.md",
    );
    expect(toolTarget("Write", { file_path: "/etc/hosts" }, cwd, home)).toBe("/etc/hosts");
    expect(toolTarget("Bash", { command: `cd ${cwd} && pnpm test` }, cwd, home)).toBe("pnpm test");
    expect(toolTarget("Bash", { command: 'cd "/a b" && ls\n-la' }, cwd, home)).toBe("ls -la");
    expect(toolTarget("Grep", { pattern: "needsYou", path: `${cwd}/apps` }, cwd, home)).toBe(
      '"needsYou" in apps',
    );
    expect(toolTarget("Glob", { pattern: "**/*.ts" }, cwd, home)).toBe("**/*.ts");
    expect(toolTarget("WebFetch", { url: "https://code.claude.com/docs" })).toBe(
      "code.claude.com/docs",
    );
    expect(toolTarget("Agent", { description: "Research hooks", prompt: "..." })).toBe(
      "Research hooks",
    );
    expect(toolTarget("TodoWrite", { todos: [{}, {}, {}] })).toBe("3 todos");
    // anything else: the most telling key there is
    expect(toolTarget("mcp__github__get_issue", { query: "retry" })).toBe("retry");
    expect(toolTarget("Read", "not an object")).toBe("");
  });

  it("an mcp tool is named by the tool, not the server", () => {
    expect(toolLabel("mcp__claude_ai_Slack__slack_send_message")).toBe("slack_send_message");
    expect(toolLabel("Read")).toBe("Read");
  });

  it("a failure is an exit code, a rejection or an error", () => {
    expect(failureOf("Exit code 2\nboom")).toBe("exit 2");
    expect(failureOf("Error: Exit code 127\nnot found")).toBe("exit 127");
    expect(failureOf("The user doesn't want to proceed with this tool use.")).toBe("rejected");
    expect(failureOf("<tool_use_error>File does not exist.</tool_use_error>")).toBe("error");
  });

  it("the first sentence of a result is plain words", () => {
    expect(firstSentence("## Summary\n\n**Done.** Three commits, nothing pushed.")).toBe("Done.");
    expect(firstSentence("- the `retry` is lost in the worker. more")).toBe(
      "the retry is lost in the worker.",
    );
    expect(firstSentence("```\ncode\n```")).toBe("code");
    expect(firstSentence("| a | b |\n|---|---|\nSee [the docs](https://x.y) first")).toBe(
      "See the docs first",
    );
    expect(firstSentence("# Report")).toBe("Report");
    expect(firstSentence("")).toBe("");
  });

  it("a structured workflow result is shown as json", () => {
    expect(workflowResultText({ ok: true })).toBe('```json\n{\n  "ok": true\n}\n```');
    expect(workflowResultText("  ")).toBeUndefined();
    expect(workflowResultText(undefined)).toBeUndefined();
  });
});
