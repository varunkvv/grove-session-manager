import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readToolDetail } from "../../src/sessions/agentTimeline.ts";
import {
  answerSteps,
  ConversationFold,
  type ConversationItem,
  type ConversationState,
  conversationTotals,
  type Turn,
  turnNumbers,
} from "../../src/sessions/conversation.ts";
import {
  loadCachedConversation,
  readConversation,
  readLastWords,
  saveCachedConversation,
} from "../../src/sessions/conversationFile.ts";
import type { ToolStep } from "../../src/sessions/timeline.ts";
import {
  apiError,
  apiErrorMessage,
  call,
  command,
  compactBoundary,
  compactSummary,
  hookNoise,
  image,
  jsonl,
  localCommand,
  prompt,
  queued,
  result,
  says,
  stdout,
  taskNotification,
  text,
  thinking,
  title,
  turnDuration,
  userLine,
} from "../helpers/sessionTranscript.ts";
import { makeSandbox } from "../helpers/transcript.ts";

// a stretch of a real 107MB session with every string replaced (scripts/redact-agents.ts --lines):
// three compactions (two automatic, one /compact), a stretch Claude Code wrote a second time with
// the same uuids, slash commands and their output, background tasks finishing, a question with
// answers, plans turned down and one approved, pasted images, and an agent's own transcript
const FIXTURE = path.join(
  import.meta.dirname,
  "../fixtures/conversation/78b60000-0000-4000-8000-000000000001.jsonl",
);
const AGENT_META = path.join(
  import.meta.dirname,
  "../fixtures/conversation/78b60000-0000-4000-8000-000000000001/subagents/agent-a78b6000000000002.meta.json",
);

const turns = (s: ConversationState) => s.items.filter((i): i is Turn => i.kind === "turn");

/** a fold without where its lines sat: the same conversation read from a differently cut file */
function shape(items: readonly ConversationItem[]): unknown {
  return JSON.parse(
    JSON.stringify(items, (k, v) => (k === "use" || k === "ref" || k === "offset" ? undefined : v)),
  );
}

function sandboxFile(lines: string): string {
  const file = path.join(makeSandbox("grove-conversation-"), "session.jsonl");
  writeFileSync(file, lines);
  return file;
}

