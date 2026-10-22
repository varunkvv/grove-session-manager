import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  answerSteps,
  ConversationFold,
  type ConversationItem,
  type ConversationState,
  conversationMarkdown,
  conversationView,
  editDiff,
  filesWritten,
  MESSAGE_MAX,
  type Turn,
  type TurnView,
  turnNumbers,
} from "../../src/sessions/conversation.ts";
import {
  readAgentTimeline,
  readConversation,
  readEditDiff,
} from "../../src/sessions/conversationFile.ts";
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
    expect(turns(state)).toHaveLength(30);
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

  it("knows where the conversation ends, whatever Claude Code appends after it", async () => {
    const file = sandboxFile(
      jsonl([
        prompt("tidy it", 0),
        says("m1", text("Removed two files."), 3),
        turnDuration(900, 3),
      ]),
    );
    const done = await readConversation(file);
    expect(done.end).toBeGreaterThan(0);
    expect(done.end).toBeLessThan(done.offset);
    // bookkeeping written long after the turn: the file grows, the conversation does not
    appendFileSync(file, jsonl([hookNoise(60), title("tidy"), { type: "cost-state" }]));
    const later = await readConversation(file, done);
    expect(later.offset).toBeGreaterThan(done.offset);
    expect(later.end).toBe(done.end);
    appendFileSync(file, jsonl([queued("and the tests", 90)]));
    expect((await readConversation(file, later)).end).toBeGreaterThan(done.end);
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

  it("names the files a prompt came with, and only a chat window's view carries them", async () => {
    const doc = (title: string) => ({
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "a,b" },
      title,
    });
    const state = await fold([
      prompt([image(), doc("data.csv"), doc("spec.pdf"), text("what is in these?")], 0),
      says("m1", text("Two files."), 1),
      // nothing but a file: still a turn
      prompt([doc("notes.txt")], 2),
      says("m2", text("Notes."), 3),
    ]);
    const [a, b] = turns(state);
    expect(a?.prompt).toMatchObject({ images: 1, files: ["data.csv", "spec.pdf"] });
    expect(b?.prompt).toMatchObject({ text: "", files: ["notes.txt"] });
    const chat = conversationView(state, { chat: true }).items[0] as TurnView;
    expect(chat.prompt?.files).toEqual(["data.csv", "spec.pdf"]);
    // the panel's view is as it was
    const panel = conversationView(state).items[0] as TurnView;
    expect(panel.prompt).not.toHaveProperty("files");
  });

  it("lists a turn's steps for a chat window, with the thinking before the answer apart", async () => {
    const state = await fold([
      prompt("why does it spin?", 0),
      says("m1", thinking("read the helper first"), 8),
      says("m1", call("t1", "Read", { file_path: "/p/retry.ts" }), 9),
      result("t1", "code", 10),
      says("m2", text("The tests next."), 11),
      says("m2", call("t2", "Bash", { command: "pnpm test" }), 12),
      result("t2", "Exit code 1\nFAIL", 16, { isError: true }),
      says("m3", thinking("the counter resets"), 22),
      says("m3", text("It resets in the loop."), 23),
    ]);
    const view = conversationView(state, { chat: true }).items[0] as TurnView;
    expect(view.steps).toEqual([
      { kind: "thinking", text: "read the helper first", ms: 8000 },
      { kind: "tool", id: "t1", name: "Read", target: "/p/retry.ts", ms: 1000 },
      { kind: "text", text: "The tests next." },
      { kind: "tool", id: "t2", name: "Bash", target: "pnpm test", ms: 4000, failed: "exit 1" },
    ]);
    // from the failed result to when the thinking was written
    expect(view.thought).toEqual({ text: "the counter resets", ms: 6000 });
    expect(view.text).toBe("It resets in the loop.");
    // the panel's view has what it said on the way, and no tools or thinking
    const panel = conversationView(state).items[0] as TurnView;
    expect(panel.steps).toEqual([{ kind: "text", text: "The tests next." }]);
    expect(panel).not.toHaveProperty("thought");
  });

  it("keeps what a command claude code answers itself said, for a chat window", async () => {
    const synthetic = (t: string, sec: number) => {
      const line = says("s1", text(t), sec) as { message: { model: string } };
      line.message.model = "<synthetic>";
      return line;
    };
    const state = await fold([
      command("context", "", 0),
      synthetic("## Context Usage\n\n| Category | Tokens |", 1),
      prompt("hello", 2),
      synthetic("API Error: overloaded", 3),
    ]);
    const [ctx, hello] = conversationView(state, { chat: true }).items as TurnView[];
    expect(ctx?.output).toContain("## Context Usage");
    // an api error is no command's output
    expect(hello?.output).toBeUndefined();
    expect((conversationView(state).items[0] as TurnView).output).toBeUndefined();
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

describe("the conversation as the page gets it", () => {
  const view = async (lines: object[]) =>
    conversationView(await readConversation(sandboxFile(jsonl(lines))));
  const turnsOf = (v: { items: Array<TurnView | { kind: "compact" }> }) =>
    v.items.filter((i): i is TurnView => i.kind === "turn");

  it("is every turn of a real session without the tools and thinking inside it", async () => {
    const v = conversationView(await readConversation(FIXTURE));
    expect(v.older).toBe(0);
    expect(v.items.filter((i) => i.kind === "compact")).toHaveLength(3);
    const t = turnsOf(v);
    expect(t).toHaveLength(30);
    expect(t.filter((x) => x.prompt?.kind === "human").length).toBeGreaterThan(10);
    expect(t.filter((x) => x.text).length).toBeGreaterThan(20);
    // no thinking, no tool's name or output: the numbers of the work, and what it said
    for (const x of t) {
      expect(Object.keys(x).every((k) => TURN_KEYS.includes(k))).toBe(true);
      expect(x.steps?.every((s) => s.kind === "text" || s.kind === "said") ?? true).toBe(true);
    }
  });
  const TURN_KEYS = [
    "kind",
    "prompt",
    "tools",
    "files",
    "agents",
    "ms",
    "text",
    "note",
    "outputs",
    "steps",
  ];

  it("says who started a turn, the work in numbers, and the message it ended on", async () => {
    const v = await view([
      prompt("fix the parser", 0),
      says("m1", thinking("the loop allocates"), 1),
      says("m1", text("Looking at the parser."), 1),
      says("m2", call("t1", "Edit", { file_path: "/work/api/parse.ts" }), 2),
      result("t1", "THE TOOL OUTPUT", 3),
      queued("and the tests too", 4),
      says("m3", call("t2", "Edit", { file_path: "/work/api/parse.ts" }), 5),
      result("t2", "ok", 6),
      says("m4", call("t3", "Agent", { description: "run the suite" }), 7),
      result("t3", "40 passed", 8),
      says("m5", text("Fixed, and all 40 pass."), 9),
      turnDuration(240_000, 9),
      command("model", "opus", 20),
      stdout("Set model to opus", 20),
      taskNotification("Background command pnpm build completed", 30),
      says("m6", text("The build is green."), 31),
    ]);
    expect(v).toEqual({
      older: 0,
      items: [
        {
          kind: "turn",
          prompt: { kind: "human", text: "fix the parser" },
          tools: 3,
          files: 1,
          agents: 1,
          ms: 240_000,
          // what he typed sits where it was handed over: after the first edit's result
          steps: [
            { kind: "text", text: "Looking at the parser." },
            { kind: "said", text: "and the tests too" },
          ],
          text: "Fixed, and all 40 pass.",
        },
        {
          kind: "turn",
          prompt: { kind: "command", text: "/model opus" },
          tools: 0,
          files: 0,
          agents: 0,
          ms: 0,
        },
        {
          kind: "turn",
          prompt: { kind: "task", text: "Background command pnpm build completed" },
          tools: 0,
          files: 0,
          agents: 0,
          ms: 1000,
          text: "The build is green.",
        },
      ],
    });
    expect(JSON.stringify(v)).not.toContain("THE TOOL OUTPUT");
    expect(JSON.stringify(v)).not.toContain("the loop allocates");
  });

  it("marks a compaction, an interrupt and an api error, and what the last turn said so far", async () => {
    const v = await view([
      prompt("refactor it", 0),
      userLine([text("[Request interrupted by user]")], 1),
      prompt("go on", 5),
      says("m1", text("Starting."), 6),
      apiErrorMessage(7),
      prompt("again", 10),
      says("m2", call("t1", "Read", { file_path: "/work/api/a.ts" }), 11),
      compactBoundary(12),
      compactSummary("Summary: reading files.", 12),
      result("t1", "x", 13),
      says("m3", text("Reading the second file now."), 14),
      says("m3", call("t2", "Read", { file_path: "/work/api/b.ts" }), 15),
    ]);
    const said = (t: TurnView) => t.steps?.map((s) => (s.kind === "text" ? s.text : s.kind));
    expect(
      v.items.map((i) => (i.kind === "turn" ? [i.prompt?.text, i.text, i.note, said(i)] : "|")),
    ).toEqual([
      ["refactor it", undefined, "Interrupted", undefined],
      // what it said before the error is not what it ended on: it is what it said on the way
      ["go on", undefined, "API Error: 529 Overloaded", ["Starting."]],
      ["again", undefined, undefined, undefined],
      "|",
      // the work that carried on after the compaction: nobody asked, and it has not ended, so
      // what it said so far is all it said
      [undefined, undefined, undefined, ["Reading the second file now."]],
    ]);
  });

  it("sends the last 100 turns, and how many came before them", async () => {
    const lines: object[] = [];
    for (let i = 0; i < 130; i++) {
      lines.push(prompt(`prompt ${i}`, i * 10), says(`m${i}`, text(`answer ${i}`), i * 10 + 1));
      if (i === 20 || i === 60) lines.push(compactBoundary(i * 10 + 2));
    }
    const v = await view(lines);
    expect(v.older).toBe(30);
    expect(turnsOf(v)).toHaveLength(100);
    expect(turnsOf(v)[0]?.prompt?.text).toBe("prompt 30");
    expect(turnsOf(v).at(-1)?.text).toBe("answer 129");
    // a compaction among the turns that are sent stays where it happened. one before them is gone
    expect(v.items.filter((i) => i.kind === "compact")).toHaveLength(1);
    expect(v.items[31]).toEqual({ kind: "compact" });
  });

  it("keeps the start of a long prompt and the end of a long message", async () => {
    const v = await view([
      prompt(`START ${"p".repeat(6000)}`, 0),
      says("m1", text(`${"a".repeat(9000)} END ONE`), 1),
      prompt("next", 10),
      says("m2", text(`${"b".repeat(19_000)} END TWO`), 11),
    ]);
    const [a, b] = turnsOf(v);
    expect(a?.prompt?.text).toHaveLength(4000);
    expect(a?.prompt?.text.startsWith("START")).toBe(true);
    expect(a?.text).toHaveLength(8000);
    expect(a?.text?.startsWith("…")).toBe(true);
    expect(a?.text?.endsWith("END ONE")).toBe(true);
    // the last message is what the panel is for: it gets more
    expect(b?.text?.endsWith("END TWO")).toBe(true);
    expect(b?.text?.startsWith("b")).toBe(true);
  });

  it("is empty for a transcript nobody said anything in", async () => {
    expect(await view([title("a title")])).toEqual({ older: 0, items: [] });
  });
});

describe("the files a turn showed", () => {
  const view = async (lines: object[]) =>
    conversationView(await readConversation(sandboxFile(jsonl(lines))));

  it("cards what it wrote that can be drawn and the images it read, once each", async () => {
    const v = await view([
      prompt("draw it", 0),
      says("m1", call("t1", "Read", { file_path: "/w/shot.png" }), 1),
      result("t1", "[image]", 2),
      says("m2", call("t2", "Read", { file_path: "/w/notes.md" }), 3),
      result("t2", "notes", 4),
      says("m3", call("t3", "Write", { file_path: "/w/plan.md" }), 5),
      result("t3", "ok", 6),
      says("m4", call("t4", "Edit", { file_path: "/w/plan.md" }), 7),
      result("t4", "ok", 8),
      says("m5", call("t5", "Write", { file_path: "/w/app.ts" }), 9),
      result("t5", "ok", 10),
      says("m6", call("t6", "Write", { file_path: "/w/gone.svg" }), 11),
      result("t6", "denied", 12, { isError: true }),
      says("m7", call("t7", "Write", { file_path: "/w/page.html" }), 13),
      result("t7", "ok", 14),
      says("m8", text("Done."), 15),
    ]);
    const turn = v.items[0] as TurnView;
    expect(turn.outputs).toEqual([
      { path: "/w/shot.png", read: true },
      { path: "/w/plan.md" },
      { path: "/w/page.html" },
    ]);
  });

  it("lists every file the session wrote, the latest first", async () => {
    const state = await readConversation(
      sandboxFile(
        jsonl([
          prompt("one", 0),
          says("m1", call("t1", "Write", { file_path: "/w/a.ts" }), 1),
          result("t1", "ok", 2),
          says("m2", call("t2", "Read", { file_path: "/w/r.ts" }), 3),
          result("t2", "ok", 4),
          prompt("two", 5),
          says("m3", call("t3", "MultiEdit", { file_path: "/w/b.ts" }), 6),
          result("t3", "ok", 7),
          says("m4", call("t4", "Edit", { file_path: "/w/a.ts" }), 8),
          result("t4", "ok", 9),
        ]),
      ),
    );
    expect(filesWritten(state)).toEqual(["/w/a.ts", "/w/b.ts"]);
  });
});

describe("a long message", () => {
  it("is cut for the panel and whole for a chat window", async () => {
    const long = `${"a line of a long report\n".repeat(2000)}the end`;
    const state = await readConversation(
      sandboxFile(jsonl([prompt("write it all", 0), says("m1", text(long), 1)])),
    );
    const panel = conversationView(state).items[0] as TurnView;
    expect(panel.text?.length).toBeLessThan(long.length);
    const chat = conversationView(state, { textMax: MESSAGE_MAX }).items[0] as TurnView;
    expect(chat.text).toBe(long);
  });
});

describe("what an edit changed", () => {
  it("draws claude code's own patch, a write as all added, an edit from its strings", () => {
    const patch = {
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [" alpha", "-beta", "+BETA", " gamma"],
        },
      ],
    };
    expect(editDiff("Edit", { old_string: "beta", new_string: "BETA" }, patch)).toEqual([
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
    ]);
    // a write that made the file: its patch is empty, its content is all of it
    expect(
      editDiff(
        "Write",
        { content: "a\nb\n" },
        { type: "create", content: "a\nb\n", structuredPatch: [] },
      ),
    ).toEqual(["+a", "+b"]);
    expect(editDiff("Edit", { old_string: "x\ny", new_string: "z" })).toEqual(["-x", "-y", "+z"]);
    expect(
      editDiff("MultiEdit", {
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      }),
    ).toEqual(["-a", "+b", "@@", "-c", "+d"]);
    expect(editDiff("Bash", { command: "ls" })).toBeUndefined();
    const long = editDiff("Write", { content: "x\n".repeat(450) });
    expect(long).toHaveLength(401);
    expect(long?.at(-1)).toBe("… 50 more lines");
  });

  it("reads one edit's diff back from the transcript by its call's id", async () => {
    const file = sandboxFile(
      jsonl([
        prompt("change beta", 0),
        says(
          "m1",
          call("t1", "Edit", { file_path: "/p/e.txt", old_string: "beta", new_string: "BETA" }),
          1,
        ),
        result("t1", "updated", 2, {
          told: {
            structuredPatch: [
              { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ["-beta", "+BETA"] },
            ],
          },
        }),
        says("m2", call("t2", "Bash", { command: "ls" }), 3),
        result("t2", "e.txt", 4),
      ]),
    );
    expect(await readEditDiff(file, "t1")).toEqual(["@@ -2,1 +2,1 @@", "-beta", "+BETA"]);
    // not an edit, not there
    expect(await readEditDiff(file, "t2")).toBeNull();
    expect(await readEditDiff(file, "nope")).toBeNull();
  });
});

describe("a chat window's turn that died on an api error", () => {
  it("says it failed, so it can be asked again, and only in a chat window's view", async () => {
    const file = sandboxFile(
      jsonl([prompt("go", 0), says("m1", text("Starting."), 1), apiErrorMessage(2)]),
    );
    const state = await readConversation(file);
    const chat = conversationView(state, { chat: true }).items[0] as TurnView;
    expect(chat.failed).toBe(true);
    expect(chat.note).toMatch(/^API Error/);
    expect((conversationView(state).items[0] as TurnView).failed).toBeUndefined();
  });
});

describe("a running agent's transcript, followed", () => {
  it("reads only what was written since the last read, and comes to the same", async () => {
    const first = [prompt("list it", 0), says("m1", call("t1", "Bash", { command: "ls" }), 1)];
    const rest = [result("t1", "a.txt", 2), says("m2", text("Found a.txt."), 3)];
    const file = sandboxFile(jsonl(first));
    const before = await readAgentTimeline(file);
    expect(before.steps.find((s) => s.kind === "tool")).toMatchObject({ name: "Bash" });
    appendFileSync(file, jsonl(rest));
    const after = await readAgentTimeline(file, {}, before);
    const whole = await readAgentTimeline(file);
    expect(shape(after.steps as never)).toEqual(shape(whole.steps as never));
    expect(after.offset).toBe(whole.offset);
    // nothing new: the same read back
    expect(await readAgentTimeline(file, {}, after)).toBe(after);
  });
});

describe("the conversation as markdown, and more of it", () => {
  it("is each prompt and its answer whole, in order, with a compaction where it was", async () => {
    const state = await readConversation(
      sandboxFile(
        jsonl([
          prompt("why does it spin?", 0),
          says("m1", call("t1", "Bash", { command: "ls" }), 1),
          result("t1", "a.txt", 2),
          says("m2", text("Because the delay resets."), 3),
          prompt("fix it", 4),
          says("m3", text("Fixed."), 5),
        ]),
      ),
    );
    expect(conversationMarkdown(state, "the loop")).toBe(
      "# the loop\n\n## You\n\nwhy does it spin?\n\n## Claude\n\nBecause the delay resets.\n\n## You\n\nfix it\n\n## Claude\n\nFixed.\n",
    );
    // a chat window asks for more of the last turns than the usual
    expect(conversationView(state, { turns: 1 }).older).toBe(1);
    expect(conversationView(state, { turns: 5 }).older).toBe(0);
  });
});

describe("every message claude writes in a turn", () => {
  const fold = (lines: object[]) => readConversation(sandboxFile(jsonl(lines)));
  const LINK = "https://claude.ai/code/artifact/5c6ce80e-62a5-4f85-9d6a-6e91bc9e31fb";

  // session 7797c6c8: one api message is a text, then tool calls with their results between them.
  // a later text took the first one's place, and the first went where nobody saw it
  const stack = [
    prompt("go through the security changes in the stack and write it up", 0),
    says("m1", text(`outline up: ${LINK} - now orienting on the stack and recent main`), 1),
    says("m1", call("t1", "mcp__claude_ai_Claude_Docs__guide", { items: ["topic.index"] }), 2),
    result("t1", "the index", 3),
    says("m1", call("t2", "Bash", { command: "git log --oneline -20 main" }), 4),
    result("t2", "abc fix", 5),
    says("m1", call("t3", "Bash", { command: "gh pr view 412" }), 6),
    result("t3", "#412", 7),
    says("m2", text("the stack section is in. now checking each security change"), 8),
    says("m2", call("t4", "Read", { file_path: "/p/src/auth/rotate.ts" }), 9),
    result("t4", "code", 10),
    says("m3", thinking("412 keeps the old token valid"), 12),
    says("m3", text("Two need a change before they merge."), 13),
  ];

  it("keeps each text where it was said, whole, in the chat window's and the panel's view", async () => {
    const state = await fold(stack);
    const chat = conversationView(state, { chat: true, textMax: MESSAGE_MAX }).items[0] as TurnView;
    expect(chat.steps?.map((s) => (s.kind === "text" ? s.text : s.kind))).toEqual([
      `outline up: ${LINK} - now orienting on the stack and recent main`,
      "tool",
      "tool",
      "tool",
      "the stack section is in. now checking each security change",
      "tool",
    ]);
    expect(chat.thought?.text).toBe("412 keeps the old token valid");
    expect(chat.text).toBe("Two need a change before they merge.");
    const panel = conversationView(state).items[0] as TurnView;
    expect(panel.steps).toEqual([
      { kind: "text", text: `outline up: ${LINK} - now orienting on the stack and recent main` },
      { kind: "text", text: "the stack section is in. now checking each security change" },
    ]);
    expect(panel.text).toBe("Two need a change before they merge.");
  });

  it("a turn that has not answered has no answer: the last thing it said is a text in its place", async () => {
    // under way, on the Read it called after its second text
    const state = await fold(stack.slice(0, 11));
    for (const view of [conversationView(state, { chat: true }), conversationView(state)]) {
      const turn = view.items[0] as TurnView;
      expect(turn.text).toBeUndefined();
      expect(turn.steps?.findLast((s) => s.kind === "text")).toEqual({
        kind: "text",
        text: "the stack section is in. now checking each security change",
      });
    }
  });

  it("gives a mid-turn text the answer's length, not a step's", async () => {
    const long = `${"a line of the stack section\n".repeat(300)}the end`;
    const state = await fold([
      prompt("write it", 0),
      says("m1", text(long), 1),
      says("m1", call("t1", "Bash", { command: "ls" }), 2),
      result("t1", "a", 3),
      says("m2", text("Done."), 4),
    ]);
    const chat = conversationView(state, { chat: true, textMax: MESSAGE_MAX }).items[0] as TurnView;
    expect(chat.steps?.[0]).toEqual({ kind: "text", text: long });
    // the panel's last turn keeps what its answer keeps: the end, where the question is
    const panel = conversationView(state).items[0] as TurnView;
    expect(panel.steps?.[0]).toEqual({ kind: "text", text: long });
  });

  it("drops a long turn's oldest tools and thinking, never a text", async () => {
    const lines: object[] = [prompt("do it all", 0), says("m0", text(`outline up: ${LINK}`), 1)];
    for (let i = 0; i < 400; i++) {
      lines.push(says(`m${i + 1}`, call(`t${i}`, "Bash", { command: `step ${i}` }), 2 + i));
      lines.push(result(`t${i}`, "ok", 2 + i));
    }
    lines.push(says("mz", text("All 400 done."), 500));
    const view = conversationView(await fold(lines), { chat: true }).items[0] as TurnView;
    expect(view.steps?.[0]).toEqual({ kind: "text", text: `outline up: ${LINK}` });
    expect(view.steps).toHaveLength(301);
    expect(view.stepsBefore).toBe(100);
    expect(view.steps?.[1]).toMatchObject({ kind: "tool", target: "step 100" });
  });

  it("puts what he typed while it worked where it was handed over, with the uuid it was sent with", async () => {
    const lines = [
      prompt("fix the retry loop", 0),
      says("m1", call("t1", "Read", { file_path: "/p/fetch.ts" }), 1),
      result("t1", "code", 2),
      queued("and run the retry tests", 3, "prompt", "aaaa-1"),
      says("m2", text("Running them too."), 4),
      says("m2", call("t2", "Bash", { command: "pnpm test retry" }), 5),
      result("t2", "ok", 6),
    ];
    const going = await fold(lines);
    const chat = conversationView(going, { chat: true }).items[0] as TurnView;
    expect(chat.steps?.map((s) => s.kind)).toEqual(["tool", "said", "text", "tool"]);
    expect(chat.steps?.[1]).toEqual({
      kind: "said",
      text: "and run the retry tests",
      uuid: "aaaa-1",
    });
    // typed just now, before claude did anything with it: the turn's end, where the row was
    const now = await fold([...lines, queued("and the lint", 7, "prompt", "aaaa-2")]);
    const end = conversationView(now, { chat: true }).items[0] as TurnView;
    expect(end.steps?.at(-1)).toEqual({ kind: "said", text: "and the lint", uuid: "aaaa-2" });
    // the panel has what was said both ways, in order
    const panel = conversationView(now).items[0] as TurnView;
    expect(panel.steps?.map((s) => s.kind)).toEqual(["said", "text", "said"]);
    // the markdown has his under his own heading, in order
    expect(conversationMarkdown(now, "retry")).toBe(
      `${[
        "# retry",
        "## You",
        "fix the retry loop",
        "## You",
        "and run the retry tests",
        "## Claude",
        "Running them too.",
        "## You",
        "and the lint",
      ].join("\n\n")}\n`,
    );
  });

  it("keeps what he typed through a long turn's cut, as it keeps a text", async () => {
    const lines: object[] = [prompt("do it all", 0)];
    for (let i = 0; i < 400; i++) {
      lines.push(says(`m${i + 1}`, call(`t${i}`, "Bash", { command: `step ${i}` }), 2 + i));
      lines.push(result(`t${i}`, "ok", 2 + i));
      if (i === 10) lines.push(queued("skip the slow ones", 2 + i, "prompt", "bbbb-1"));
    }
    lines.push(says("mz", text("All 400 done."), 500));
    const view = conversationView(await fold(lines), { chat: true }).items[0] as TurnView;
    expect(view.steps?.[0]).toEqual({ kind: "said", text: "skip the slow ones", uuid: "bbbb-1" });
    expect(view.steps).toHaveLength(301);
    expect(view.stepsBefore).toBe(100);
    expect(view.steps?.[1]).toMatchObject({ kind: "tool", target: "step 100" });
  });

  it("keeps the thinking before a mid-turn text with that text, not with the answer", async () => {
    const state = await fold([
      prompt("plan it", 0),
      says("m1", thinking("an outline first"), 1),
      says("m1", text("outline up."), 2),
      says("m2", thinking("now the answer"), 5),
      says("m2", text("Here it is."), 6),
    ]);
    const view = conversationView(state, { chat: true }).items[0] as TurnView;
    expect(view.steps).toEqual([
      { kind: "thinking", text: "an outline first", ms: 1000 },
      { kind: "text", text: "outline up." },
    ]);
    expect(view.thought).toEqual({ text: "now the answer", ms: 3000 });
  });

  it("the markdown export has every text of a turn in order", async () => {
    const state = await fold([
      ...stack,
      prompt("and the cookie one?", 20),
      says("m4", text("Looking at it."), 21),
      says("m4", call("t5", "Read", { file_path: "/p/src/auth/cookie.ts" }), 22),
      result("t5", "code", 23),
      apiError(24, 10),
    ]);
    expect(conversationMarkdown(state, "stack")).toBe(
      `${[
        "# stack",
        "## You",
        "go through the security changes in the stack and write it up",
        "## Claude",
        `outline up: ${LINK} - now orienting on the stack and recent main`,
        "the stack section is in. now checking each security change",
        "Two need a change before they merge.",
        "## You",
        "and the cookie one?",
        "## Claude",
        "Looking at it.",
        "_Connection dropped (ECONNRESET) · retry 10 of 10_",
      ].join("\n\n")}\n`,
    );
  });
});
