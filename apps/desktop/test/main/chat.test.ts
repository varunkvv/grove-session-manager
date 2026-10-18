// grove chat's host against a fake claude that plays back the spike's recordings
// (test/fixtures/chat): the real sdk, the real stream-json protocol, no model
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentView, findAgentFile, readAgentTimeline } from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import { agentsOf } from "../../src/main/ipc.ts";
import {
  ATTACH,
  ChatHost,
  hostEnv,
  modesFor,
  parseAnswer,
  parseAttachments,
  REAP_MS,
  retryLine,
} from "../../src/main/services/chat.ts";
import type { ChatAsk, ChatStatus } from "../../src/shared/ipc.ts";

const REPLAY = path.join(import.meta.dirname, "../fixtures/chat/replay.cjs");
const SESSION = "11111111-2222-4333-8444-555555555555";
// the recorded prompts: the fake plays the turn whose prompt it gets
const HELLO = "Reply with exactly: hello from the spike";
const QUESTION =
  "Use the AskUserQuestion tool once to ask me which colour I prefer, with exactly two options: Red and Blue. Then reply with one line saying which I picked. Do not use any other tool.";
const PLAN =
  "Plan how to create notes.txt containing the word hi in the current folder. Keep the plan to three short steps, then present it with ExitPlanMode. Do not read or write any files.";
const WRITE = "Create a file named perm.txt containing the letter x, using the Write tool.";
const COUNT = "Count from 1 to 400, one number per line, nothing else.";
const AFTER = "Reply with exactly: after the interrupt";
/** recordings/c-agents: two background agents (one stopped from the host), then a Bash */
const AGENTS = [
  "Do exactly these three things, in this order, with no other tools:",
  "1. Use the Agent tool with subagent_type general-purpose, run_in_background true, description 'slow lister', and prompt 'Run the Bash command `sleep 4 && ls` and reply with its output.'",
  "2. Use the Agent tool with subagent_type general-purpose, run_in_background true, description 'long sleeper', and prompt 'Run the Bash command `sleep 60` and then reply done.'",
  "3. Run the Bash command `sleep 5 && echo main-done` yourself.",
  "Then reply with one short line.",
].join("\n");

/** recordings/d-workflowstop: a Workflow of six agents in a row, stopped while the second runs */
const WORKFLOW = (
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, "../fixtures/chat/workflow.jsonl"), "utf8")
      .split("\n")
      .find((l) => l.includes('"dir": "in"') && l.includes('"type": "user"')) ?? "{}",
  ) as { msg: { message: { content: Array<{ text: string }> } } }
).msg.message.content[0]?.text as string;

/** recordings/d-questions: three questions in one AskUserQuestion, the second multi-select */
const QUESTIONS = [
  "Use the AskUserQuestion tool exactly once, with exactly these three questions in this order:",
  "1. header 'Language', question 'Which language should the script use?', single select, options Python and Go, each option with a preview showing a two-line hello world in that language.",
  "2. header 'Checks', question 'Which checks should run?', multiSelect true, options Lint, Types and Tests.",
  "3. header 'Output', question 'Where should the results go?', single select, options Stdout and File.",
  "Then reply with exactly three lines, one per question, each 'header: what I picked'. Do not use any other tool.",
].join("\n");

interface Setup {
  host: ChatHost;
  where: { cwd: string; dirs: string[] };
  /** what the fake got: argv and env once, then every stdin message */
  log: () => Array<Record<string, unknown>>;
  transcript: string;
  window: {
    sent: Array<[string, unknown]>;
    isDestroyed(): boolean;
    send(c: string, p: unknown): void;
  };
  now: { at: number };
}

const hosts: ChatHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
});