describe("a session's conversation, from a real transcript", () => {
  it("cuts it into turns and compactions, in file order", async () => {
    const state = await readConversation(FIXTURE);
    const kinds = state.items.map((i) =>
      i.kind === "compact" ? `compact:${i.trigger}` : (i.prompt?.kind ?? "continued"),
    );
    expect(kinds).toEqual([
      "human",
      "command",
      "command",
      "human",
      "compact:auto",
      "continued",
      "human",
      "task",
      "human",
      "human",
      "human",
      "human",
      "compact:manual",
      "command",
      "human",
      "task",
      "task",
      "task",
      "task",
      "task",
      "task",
      "task",
      "task",
      "task",
      "task",
      "compact:auto",
      "continued",
      "human",
      "human",
      "human",
      "human",
      "command",
      "human",
    ]);
    // a compaction lands in the middle of a turn: the work goes on after it with nobody asking
    const dividers = state.items.filter((i) => i.kind === "compact");
    expect(dividers.map((d) => [d.preTokens, d.postTokens])).toEqual([
      [1_063_423, 42_921],
      [192_976, 37_764],
      [1_068_848, 44_036],
    ]);
    for (const d of dividers) expect(d.summary).toBeTruthy();
    expect(conversationTotals(state).turns).toBe(30);
  });

  it("skips what Claude Code wrote a second time, and nothing else", async () => {
    const lines = readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);
    const seen = new Set<string>();
    let copies = 0;
    const once = lines.filter((l) => {
      const e = JSON.parse(l);
      if (!e.uuid || !["user", "assistant", "system"].includes(e.type)) return true;
      if (seen.has(e.uuid)) {
        copies++;
        return false;
      }
      seen.add(e.uuid);
      return true;
    });
    // the stretch after the second compaction: the preserved segment, written again
    expect(copies).toBeGreaterThan(100);
    const folded = await readConversation(FIXTURE);
    const without = await readConversation(sandboxFile(`${once.join("\n")}\n`));
    expect(shape(folded.items)).toEqual(shape(without.items));
    // the copies carry the time of the original: the end is still the newest line
    expect(folded.lastAt).toBe(without.lastAt);
  });

  it("skips hook results and metadata on their bytes without losing anything", async () => {
    const fromFile = await readConversation(FIXTURE);
    const fold = new ConversationFold();
    let offset = 0;
    for (const line of readFileSync(FIXTURE, "utf8").split("\n")) {
      const length = Buffer.byteLength(line);
      if (line) fold.line(line, offset, length);
      offset += length + 1;
    }
    expect(fold.state.items).toEqual(fromFile.items);
  });

  it("pairs a command with its output, and says who sent a background task's news", async () => {
    const t = turns(await readConversation(FIXTURE));
    const commands = t.filter((x) => x.prompt?.kind === "command");
    expect(commands.map((c) => c.prompt?.text.split(" ")[0])).toEqual([
      "/model",
      "/model",
      "/compact",
      "/mcp",
    ]);
    for (const c of commands) {
      expect(c.output).toBeTruthy();
      expect(c.work.steps).toHaveLength(0);
    }
    const tasks = t.filter((x) => x.prompt?.kind === "task");
    expect(tasks).toHaveLength(11);
    for (const x of tasks) expect(x.prompt?.status).toBe("completed");
  });

  it("keeps the conversation inside a turn: the question, the plans, what was said", async () => {
    const t = turns(await readConversation(FIXTURE));
    const planning = t.find((x) => x.marks.some((m) => m.kind === "question"));
    expect(planning?.prompt?.kind).toBe("task");
    const question = planning?.marks.find((m) => m.kind === "question");
    expect(question?.kind === "question" && question.questions).toHaveLength(4);
    if (question?.kind === "question") {
      for (const q of question.questions) {
        expect(q.picked).toBeTruthy();
        expect(q.options).toContain(q.picked);
      }
    }
    const plans = planning?.marks.filter((m) => m.kind === "plan") ?? [];
    expect(plans.map((p) => p.kind === "plan" && p.outcome)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "approved",
    ]);
    // turned down with words: those are the person's reply, and they stay in sight
    for (const p of plans.slice(0, 3)) expect(p.kind === "plan" && p.said).toBeTruthy();
    // every mark sits on the step it came from
    for (const m of planning?.marks ?? []) {
      if (m.kind === "said") continue;
      const step = planning?.work.steps[m.step];
      expect(step?.kind === "tool" && step.name).toBe(
        m.kind === "plan" ? "ExitPlanMode" : "AskUserQuestion",
      );
    }
    const said = t.flatMap((x) => x.marks.filter((m) => m.kind === "said"));
    expect(said.length).toBeGreaterThan(0);
  });

  it("reads prompts the way they were typed: no editor context, images counted", async () => {
    const t = turns(await readConversation(FIXTURE));
    for (const x of t) {
      if (x.prompt?.kind === "human") expect(x.prompt.text.startsWith("<")).toBe(false);
    }
    expect(t.at(-1)?.prompt?.images).toBe(2);
    expect(t.find((x) => x.prompt?.plan)?.prompt?.kind).toBe("human");
  });

  it("gives each turn its work line and its answer", async () => {
    const state = await readConversation(FIXTURE);
    const t = turns(state);
    const edits = t.find((x) => turnNumbers(x).filesEdited > 5);
    expect(edits).toBeDefined();
    // the Agent call the subagent beside the transcript was started by
    const meta = JSON.parse(readFileSync(AGENT_META, "utf8"));
    const started = t.find((x) =>
      x.work.steps.some((s) => s.kind === "tool" && s.id === meta.toolUseId),
    );
    expect(started && turnNumbers(started).agents).toBe(3);
    // a turn that ends in words has them as its answer, and they are not a step of the work
    const answered = t.filter((x) => answerSteps(x.work).length > 0);
    expect(answered.length).toBeGreaterThan(20);
    for (const x of t) {
      const n = turnNumbers(x);
      expect(n.tools).toBe(x.work.steps.filter((s) => s.kind === "tool" && !s.server).length);
      if (n.durationMs !== undefined) expect(n.durationMs).toBeGreaterThanOrEqual(0);
    }
    // the view never shows a step's input or result preview, so the fold keeps neither
    for (const x of t) {
      for (const s of x.work.steps) {
        if (s.kind === "tool") {
          expect(s.input).toBe("");
          expect(s.result).toBeUndefined();
        }
      }
    }
    const totals = conversationTotals(state);
    expect(totals.model).toMatch(/^claude-/);
    expect(totals.tokens).toBeGreaterThan(0);
    expect(totals.tools).toBe(t.reduce((sum, x) => sum + x.work.toolCount, 0));
  });

  it("resumes a read where it stopped, and leaves every turn it did not touch alone", async () => {
    const whole = readFileSync(FIXTURE);
    // cut at a line in the middle of the file
    const cut = whole.indexOf(0x0a, Math.floor(whole.length / 2)) + 1;
    const file = sandboxFile(whole.subarray(0, cut).toString("utf8"));
    const first = await readConversation(file);
    expect(first.offset).toBe(cut);
    appendFileSync(file, whole.subarray(cut));
    const resumed = await readConversation(file, first);
    const cold = await readConversation(FIXTURE);
    expect(resumed.items).toEqual(cold.items);
    // the turns before the one the cut fell in are the same objects: nothing to send again
    const open = first.items.length - 1;
    for (let i = 0; i < open; i++) expect(resumed.items[i]).toBe(first.items[i]);
    // the reading it resumed from was not touched
    expect(first.offset).toBe(cut);
    expect(first.items).toHaveLength(open + 1);
  });

  it("leaves a line still being written for the next read", async () => {
    const whole = readFileSync(FIXTURE, "utf8");
    const file = sandboxFile(whole);
    const done = await readConversation(file);
    appendFileSync(file, '{"type":"user","message":{"role":"user","content":"half');
    const again = await readConversation(file, done);
    expect(again.offset).toBe(done.offset);
    expect(again.items).toEqual(done.items);
  });

  it("round-trips through the cache", async () => {
    const dir = makeSandbox("grove-conversation-cache-");
    const state = await readConversation(FIXTURE);
    await saveCachedConversation(dir, FIXTURE, "1:2", state);
    const back = await loadCachedConversation(dir, FIXTURE);
    expect(back?.mark).toBe("1:2");
    expect(back?.state).toEqual(state);
    expect(await loadCachedConversation(dir, `${FIXTURE}.other`)).toBeNull();
  });
});

describe("what the real stretch does not have", () => {
  const fold = (lines: object[]) => readConversation(sandboxFile(jsonl(lines)));

  it("an api error that a retry got past is noise. one nothing came after is the last word", async () => {
    const state = await fold([
      prompt("run the tests", 0),
      apiError(1, 1),
      apiError(2, 2),
      says("m1", text("All 40 pass."), 5),
      prompt("and lint", 10),
      says("m2", call("t1", "Bash", { command: "pnpm lint" }), 11),
      result("t1", "ok", 12),
      apiError(13, 1),
      apiError(14, 2),
      apiError(15, 3),
    ]);
    const [a, b] = turns(state);
    expect(a?.apiError).toBeUndefined();
    expect(b?.apiError).toBe("Connection dropped (ECONNRESET) · retry 3 of 10");
  });

  it("an api call that failed for good is the turn's error, and not its answer", async () => {
    const [t] = turns(
      await fold([prompt("go", 0), says("m1", text("Starting."), 1), apiErrorMessage(2)]),
    );
    expect(t?.work.last?.error).toMatch(/^API Error: 529/);
    expect(answerSteps(t!.work)).toEqual([]);
  });

  it("an interrupt ends the turn it happened in, even before anything was said", async () => {
    const state = await fold([
      prompt("refactor the parser", 0),
      userLine([text("[Request interrupted by user]")], 1),
      prompt("actually, just rename it", 5),
      says("m1", call("t1", "Edit", { file_path: "/work/api/parse.ts" }), 6),
      result("t1", "The user doesn't want to proceed with this tool use.", 7, { isError: true }),
      userLine([text("[Request interrupted by user for tool use]")], 7),
    ]);
    const [a, b] = turns(state);
    expect(a?.prompt?.text).toBe("refactor the parser");
    expect(a?.work.interrupted).toBe(true);
    expect(b?.work.interrupted).toBe(true);
    expect(b?.work.steps.find((s) => s.kind === "tool")).toMatchObject({ failure: "rejected" });
  });

  it("reads prompts and notifications written before `origin` existed", async () => {
    const state = await fold([
      prompt("what changed?", 0, { origin: false }),
      says("m1", text("Two files."), 1),
      taskNotification("Background command &quot;pnpm test&quot; completed", 5, { origin: false }),
    ]);
    const [a, b] = turns(state);
    expect(a?.prompt).toMatchObject({ kind: "human", text: "what changed?" });
    expect(b?.prompt).toMatchObject({
      kind: "task",
      text: 'Background command "pnpm test" completed',
    });
  });

  it("a command's expansion is its content, not a second prompt, whichever tag comes first", async () => {
    const state = await fold([
      command("code-review", "since main", 0, true),
      userLine([text("Review the changes since main...")], 0, { isMeta: true }),
      says("m1", text("Looks fine."), 3),
      command("mcp", "", 10),
      localCommand("2 MCP server(s): 2 connected", 10),
      command("model", "opus", 20),
      stdout("Set model to \u001b[1mopus\u001b[22m", 20),
    ]);
    const t = turns(state);
    expect(t.map((x) => x.prompt?.text)).toEqual([
      "/code-review since main",
      "/mcp",
      "/model opus",
    ]);
    expect(t.map((x) => x.output)).toEqual([
      undefined,
      "2 MCP server(s): 2 connected",
      "Set model to opus",
    ]);
    expect(answerSteps(t[0]!.work)).toHaveLength(1);
  });

  it("what the person typed while it worked is theirs. the same prompt sent twice is not", async () => {
    const [t] = turns(
      await fold([
        prompt("look at the logs", 0),
        queued("look at the logs", 1),
        says("m1", call("t1", "Read", { file_path: "/work/api/app.log" }), 2),
        result("t1", "...", 3),
        queued("and the metrics too", 4),
        queued("<task-notification>done</task-notification>", 4, "task-notification"),
        says("m2", text("Both say the same."), 6),
      ]),
    );
    expect(t?.marks).toEqual([
      { kind: "said", step: 1, at: expect.any(Number), text: "and the metrics too" },
    ]);
  });

  it("a plan that was approved, and questions whose answers are keyed differently", async () => {
    const q = (question: string, labels: string[]) => ({
      question,
      header: "H",
      options: labels.map((label) => ({ label, description: "d" })),
    });
    const [t] = turns(
      await fold([
        prompt("plan it", 0),
        says(
          "m1",
          call("q1", "AskUserQuestion", {
            questions: [q("Which db?", ["pg", "mysql"]), q("Cache?", ["yes", "no"])],
          }),
          1,
        ),
        result("q1", "Your questions have been answered", 5, {
          told: { questions: [], answers: { "Which db (cut)?": "pg", "Cache?": "no" } },
        }),
        says("m2", call("p1", "ExitPlanMode", { plan: "# the plan\n\n1. migrate" }), 6),
        result("p1", "User has approved your plan.", 9, {
          told: { plan: "# the plan", filePath: "/p.md", isAgent: false },
        }),
        says("m3", text("Done."), 10),
      ]),
    );
    const [question, plan] = t?.marks ?? [];
    expect(question).toMatchObject({
      kind: "question",
      step: 0,
      questions: [
        { question: "Which db?", options: ["pg", "mysql"], picked: "pg", header: "H" },
        { question: "Cache?", options: ["yes", "no"], picked: "no" },
      ],
    });
    expect(plan).toMatchObject({
      kind: "plan",
      step: 1,
      outcome: "approved",
      text: "# the plan\n\n1. migrate",
    });
  });

  it("a result that comes after its turn ended goes back to the turn that made the call", async () => {
    const state = await fold([
      prompt("start the build", 0),
      says("m1", call("t1", "Bash", { command: "make", run_in_background: true }), 1),
      prompt("while that runs, what is 2+2", 2),
      result("t1", "built", 30),
      says("m2", text("4"), 31),
    ]);
    const [a, b] = turns(state);
    expect(a?.work.steps[0]).toMatchObject({ kind: "tool", durationMs: 29_000 });
    expect(b?.work.steps).toHaveLength(1);
  });

  it("takes the turn's length from Claude Code where it writes one, and skips its noise", async () => {
    const [t] = turns(
      await fold([
        title("a title"),
        prompt(
          [image(), text("<ide_selection>lines 1-4</ide_selection>"), text("why is this slow?")],
          0,
        ),
        hookNoise(1),
        says("m1", thinking("the loop allocates"), 2),
        says("m1", text("It allocates in the loop."), 3),
        turnDuration(8_657, 4),
      ]),
    );
    expect(t?.prompt).toMatchObject({ text: "why is this slow?", images: 1 });
    expect(turnNumbers(t!).durationMs).toBe(8_657);
    expect(t?.work.steps.map((s) => s.kind)).toEqual(["thinking", "text"]);
  });

  it("a prompt that was nothing but editor context still starts a turn", async () => {
    const state = await fold([
      prompt("first", 0),
      says("m1", text("ok"), 1),
      prompt([text("<ide_opened_file>The user opened /work/api/a.ts</ide_opened_file>")], 5),
      says("m2", text("That file exports one function."), 6),
    ]);
    const t = turns(state);
    expect(t).toHaveLength(2);
    expect(t[1]?.prompt?.text).toBe("The user opened /work/api/a.ts");
  });

  it("work before any prompt, and after a compaction, is a turn nobody asked for", async () => {
    const state = await fold([
      says("m0", text("Resuming."), 0),
      prompt("go on", 1),
      says("m1", call("t1", "Read", { file_path: "/work/api/a.ts" }), 2),
      compactBoundary(3),
      compactSummary("Summary: reading files.", 3),
      result("t1", "x", 4),
      says("m2", text("Read it."), 5),
    ]);
    expect(state.items.map((i) => (i.kind === "turn" ? (i.prompt?.text ?? "-") : "|"))).toEqual([
      "-",
      "go on",
      "|",
      "-",
    ]);
    // the call was made before the compaction, so its result goes back to that turn
    expect((state.items[1] as Turn).work.steps[0]).toMatchObject({ durationMs: 2_000 });
    expect(state.items[2]).toMatchObject({
      kind: "compact",
      summary: expect.stringContaining("reading files"),
    });
  });
});