function setup(
  delayMs = 2,
  failFirst = false,
  recordings?: string,
  onReset?: (from: string, to: string) => void,
): Setup {
  // real: /var/folders is /private/var/folders, and claude reports its cwd resolved
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-chat-")));
  const bin = path.join(dir, "fake-claude");
  // no extension: the sdk runs it directly, as it does the native binary
  writeFileSync(bin, `#!${process.execPath}\nrequire(${JSON.stringify(REPLAY)});\n`);
  chmodSync(bin, 0o755);
  const cwd = path.join(dir, "proj");
  const extra = path.join(dir, "notes");
  mkdirSync(cwd);
  mkdirSync(extra);
  const logFile = path.join(dir, "fake.log");
  const claudeDir = path.join(dir, "claude");
  mkdirSync(claudeDir);
  // the person asked to see thinking summaries, as varun's own settings do
  writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ showThinkingSummaries: true }),
  );
  const now = { at: Date.now() };
  const host = new ChatHost({
    claudeBin: async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error("no claude here");
      }
      return bin;
    },
    env: async () => ({
      PATH: process.env.PATH,
      HOME: os.homedir(),
      CLAUDE_CONFIG_DIR: claudeDir,
      GROVE_FAKE_CHAT_LOG: logFile,
      GROVE_FAKE_CHAT_DELAY_MS: String(delayMs),
      ...(recordings ? { GROVE_FAKE_CHAT_RECORDINGS: recordings } : {}),
      // what a grove started from a claude code session would pass on
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
    }),
    now: () => now.at,
    claudeSettings: path.join(claudeDir, "settings.json"),
    ...(onReset ? { onReset } : {}),
  });
  hosts.push(host);
  const sent: Array<[string, unknown]> = [];
  return {
    host,
    where: { cwd, dirs: [extra] },
    log: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    transcript: path.join(
      claudeDir,
      "projects",
      cwd.replace(/[^a-zA-Z0-9]/g, "-"),
      `${SESSION}.jsonl`,
    ),
    window: { sent, isDestroyed: () => false, send: (c, p) => sent.push([c, p]) },
    now,
  };
}

async function until<T>(get: () => T | undefined | false, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ask = <K extends ChatAsk["kind"]>(s: Setup, kind: K) =>
  until(
    () =>
      s.host.status(SESSION).asks.find((a): a is Extract<ChatAsk, { kind: K }> => a.kind === kind),
    `a ${kind} card`,
  );

/** what the host answered claude's permission requests with */
const answers = (s: Setup) =>
  s.log().flatMap((l) => {
    const m = l.in as
      | { type?: string; response?: { response?: Record<string, unknown> } }
      | undefined;
    return m?.type === "control_response" ? [m.response?.response ?? {}] : [];
  });

const turnEnded = (s: Setup) =>
  until(() => !s.host.running(SESSION) && s.host.status(SESSION).rev > 0, "the turn to end");

/** the streamed text as a window rebuilds it from its pushes, after each one */
function windowTexts(s: Setup): string[] {
  let text = "";
  const seen: string[] = [];
  for (const [channel, p] of s.window.sent) {
    if (channel !== "grove:chat:text") continue;
    const { at, text: add } = p as { at: number; text: string };
    text = text.slice(0, at) + add;
    seen.push(text);
  }
  return seen;
}

const windowText = (s: Setup): string => windowTexts(s).at(-1) ?? "";

describe("grove chat's host", () => {
  it("starts claude on the session in its folders, with the settings deciding the mode", async () => {
    const s = setup();
    await s.host.warm(SESSION, s.where);
    const status = s.host.status(SESSION);
    expect(status.live).toBe(true);
    expect(s.host.hosts(SESSION)).toBe(true);
    // the recorded session started in bypass from the user's settings: the pill offers it back
    expect(status.mode).toBe("bypassPermissions");
    expect(status.modes).toContain("bypassPermissions");
    expect(status.models.map((m) => m.value)).toContain("opus");
    const { argv, cwd, env } = s.log()[0] as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };
    expect(cwd).toBe(s.where.cwd);
    expect(argv).toEqual(
      expect.arrayContaining([`--resume=${SESSION}`, "--include-partial-messages"]),
    );
    expect(argv.join(" ")).toContain("--setting-sources=user,project,local");
    expect(argv.join(" ")).toContain(s.where.dirs[0]);
    // no mode is passed: the person's own settings pick it
    expect(argv.join(" ")).not.toContain("--permission-mode");
    // the parent's claude code session is not passed on: the sdk names itself. checkpoints on,
    // as vs code has them
    expect(env).toEqual({ entrypoint: "sdk-ts", checkpointing: "true" });
    // vs code's thinking: a budget, and the summary text because the settings ask for it
    expect(argv).toEqual(
      expect.arrayContaining(["--max-thinking-tokens=31999", "--thinking-display=summarized"]),
    );
  });

  it("says how full the conversation is from claude's own count, at start and after each turn", async () => {
    const s = setup();
    await s.host.warm(SESSION, s.where);
    expect(s.host.status(SESSION).context).toEqual({ used: 31708, limit: 967000 });
    await s.host.send(SESSION, s.where, HELLO);
    await turnEnded(s);
    await until(() => s.host.status(SESSION).context, "the count after the turn");
    const asked = s
      .log()
      .filter(
        (l) =>
          (l.in as { request?: { subtype?: string; detail?: string } })?.request?.subtype ===
          "get_context_usage",
      )
      .map((l) => (l.in as { request: { detail?: string } }).request.detail);
    // the summary: no token-count call
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(new Set(asked)).toEqual(new Set(["summary"]));
  });

  it("starts claude with claude code's own system prompt, not an empty one", async () => {
    const s = setup();
    await s.host.warm(SESSION, s.where);
    const init = s
      .log()
      .map((l) => l.in as { request?: Record<string, unknown> } | undefined)
      .find((m) => m?.request?.subtype === "initialize")?.request;
    expect(init).toBeDefined();
    // the preset sends no prompt of its own: claude code uses its own. left out, the sdk sent [""]
    expect(init).not.toHaveProperty("systemPrompt");
    // a stop ends the turn and leaves background agents running
    expect(init?.perTaskStopAffordance).toBe(true);
  });

  it("effort and ultracode: the model's own levels, sent together, and read back after each", async () => {
    const s = setup();
    await s.host.warm(SESSION, s.where);
    // what claude applies, read once it is up
    expect(s.host.status(SESSION)).toMatchObject({ effort: "medium", ultracodeAvailable: true });
    const haiku = s.host.status(SESSION).models.find((m) => m.value === "haiku");
    expect(haiku?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    await s.host.setModel(SESSION, "haiku");
    await s.host.setEffort(SESSION, s.where, "high");
    expect(s.host.status(SESSION).effort).toBe("high");
    await s.host.setUltracode(SESSION, s.where, true);
    expect(s.host.status(SESSION).ultracode).toBe(true);
    // an effort change keeps ultracode on: both keys go together
    await s.host.setEffort(SESSION, s.where, "low");
    expect(s.host.status(SESSION)).toMatchObject({ effort: "low", ultracode: true });
    const applies = s
      .log()
      .map((l) => (l.in as { request?: { subtype?: string; settings?: unknown } })?.request)
      .filter((r) => r?.subtype === "apply_flag_settings")
      .map((r) => r?.settings);
    expect(applies).toEqual([
      { effortLevel: "high" },
      { ultracode: true },
      { effortLevel: "low", ultracode: true },
    ]);
    // opus and default both run claude-opus-5-5: the one picked stays the one shown
    await s.host.setModel(SESSION, "opus");
    expect(s.host.status(SESSION).model).toBe("opus");
    await s.host.setModel(SESSION, "haiku");
    // a level the model does not list never goes to claude
    await expect(s.host.setEffort(SESSION, s.where, "ludicrous")).rejects.toThrow("not an effort");
    // a model with no effort setting and no ultracode: both go, and a switch on is refused
    await s.host.setModel(SESSION, "claude-haiku-4-5-20251001");
    expect(s.host.status(SESSION)).toMatchObject({ ultracode: false, ultracodeAvailable: false });
    await expect(s.host.setUltracode(SESSION, s.where, true)).rejects.toThrow("does not take");
  });

  it("asks for no thinking text when the person's settings do not", async () => {
    const s = setup();
    const settings = path.join(path.dirname(path.dirname(s.transcript)), "..", "settings.json");
    writeFileSync(settings, JSON.stringify({ showThinkingSummaries: false }));
    await s.host.warm(SESSION, s.where);
    const { argv } = s.log()[0] as { argv: string[] };
    expect(argv).toContain("--max-thinking-tokens=31999");
    expect(argv.join(" ")).not.toContain("--thinking-display");
  });

  it("streams a turn to its window and writes it where grove reads transcripts", async () => {
    // the recorded gap between the two deltas is 208ms. kept over the window's 50ms
    const s = setup(150);
    s.host.attach(SESSION, s.window);
    await s.host.send(SESSION, s.where, HELLO);
    expect(s.host.running(SESSION)).toBe(true);
    await turnEnded(s);
    // the answer streamed, then made way for the transcript once it was whole
    const seen = windowTexts(s);
    expect(seen.some((t) => t.length > 0 && "hello from the spike".startsWith(t))).toBe(true);
    expect(windowText(s)).toBe("");
    expect(s.host.text(SESSION)).toBe("");
    const lines = readFileSync(s.transcript, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["user", "assistant"]);
    expect(lines[1].message.content[0].text).toBe("hello from the spike");
    const last = s.window.sent.filter(([c]) => c === "grove:chat:status").at(-1)?.[1] as ChatStatus;
    expect(last.running).toBe(false);
  });

  it("holds a question until the person answers it, and hands Claude Code the answer", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, QUESTION);
    const q = await ask(s, "question");
    expect(q.questions).toEqual([
      {
        question: "Which colour do you prefer?",
        header: "Colour",
        multiSelect: false,
        options: [
          { label: "Red", description: "Pick red" },
          { label: "Blue", description: "Pick blue" },
        ],
      },
    ]);
    expect(s.host.running(SESSION)).toBe(true);
    s.host.answer(SESSION, q.id, {
      kind: "question",
      answers: { "Which colour do you prefer?": "Blue" },
    });
    await turnEnded(s);
    expect(s.host.status(SESSION).asks).toEqual([]);
    const a = answers(s)[0] ?? {};
    expect(a.behavior).toBe("allow");
    expect((a.updatedInput as { answers: unknown }).answers).toEqual({
      "Which colour do you prefer?": "Blue",
    });
    // an answer twice is refused
    expect(() => s.host.answer(SESSION, q.id, { kind: "question", answers: {} })).toThrow(
      /already been answered/,
    );
  });

  it("several questions in one ask: each answered, a pick's preview sent with it", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, QUESTIONS);
    const card = await ask(s, "question");
    expect(card.questions.map((q) => [q.header, q.multiSelect, q.options.length])).toEqual([
      ["Language", false, 2],
      ["Checks", true, 3],
      ["Output", false, 2],
    ]);
    expect(card.questions[0]?.options[1]?.preview).toContain("fmt.Println");
    s.host.answer(SESSION, card.id, {
      kind: "question",
      answers: {
        "Which language should the script use?": "Go",
        "Which checks should run?": "Lint, Tests",
        "Where should the results go?": "a slack message",
      },
    });
    await turnEnded(s);
    const sent = answers(s).find((a) => (a.updatedInput as { answers?: unknown })?.answers);
    expect(sent?.updatedInput).toMatchObject({
      answers: { "Which checks should run?": "Lint, Tests" },
      annotations: {
        "Which language should the script use?": {
          preview: expect.stringContaining("fmt.Println"),
        },
      },
    });
    // the preview format claude was told to write in
    const init = s
      .log()
      .find((l) => (l.in as { request?: { subtype?: string } })?.request?.subtype === "initialize");
    expect(JSON.stringify(init)).not.toContain('"html"');
  });

  it("a plan: keep planning with a word, then approve", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, PLAN);
    const first = await ask(s, "plan");
    expect(first.plan).toContain("notes.txt");
    s.host.answer(SESSION, first.id, { kind: "plan", approve: false, message: "add a check" });
    const second = await until(
      () => s.host.status(SESSION).asks.find((a) => a.kind === "plan" && a.id !== first.id),
      "the plan again",
    );
    s.host.answer(SESSION, second.id, { kind: "plan", approve: true });
    await turnEnded(s);
    const [no, yes] = answers(s);
    expect(no).toMatchObject({ behavior: "deny", message: "add a check" });
    expect(yes?.behavior).toBe("allow");
  });

  it("a permission: the tool and what it acts on, and a no with the person's words", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, WRITE);
    const p = await ask(s, "permission");
    expect(p.tool).toBe("Write");
    expect(p.detail).toContain("perm.txt");
    // the live line: the tool it is in, the file it acts on, since when, inside the turn's clock
    const { tool, since } = s.host.status(SESSION);
    // (the recording's own folder, so it is not shortened to the test's)
    expect(tool).toMatchObject({ name: "Write", target: expect.stringMatching(/\/perm\.txt$/) });
    expect(since).toBeLessThanOrEqual(tool?.since ?? 0);
    // a kind that is not the card's is refused
    expect(() => s.host.answer(SESSION, p.id, { kind: "plan", approve: true })).toThrow();
    s.host.answer(SESSION, p.id, { kind: "permission", allow: "no", message: "not now" });
    await turnEnded(s);
    expect(answers(s)[0]).toMatchObject({ behavior: "deny", message: "not now" });
  });

  it("outlives its window: a turn runs on with nobody looking, and an interrupt ends it", async () => {
    const s = setup();
    s.host.attach(SESSION, s.window);
    await s.host.send(SESSION, s.where, COUNT);
    await until(() => s.host.text(SESSION).includes("3\n4"), "the count to stream");
    s.host.detach(SESSION, s.window);
    const seen = s.window.sent.length;
    // the recording waits for an interrupt here: the turn is still going
    await new Promise((r) => setTimeout(r, 100));
    expect(s.host.running(SESSION)).toBe(true);
    expect(s.window.sent.length).toBe(seen);
    // a window coming back catches up from the snapshot
    expect(s.host.text(SESSION)).toContain("1\n2");
    s.host.attach(SESSION, s.window);
    await s.host.interrupt(SESSION);
    await turnEnded(s);
    expect(s.host.hosts(SESSION)).toBe(true);
    // the session takes the next prompt as usual
    const rev = s.host.status(SESSION).rev;
    await s.host.send(SESSION, s.where, AFTER);
    await until(
      () => !s.host.running(SESSION) && s.host.status(SESSION).rev > rev + 1,
      "the next turn",
    );
    const said = readFileSync(s.transcript, "utf8");
    expect(said).toContain("[Request interrupted by user]");
    expect(said).toContain("after the interrupt");
  });

  it("queues what is sent while a turn runs", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, COUNT);
    await until(() => s.host.text(SESSION).length > 0, "the count");
    await s.host.send(SESSION, s.where, AFTER);
    expect(s.host.status(SESSION).queued).toEqual([AFTER]);
    await s.host.interrupt(SESSION);
    await until(() => s.host.status(SESSION).queued.length === 0, "the queue to clear");
  });

  it("a move to the editor waits for the turn, and letting go stops claude", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, COUNT);
    await until(() => s.host.text(SESSION).length > 0, "the count");
    let moved = false;
    s.host.afterTurn(SESSION, () => {
      moved = true;
    });
    expect(moved).toBe(false);
    await s.host.interrupt(SESSION);
    await until(() => moved, "the move");
    expect(s.host.busy()).toEqual([]);
    await s.host.release(SESSION);
    expect(s.host.hosts(SESSION)).toBe(false);
    expect(s.host.status(SESSION).live).toBe(false);
    // nothing running: it runs at once
    let now = false;
    s.host.afterTurn(SESSION, () => {
      now = true;
    });
    expect(now).toBe(true);
  });

  it("lets an idle session with no window go after ten minutes, never one mid-turn", async () => {
    const s = setup();
    await s.host.warm(SESSION, s.where);
    s.host.attach(SESSION, s.window);
    s.now.at += REAP_MS + 1;
    s.host.reap();
    // a window is open on it
    expect(s.host.hosts(SESSION)).toBe(true);
    s.host.detach(SESSION, s.window);
    await s.host.send(SESSION, s.where, COUNT);
    s.now.at += REAP_MS + 1;
    s.host.reap();
    // mid-turn
    expect(s.host.hosts(SESSION)).toBe(true);
    await until(() => s.host.text(SESSION).length > 0, "the count");
    await s.host.interrupt(SESSION);
    await turnEnded(s);
    s.now.at += REAP_MS + 1;
    s.host.reap();
    await until(() => !s.host.hosts(SESSION), "claude to be let go");
  });

  it("follows its subagents from the task frames: started, their progress, how each ended", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, AGENTS);
    const started = await until(
      () =>
        s.host.status(SESSION).agents?.length === 2 ? s.host.status(SESSION).agents : undefined,
      "both agents",
    );
    expect(started?.map((a) => a.description)).toEqual(["slow lister", "long sleeper"]);
    expect(started?.[0]).toMatchObject({ agentType: "general-purpose", background: true });
    const ended = await until(
      () => {
        const a = s.host.status(SESSION).agents ?? [];
        return a.every((x) => x.state !== "running") ? a : undefined;
      },
      "both agents to end",
      20_000,
    );
    // the long sleeper was stopped from the probe's host, the lister finished
    expect(Object.fromEntries(ended.map((a) => [a.description, a.state]))).toEqual({
      "slow lister": "done",
      "long sleeper": "stopped",
    });
    expect(ended.find((a) => a.description === "slow lister")?.step).toContain("Running");
    await expect(s.host.stopAgent(SESSION, ended[0]?.id ?? "")).rejects.toThrow("not running");
    // claude code wrote each one's own transcript: it reads as a turn
    const dir = path.join(path.dirname(s.transcript), SESSION);
    const file = await findAgentFile(path.join(dir, "..", `${SESSION}.jsonl`), "a4b003a351ce28240");
    expect(file).toBeTruthy();
    const view = agentView(await readAgentTimeline(file as string));
    expect(view.prompt?.text).toContain("sleep 4 && ls");
    expect(view.steps?.find((st) => st.kind === "tool")).toMatchObject({ name: "Bash" });
    expect(view.text).toContain("produced no output");
    // an id that is no agent id never reaches the folder
    expect(await findAgentFile(s.transcript, "../../etc/passwd")).toBeNull();
  });

  it("follows a workflow as one row, its agents under it from its progress frames", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, WORKFLOW);
    const started = await until(() => {
      const a = s.host.status(SESSION).agents ?? [];
      return a.some((x) => x.workflow) ? a : undefined;
    }, "the workflow's first agent");
    expect(started.find((a) => a.kind === "workflow")).toMatchObject({
      id: "whjgl3wqb",
      description: "six agents one after another",
      toolUseId: "toolu_01BfP2GWPhbkYyPuuy17PBPv",
      state: "running",
    });
    expect(started.find((a) => a.workflow)).toMatchObject({
      description: "step 1",
      workflow: "whjgl3wqb",
      state: "running",
    });
    // a workflow's agent has no task of its own to stop
    const first = started.find((a) => a.workflow)?.id ?? "";
    await expect(s.host.stopAgent(SESSION, first)).rejects.toThrow("workflow");
    // killed while step 2 ran: no progress frame says so, the workflow's end does
    const ended = await until(() => {
      const a = s.host.status(SESSION).agents ?? [];
      return a.find((x) => x.kind === "workflow")?.state === "stopped" ? a : undefined;
    }, "the workflow to stop");
    expect(ended.filter((a) => a.workflow).map((a) => [a.description, a.state, a.step])).toEqual([
      ["step 1", "done", "ok 1"],
      ["step 2", "stopped", undefined],
    ]);
  });

  it("puts a workflow's agents under its row, live or from the run's own file", () => {
    const scanned = (id: string, workflow: string) => ({
      id,
      agentType: "workflow-subagent",
      description: `agent ${id}`,
      workflow,
      startedAt: 10,
      lastActivityAt: 20,
      state: "done" as const,
    });
    // live: claude named the run's agents, so the folder is that row's
    const live = [
      {
        id: "w1",
        kind: "workflow" as const,
        description: "six steps",
        state: "running" as const,
        since: 5,
      },
      { id: "a1", description: "step 1", workflow: "w1", state: "done" as const, since: 6 },
    ];
    const rows = agentsOf(
      live,
      [scanned("a1", "wf_1"), scanned("a2", "wf_1"), scanned("b1", "wf_2")],
      {
        wf_2: { summary: "an older run", status: "completed", startTime: 1, durationMs: 9 },
      },
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.kind ?? r.workflow]))).toEqual({
      w1: "workflow",
      a1: "w1",
      a2: "w1",
      wf_2: "workflow",
      b1: "wf_2",
    });
    expect(rows.find((r) => r.id === "wf_2")).toMatchObject({
      description: "an older run",
      state: "done",
      ended: 10,
    });
  });

  it("a subagent's permission ask names the agent", async () => {
    // the permission recording, with the ask coming from inside an agent claude said it started
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-chat-rec-"));
    const fixtures = path.join(import.meta.dirname, "../fixtures/chat");
    writeFileSync(path.join(dir, "turn.jsonl"), readFileSync(path.join(fixtures, "turn.jsonl")));
    const lines = readFileSync(path.join(fixtures, "permission.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        const o = JSON.parse(l);
        if (o.msg?.request?.subtype !== "can_use_tool") return [l];
        o.msg.request.agent_id = "a-writer";
        const started = {
          t: o.t,
          dir: "out",
          msg: {
            type: "system",
            subtype: "task_started",
            task_id: "a-writer",
            description: "file writer",
            task_type: "local_agent",
            session_id: o.msg.request.session_id,
          },
        };
        return [JSON.stringify(started), JSON.stringify(o)];
      });
    writeFileSync(path.join(dir, "permission.jsonl"), `${lines.join("\n")}\n`);
    const s = setup(2, false, dir);
    await s.host.send(SESSION, s.where, WRITE);
    const p = await ask(s, "permission");
    expect(p.agent).toBe("file writer");
    s.host.answer(SESSION, p.id, { kind: "permission", allow: "once" });
    await turnEnded(s);
  });

  it("keeps what claude says along the way that no transcript has, until the next send", async () => {
    // the hello turn, with the frames a turn can carry before its answer
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-chat-rec-"));
    const fixtures = path.join(import.meta.dirname, "../fixtures/chat");
    const extra = [
      { type: "system", subtype: "status", status: "compacting" },
      {
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 2000,
        error_status: 529,
        error: "overloaded",
      },
      { type: "system", subtype: "local_command_output", content: "Total cost: $0.01" },
      { type: "system", subtype: "informational", level: "info", content: "only for a transcript" },
      { type: "system", subtype: "informational", level: "warning", content: "Stop hook said no" },
      {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Write",
        tool_use_id: "t1",
        decision_reason_type: "mode",
        message:
          "Permission to use Write has been denied because Claude Code is running in don't ask mode. IMPORTANT: more words.",
      },
    ];
    const lines = readFileSync(path.join(fixtures, "turn.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        const o = JSON.parse(l);
        if (o.msg?.type !== "system" || o.msg.subtype !== "init") return [l];
        return [l, ...extra.map((msg) => JSON.stringify({ t: o.t, dir: "out", msg }))];
      });
    writeFileSync(path.join(dir, "turn.jsonl"), `${lines.join("\n")}\n`);
    writeFileSync(
      path.join(dir, "interrupt.jsonl"),
      readFileSync(path.join(fixtures, "interrupt.jsonl")),
    );
    const s = setup(2, false, dir);
    s.host.attach(SESSION, s.window);
    await s.host.send(SESSION, s.where, HELLO);
    await turnEnded(s);
    expect(s.host.status(SESSION).notes).toEqual([
      { kind: "output", text: "Total cost: $0.01" },
      { kind: "info", text: "Stop hook said no" },
      {
        kind: "denied",
        text: "Write was turned down. Permission to use Write has been denied because Claude Code is running in don't ask mode.",
      },
    ]);
    // the window heard it compacting, then retrying, then nothing once the answer came
    const activity = s.window.sent
      .filter(([c]) => c === "grove:chat:status")
      .map(([, p]) => (p as ChatStatus).activity);
    expect(activity).toContain("Compacting the conversation");
    expect(activity).toContain("Retrying in 2s · overloaded (1 of 10)");
    expect(s.host.status(SESSION).activity).toBeUndefined();
    // the next turn starts clean
    await s.host.send(SESSION, s.where, COUNT);
    await until(() => s.host.text(SESSION).length > 0, "the count");
    expect(s.host.status(SESSION).notes).toEqual([]);
    await s.host.interrupt(SESSION);
  });

  it("/clear moves the same claude to a new session id, and its windows with it", async () => {
    const moved: Array<[string, string]> = [];
    const s = setup(2, false, undefined, (from, to) => moved.push([from, to]));
    s.host.attach(SESSION, s.window);
    await s.host.send(SESSION, s.where, "/clear");
    const [from, to] = await until(() => moved[0], "the reset");
    expect(from).toBe(SESSION);
    expect(to).toMatch(/^[0-9a-f-]{36}$/);
    expect(to).not.toBe(SESSION);
    expect(s.host.hosts(SESSION)).toBe(false);
    expect(s.host.hosts(to)).toBe(true);
    // the window is the new one's now: it hears of it
    const seen = s.window.sent.length;
    await s.host.setMode(to, s.where, "plan");
    expect(s.window.sent.length).toBeGreaterThan(seen);
  });

  it("puts what claude says of its agents over what their transcripts say", () => {
    const live = [{ id: "a1", description: "lister", state: "running" as const, since: 100 }];
    const scanned = [
      {
        id: "a1",
        agentType: "general-purpose",
        startedAt: 90,
        lastActivityAt: 200,
        state: "done" as const,
        lastTool: "Bash",
      },
      {
        id: "a2",
        agentType: "Explore",
        asked: "find the retry helper",
        startedAt: 50,
        lastActivityAt: 80,
        state: "done" as const,
      },
    ];
    expect(agentsOf(live, scanned)).toEqual([
      { id: "a1", description: "lister", state: "running", since: 100, step: "Bash" },
      {
        id: "a2",
        description: "find the retry helper",
        agentType: "Explore",
        state: "done",
        since: 50,
        ended: 80,
      },
    ]);
  });

  it("says a retry the way the live line has room for", () => {
    const frame = { retry_delay_ms: 7600, attempt: 2, max_retries: 10, error_status: 529 };
    expect(retryLine({ ...frame, error: "overloaded" })).toBe(
      "Retrying in 8s · overloaded (2 of 10)",
    );
    expect(retryLine({ ...frame, error: "rate_limit" })).toContain("rate limited");
    expect(retryLine({ ...frame, error: "max_output_tokens" })).toContain("max output tokens");
    expect(retryLine({ ...frame, error_status: null, error: "unknown" })).toContain("no answer");
  });

  it("offers bypass only to a session that started in it", () => {
    expect(modesFor("acceptEdits")).toEqual(["default", "acceptEdits", "plan"]);
    expect(modesFor("bypassPermissions")).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    expect(modesFor(undefined)).toEqual(["default", "acceptEdits", "plan"]);
  });

  it("passes nothing of a parent claude code session on", () => {
    expect(
      hostEnv({
        PATH: "/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "x",
        CLAUDE_CODE_USE_BEDROCK: "1",
      }),
    ).toEqual({ PATH: "/bin", CLAUDE_CODE_USE_BEDROCK: "1" });
  });

  it("takes from a page only the answers it knows, and nothing riding along", () => {
    expect(parseAnswer({ kind: "question", answers: { "Which?": "Blue" }, extra: "x" })).toEqual({
      kind: "question",
      answers: { "Which?": "Blue" },
    });
    expect(parseAnswer({ kind: "plan", approve: false, message: "more" })).toEqual({
      kind: "plan",
      approve: false,
      message: "more",
    });
    expect(parseAnswer({ kind: "permission", allow: "always" })).toEqual({
      kind: "permission",
      allow: "always",
    });
    for (const bad of [
      null,
      "yes",
      { kind: "question", answers: ["Blue"] },
      { kind: "question", answers: { q: 4 } },
      { kind: "question", answers: { q: "x".repeat(200_001) } },
      { kind: "plan", approve: "yes" },
      { kind: "permission", allow: "forever" },
      { kind: "permission", allow: "once", message: 4 },
      { kind: "bash", command: "rm -rf /" },
    ]) {
      expect(() => parseAnswer(bad), JSON.stringify(bad)?.slice(0, 60)).toThrow("not an answer");
    }
  });

  it("takes from a page only files grove sends, within its caps, and nothing riding along", () => {
    const png = { kind: "image", mediaType: "image/png", data: "iVBORw0KGgo=" };
    const pdf = { kind: "pdf", name: "spec.pdf", data: "JVBERi0=" };
    const txt = { kind: "text", name: "data.csv", text: "a,b\n1,2" };
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments([png, { ...pdf, extra: 1 }, txt])).toEqual([png, pdf, txt]);
    for (const bad of [
      "png",
      [null],
      [{ ...png, mediaType: "image/svg+xml" }],
      [{ ...png, data: "not base64!" }],
      [{ ...png, data: "A".repeat(ATTACH.image + 4) }],
      [{ ...pdf, data: "not base64!" }],
      [{ ...pdf, name: "" }],
      [{ ...pdf, name: 4 }],
      [{ ...pdf, data: "A".repeat(ATTACH.pdf + 4) }],
      [{ ...txt, text: "x".repeat(ATTACH.text + 1) }],
      [{ kind: "docx", name: "a.docx", data: "AAAA" }],
      Array.from({ length: 11 }, () => png),
    ]) {
      expect(() => parseAttachments(bad), JSON.stringify(bad)?.slice(0, 60)).toThrow(
        "not a file Claude can take",
      );
    }
    // each under its cap, too much together: pdfs and text go again with every turn
    const big = { ...pdf, data: "A".repeat(ATTACH.pdf - 100) };
    expect(() => parseAttachments([big, big])).toThrow("too big to send together");
  });

  it("sends a pdf and a text file as documents, before the words, as vs code does", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, HELLO, [
      { kind: "pdf", name: "spec.pdf", data: "JVBERi0=" },
      { kind: "text", name: "data.csv", text: "a,b" },
    ]);
    await turnEnded(s);
    const sent = s
      .log()
      .map((l) => l.in as { type?: string; message?: { content?: unknown[] } })
      .find((m) => m?.type === "user");
    expect(sent?.message?.content).toEqual([
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
        title: "spec.pdf",
      },
      {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "a,b" },
        title: "data.csv",
      },
      { type: "text", text: HELLO },
    ]);
  });

  it("a send claude could not start for is not sent again with the next one", async () => {
    const s = setup(2, true);
    await expect(s.host.send(SESSION, s.where, HELLO)).rejects.toThrow("no claude here");
    expect(s.host.running(SESSION)).toBe(false);
    await s.host.send(SESSION, s.where, HELLO);
    await turnEnded(s);
    const prompts = s.log().filter((l) => (l.in as { type?: string } | undefined)?.type === "user");
    expect(prompts).toHaveLength(1);
  });

  it("letting go mid-turn stops the turn the way Esc does first", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, COUNT);
    await until(() => s.host.text(SESSION).length > 0, "the count");
    await s.host.release(SESSION);
    expect(s.host.hosts(SESSION)).toBe(false);
    const asked = s.log().map((l) => l.in as { request?: { subtype?: string } } | undefined);
    expect(asked.some((m) => m?.request?.subtype === "interrupt")).toBe(true);
    expect(readFileSync(s.transcript, "utf8")).toContain("[Request interrupted by user]");
  });
});