describe("a step of the conversation, opened", () => {
  const toolSteps = (state: ConversationState) =>
    turns(state).flatMap((t) => t.work.steps.filter((s): s is ToolStep => s.kind === "tool"));

  it("draws what an Edit, a Write and a Bash did from Claude Code's own account of it", async () => {
    const steps = toolSteps(await readConversation(FIXTURE));
    const edit = await readToolDetail(FIXTURE, steps.find((s) => s.name === "Edit")!);
    expect(edit?.diffs?.[0]?.path).toMatch(/^\/fixture\//);
    const hunk = edit?.diffs?.[0]?.hunks[0];
    expect(hunk?.lines.every((l) => /^[ +-]/.test(l))).toBe(true);
    expect(hunk?.newStart).toBeGreaterThan(0);
    // the file as it was before is in the transcript too, and never read out of it
    expect(JSON.stringify(edit)).not.toContain("originalFile");
    const writes = await Promise.all(
      steps.filter((s) => s.name === "Write").map((s) => readToolDetail(FIXTURE, s)),
    );
    const created = writes.find((w) => w?.diffs?.[0]?.created);
    expect(created?.diffs?.[0]?.hunks[0]?.lines.every((l) => l.startsWith("+"))).toBe(true);
    const bash = await readToolDetail(FIXTURE, steps.find((s) => s.name === "Bash" && s.ref)!);
    expect(bash?.bash).toMatchObject({ interrupted: false });
    expect(typeof bash?.bash?.stdout).toBe("string");
  });

  it("keeps a Bash call's streams apart, and says where a big output went without reading it", async () => {
    const file = sandboxFile(
      jsonl([
        prompt("run it", 0),
        says("m1", call("b1", "Bash", { command: "pnpm test" }), 1),
        result("b1", "Exit code 1\nFAIL", 2, {
          isError: true,
          told: {
            stdout: "FAIL src/a.test.ts",
            stderr: "npm ERR! test failed",
            interrupted: false,
            isImage: false,
            noOutputExpected: false,
            persistedOutputPath: "/work/api/.claude/tool-results/b1.txt",
            returnCodeInterpretation: "Tests failed",
          },
        }),
      ]),
    );
    const state = await readConversation(file);
    const detail = await readToolDetail(file, toolSteps(state)[0]!);
    expect(detail?.bash).toEqual({
      stdout: "FAIL src/a.test.ts",
      stderr: "npm ERR! test failed",
      interrupted: false,
      persisted: "/work/api/.claude/tool-results/b1.txt",
      exit: "Tests failed",
    });
    expect(detail?.isError).toBe(true);
  });

  it("gives a question every option and its pick, and a plan whole", async () => {
    const file = sandboxFile(
      jsonl([
        prompt("plan it", 0),
        says(
          "m1",
          call("q1", "AskUserQuestion", {
            questions: [
              {
                question: "Which db?",
                header: "DB",
                options: [
                  { label: "pg", description: "d" },
                  { label: "mysql", description: "d" },
                ],
              },
            ],
          }),
          1,
        ),
        result("q1", "answered", 2, { told: { questions: [], answers: { "Which db?": "pg" } } }),
        says("m2", call("p1", "ExitPlanMode", { plan: "# plan\n\nstep one" }), 3),
      ]),
    );
    const [question, plan] = toolSteps(await readConversation(file));
    expect((await readToolDetail(file, question!))?.questions).toEqual([
      { question: "Which db?", header: "DB", options: ["pg", "mysql"], picked: "pg" },
    ]);
    // still waiting on the person: the plan is there before any answer is
    expect((await readToolDetail(file, plan!))?.plan).toBe("# plan\n\nstep one");
  });
});

describe("the last words of a session, from the end of its transcript", () => {
  it("every text block of the last response, when it ended on words", async () => {
    const file = sandboxFile(
      jsonl([
        prompt("tidy it", 0),
        says("m1", call("t1", "Bash", { command: "ls" }), 1),
        result("t1", "a b", 2),
        says("m2", text("Removed two files."), 3),
        says("m2", text("Want me to commit it?"), 4),
        hookNoise(5),
        title("tidy"),
      ]),
    );
    expect(await readLastWords(file)).toBe("Removed two files.\n\nWant me to commit it?");
  });

  it("nothing when the last response called a tool, or the file is gone", async () => {
    const file = sandboxFile(
      jsonl([
        prompt("go", 0),
        says("m1", text("Starting."), 1),
        says("m1", call("t1", "Read", { file_path: "/a" }), 2),
      ]),
    );
    expect(await readLastWords(file)).toBeNull();
    expect(await readLastWords(`${file}.gone`)).toBeNull();
  });
});
