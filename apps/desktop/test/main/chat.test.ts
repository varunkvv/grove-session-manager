// grove chat's host against a fake claude that plays back the spike's recordings
// (test/fixtures/chat): the real sdk, the real stream-json protocol, no model
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentView, findAgentFile, readAgentTimeline } from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import { agentsOf } from "../../src/main/ipc.ts";
import { KEEP_EVERY_MS } from "../../src/main/services/cacheKeeper.ts";
import {
  ATTACH,
  ChatHost,
  type ChatHostOptions,
  CLASSIFIER_ERROR_FILE,
  CLEARING,
  CLEARING_REFUSED,
  classifierError,
  clearingEnv,
  dialogOf,
  hostEnv,
  modesFor,
  parseAnswer,
  parseAttachments,
  REAP_MS,
  refusedClearing,
  refusedClearingCheck,
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

/** recordings/d-background: a foreground Bash claude makes a task of, then sent to the background */
const BACKGROUND =
  "Run the Bash command `sleep 10 && echo bg-done` in the foreground (do not set run_in_background), then reply with one short line.";

interface Setup {
  host: ChatHost;
  where: { cwd: string; dirs: string[] };
  /** grove's uploads: a folder per session in it */
  uploads: string;
  /** what the fake got: argv and env once, then every stdin message */
  log: () => Array<Record<string, unknown>>;
  transcript: string;
  /** the fake's CLAUDE_CONFIG_DIR */
  claudeDir: string;
  window: {
    sent: Array<[string, unknown]>;
    isDestroyed(): boolean;
    send(c: string, p: unknown): void;
  };
  now: { at: number };
  /** every letGo the host made: the ids it was about to close */
  letGo: string[][];
  /** every time the host said a card no hook announces opened (what it asks) or the last went (null) */
  cards: Array<[string, string | null]>;
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
  /** more for the fake: GROVE_FAKE_CHAT_FOLD and the like */
  fake: Record<string, string> = {},
  more: Partial<ChatHostOptions> = {},
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
  const letGo: string[][] = [];
  const cards: Array<[string, string | null]> = [];
  const uploads = path.join(dir, "Application Support", "uploads");
  const host = new ChatHost({
    uploads,
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
      ...fake,
      // what a grove started from a claude code session would pass on
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
    }),
    now: () => now.at,
    claudeSettings: path.join(claudeDir, "settings.json"),
    projectsDir: path.join(claudeDir, "projects"),
    ...(onReset ? { onReset } : {}),
    letGo: (ids) => letGo.push(ids),
    onCard: (id, asks) => cards.push([id, asks]),
    ...more,
  });
  hosts.push(host);
  const sent: Array<[string, unknown]> = [];
  return {
    host,
    where: { cwd, dirs: [extra] },
    uploads,
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
    claudeDir,
    window: { sent, isDestroyed: () => false, send: (c, p) => sent.push([c, p]) },
    now,
    letGo,
    cards,
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
    // grove's uploads too, made before claude is told of it: an attached file reads without asking
    expect(argv).toContain(`--add-dir=${s.uploads}`);
    expect(existsSync(s.uploads)).toBe(true);
    // no mode is passed: the person's own settings pick it
    expect(argv.join(" ")).not.toContain("--permission-mode");
    // the parent's claude code session is not passed on: the sdk names itself. checkpoints on,
    // as vs code has them. the api clears old reads, with no thinking edit: auto mode's
    // classifier gets the same body with thinking off, and the api refuses it there
    expect(env).toEqual({
      entrypoint: "sdk-ts",
      checkpointing: "true",
      extraBody: expect.any(String),
    });
    expect(JSON.parse(env.extraBody ?? "")).toEqual({
      context_management: {
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: 150_000 },
            keep: { type: "tool_uses", value: 20 },
            clear_at_least: { type: "input_tokens", value: 20_000 },
            clear_tool_inputs: false,
          },
        ],
      },
    });
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
    const asked = () =>
      s
        .log()
        .filter(
          (l) =>
            (l.in as { request?: { subtype?: string; detail?: string } })?.request?.subtype ===
            "get_context_usage",
        )
        .map((l) => (l.in as { request: { detail?: string } }).request.detail);
    // asked again once the turn's result is in. the count from the start is already there, so
    // waiting on it would not wait for this one
    await until(() => asked().length >= 2, "the count after the turn");
    // the summary: no token-count call
    expect(new Set(asked())).toEqual(new Set(["summary"]));
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
    // a mode the session does not offer is refused, one it does rides on the allow
    expect(() =>
      s.host.answer(SESSION, second.id, { kind: "plan", approve: true, mode: "dontAsk" }),
    ).toThrow("not on offer");
    s.host.answer(SESSION, second.id, { kind: "plan", approve: true, mode: "acceptEdits" });
    await turnEnded(s);
    const [no, yes] = answers(s);
    expect(no).toMatchObject({ behavior: "deny", message: "add a check" });
    expect(yes).toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
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
    // a tool's ask raises claude's own PermissionRequest hook: the host says nothing of it
    expect(s.cards).toEqual([]);
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
    expect(s.host.status(SESSION).queued.map((q) => q.text)).toEqual([AFTER]);
    await s.host.interrupt(SESSION);
    await until(() => s.host.status(SESSION).queued.length === 0, "the queue to clear");
  });

  it("leaves the commands bound to a terminal out of what `/` offers", async () => {
    // the hello turn, its init saying one of the two commands is a terminal's
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-chat-rec-"));
    const fixtures = path.join(import.meta.dirname, "../fixtures/chat");
    const lines = readFileSync(path.join(fixtures, "turn.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const o = JSON.parse(l);
        if (o.msg?.type === "system" && o.msg.subtype === "init")
          o.msg.terminal_slash_commands = ["ask-matt"];
        return JSON.stringify(o);
      });
    writeFileSync(path.join(dir, "turn.jsonl"), `${lines.join("\n")}\n`);
    const s = setup(2, false, dir);
    await s.host.warm(SESSION, s.where);
    expect(s.host.commands(SESSION).map((c) => c.name)).toEqual(["amazon-bedrock", "ask-matt"]);
    await s.host.send(SESSION, s.where, HELLO);
    await turnEnded(s);
    expect(s.host.commands(SESSION).map((c) => c.name)).toEqual(["amazon-bedrock"]);
  });

  it("offers the background for a tool only once claude has it as a task, and sends it there", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, BACKGROUND);
    await until(() => s.host.status(SESSION).tool?.name === "Bash", "the Bash");
    // not a task yet: nothing to move
    expect(await s.host.background(SESSION)).toBe(false);
    await until(() => s.host.status(SESSION).tool?.bg, "the Bash as a task");
    expect(await s.host.background(SESSION)).toBe(true);
    const asked = await until(
      () =>
        s
          .log()
          .find(
            (l) =>
              (l.in as { request?: { subtype?: string } })?.request?.subtype === "background_tasks",
          ),
      "the background request",
    );
    expect((asked.in as { request: { tool_use_id?: string } }).request.tool_use_id).toMatch(
      /^toolu_/,
    );
    await turnEnded(s);
  });

  it("keeps a message claude folds into the turn, taken, until that turn ends", async () => {
    const s = setup(2, false, undefined, undefined, {
      GROVE_FAKE_CHAT_FOLD: "1",
      GROVE_FAKE_CHAT_TOOL_MS: "300",
    });
    await s.host.send(SESSION, s.where, AGENTS);
    await until(() => s.host.status(SESSION).tool, "a tool to run");
    await s.host.send(SESSION, s.where, "and the tests too");
    const [q] = s.host.status(SESSION).queued;
    expect(q).toMatchObject({ text: "and the tests too" });
    expect(q?.taken).toBeUndefined();
    const rev = s.host.status(SESSION).rev;
    // claude started on it: the row stays, as sent, and the window reads the transcript again
    await until(() => s.host.status(SESSION).queued[0]?.taken, "the message taken");
    expect(s.host.status(SESSION).rev).toBeGreaterThan(rev);
    // taken, it can't be taken back
    expect(await s.host.unqueue(SESSION, q?.id ?? "")).toBe(false);
    // the transcript knows it by the uuid it went with
    await until(
      () => readFileSync(s.transcript, "utf8").includes(`"source_uuid":"${q?.id}"`),
      "the fold in the transcript",
    );
    await turnEnded(s);
    expect(s.host.status(SESSION).queued).toEqual([]);
  });

  it("keeps a message still queued at a turn's end as taken: it runs next, and goes when that ends", async () => {
    const s = setup();
    s.host.attach(SESSION, s.window);
    await s.host.send(SESSION, s.where, COUNT);
    await until(() => s.host.text(SESSION).length > 0, "the count");
    await s.host.send(SESSION, s.where, AFTER);
    const id = s.host.status(SESSION).queued[0]?.id;
    await s.host.interrupt(SESSION);
    await until(
      () => readFileSync(s.transcript, "utf8").includes('after the interrupt"'),
      "the next turn's reply",
    );
    // the turn it ran as ended too: gone
    await until(() => s.host.status(SESSION).queued.length === 0, "the row to go");
    const statuses = s.window.sent
      .filter(([c]) => c === "grove:chat:status")
      .map(([, p]) => p as ChatStatus);
    // the first turn's end: the row taken, not gone
    const ended = statuses.find((st) => !st.running && st.queued.length > 0);
    expect(ended?.queued).toEqual([{ id, text: AFTER, said: AFTER, taken: true }]);
    expect(s.host.running(SESSION)).toBe(false);
    // it ran as that turn's prompt, with the uuid it went with
    expect(readFileSync(s.transcript, "utf8")).toContain(`"uuid":"${id}"`);
  });

  it("takes back a queued message by the uuid it went with, before claude gets to it", async () => {
    const s = setup();
    await s.host.send(SESSION, s.where, COUNT);
    await until(() => s.host.text(SESSION).length > 0, "the count");
    await s.host.send(SESSION, s.where, AFTER);
    const [q] = s.host.status(SESSION).queued;
    expect(q).toMatchObject({ text: AFTER, said: AFTER });
    // it went to claude with that uuid
    await until(
      () => s.log().find((l) => (l.in as { uuid?: string } | undefined)?.uuid === q?.id),
      "the message on claude's stdin with its uuid",
    );
    expect(await s.host.unqueue(SESSION, q?.id ?? "")).toBe(true);
    expect(s.host.status(SESSION).queued).toEqual([]);
    expect(await s.host.unqueue(SESSION, "not-one")).toBe(false);
    await s.host.interrupt(SESSION);
    await turnEnded(s);
    // the turn ended and nothing ran after it: the taken-back message never played
    await new Promise((r) => setTimeout(r, 300));
    expect(s.host.running(SESSION)).toBe(false);
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

  it("keeps an idle session's cache warm with a fork that resumes it and leaves no trace", async () => {
    let hours: number | undefined = 3;
    let changes = 0;
    const keeperForks = new Set<string>();
    const s = setup(
      2,
      false,
      undefined,
      undefined,
      {},
      {
        keepWarmHours: () => hours,
        keeperForks,
        onChange: () => changes++,
      },
    );
    await s.host.send(SESSION, s.where, COUNT);
    // the recorded count waits for its interrupt: that ends the turn as any end does
    await until(() => s.host.text(SESSION).length > 0, "the count");
    await s.host.interrupt(SESSION);
    await turnEnded(s);
    await until(() => s.host.status(SESSION).context, "the context");
    s.host.attach(SESSION, s.window);
    const spawns = () => s.log().filter((l) => Array.isArray(l.argv));
    // before the hour is nearly up: no fork
    s.now.at += KEEP_EVERY_MS - 1000;
    await s.host.keep();
    expect(spawns()).toHaveLength(1);
    // the window went, the session is reaped: it is still kept
    s.host.detach(SESSION, s.window);
    s.now.at += REAP_MS + 1;
    s.host.reap();
    await until(() => !s.host.hosts(SESSION), "the reap");
    const before = { status: s.host.status(SESSION), sent: s.window.sent.length, changes };
    // a fork's left-overs under its id, as claude leaves them: removed. the session's own stay
    const leftover = path.join(s.claudeDir, "file-history");
    mkdirSync(path.join(leftover, SESSION), { recursive: true });
    await s.host.keep();
    const [start, fork] = spawns() as Array<{ argv: string[]; cwd: string }>;
    if (!start || !fork) throw new Error("no fork");
    expect(fork.argv).toEqual(
      expect.arrayContaining([
        `--resume=${SESSION}`,
        "--fork-session",
        "--no-session-persistence",
        "--max-turns=1",
        "--include-partial-messages",
      ]),
    );
    // under an id grove gave it, known before its process is in claude's registry
    expect(keeperForks.size).toBe(1);
    expect(fork.argv).toContain(`--session-id=${[...keeperForks][0]}`);
    // the same prefix as the session's own claude: folders, settings, thinking
    expect(fork.cwd).toBe(start.cwd);
    for (const a of start.argv.filter((a) => /^--(add-dir|setting-sources|thinking)/.test(a)))
      expect(fork.argv).toContain(a);
    // no hook runs in it: grove's status and needs-you hooks among them. and it is on the effort
    // the last turn ran at (the recording's medium). a model claude chose itself is not named
    expect(fork.argv.join(" ")).toContain('"disableAllHooks":true');
    expect(fork.argv).toContain("--effort=medium");
    expect(fork.argv.join(" ")).not.toContain("--model");
    // nothing of it shows: no status, no push to a window, no row change
    expect(s.host.status(SESSION)).toEqual(before.status);
    expect(s.window.sent.length).toBe(before.sent);
    expect(changes).toBe(before.changes);
    expect(existsSync(path.join(leftover, SESSION))).toBe(true);
    // the recorded request wrote 37k: the prefix missed, so the session is not kept again
    s.now.at += KEEP_EVERY_MS;
    await s.host.keep();
    expect(spawns()).toHaveLength(2);
    // until a real turn, which starts its clock again. a model picked in the menu is named to it
    await s.host.setModel(SESSION, "sonnet");
    await s.host.send(SESSION, s.where, COUNT);
    await until(() => s.host.text(SESSION).length > 0, "the second count");
    await s.host.interrupt(SESSION);
    await until(() => !s.host.running(SESSION), "the second turn to end");
    s.now.at += KEEP_EVERY_MS;
    hours = 0;
    await s.host.keep();
    // off is off
    expect(spawns()).toHaveLength(3);
    hours = undefined;
    await s.host.keep();
    // absent is the default's 3 hours
    expect(spawns()).toHaveLength(4);
    expect((spawns()[3] as { argv: string[] }).argv).toContain("--model=sonnet");
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
    expect(s.letGo).toEqual([]);
    s.now.at += REAP_MS + 1;
    s.host.reap();
    // told before the close: letting go is not the session ending
    expect(s.letGo).toEqual([[SESSION]]);
    await until(() => !s.host.hosts(SESSION), "claude to be let go");
  });

  it("names every claude it is about to close on quit", async () => {
    const s = setup();
    await s.host.warm(SESSION, s.where);
    s.host.dispose();
    expect(s.letGo).toEqual([[SESSION]]);
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

  it("a refusal's dialog is a card: its button goes back as the dialog's result", async () => {
    // the hello turn, with claude code asking first what to do about a refusal (vs code's shape)
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-chat-rec-"));
    const fixtures = path.join(import.meta.dirname, "../fixtures/chat");
    const lines = readFileSync(path.join(fixtures, "turn.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    const at = lines.findIndex((l) => JSON.parse(l).msg?.type === "assistant");
    const t = JSON.parse(lines[at] as string).t;
    const dialog = {
      t,
      dir: "out",
      msg: {
        type: "control_request",
        request_id: "dlg-1",
        request: {
          subtype: "request_user_dialog",
          dialog_kind: "refusal_fallback_prompt",
          payload: {
            originalModel: "claude-opus-5-5",
            fallbackModel: "claude-sonnet-5",
            apiRefusalCategory: "cyber",
          },
        },
      },
    };
    lines.splice(at, 0, JSON.stringify(dialog));
    writeFileSync(path.join(dir, "turn.jsonl"), `${lines.join("\n")}\n`);
    const s = setup(2, false, dir);
    await s.host.send(SESSION, s.where, HELLO);
    const card = await ask(s, "refusal");
    // no hook says a dialog is up: the host does, for needs-you
    expect(s.cards).toEqual([[SESSION, "Session paused"]]);
    expect(card).toMatchObject({
      model: "claude-opus-5-5",
      fallback: "claude-sonnet-5",
      category: "cyber",
    });
    // a button the card does not have is refused
    expect(() => s.host.answer(SESSION, card.id, { kind: "dialog", choice: "continue" })).toThrow(
      "not one of its buttons",
    );
    s.host.answer(SESSION, card.id, { kind: "dialog", choice: "retry_fallback" });
    expect(s.cards).toEqual([
      [SESSION, "Session paused"],
      [SESSION, null],
    ]);
    await turnEnded(s);
    expect(answers(s)).toContainEqual({ behavior: "completed", result: "retry_fallback" });
    // declared at start, as vs code declares them
    const init = s
      .log()
      .find((l) => (l.in as { request?: { subtype?: string } })?.request?.subtype === "initialize");
    expect(
      (init?.in as { request?: { supportedDialogKinds?: string[] } } | undefined)?.request
        ?.supportedDialogKinds,
    ).toEqual(["refusal_fallback_prompt", "auto_mode_server_fallback"]);
  });

  it("says a usage limit only when it is close or hit", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-chat-rec-"));
    const fixtures = path.join(import.meta.dirname, "../fixtures/chat");
    const lines = readFileSync(path.join(fixtures, "turn.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    const at = lines.findIndex((l) => JSON.parse(l).msg?.type === "assistant");
    const t = JSON.parse(lines[at] as string).t;
    const event = (status: string, utilization: number) =>
      JSON.stringify({
        t,
        dir: "out",
        msg: {
          type: "rate_limit_event",
          rate_limit_info: {
            status,
            rateLimitType: "five_hour",
            utilization,
            resetsAt: 1792374000,
          },
        },
      });
    lines.splice(at, 0, event("allowed", 0.02), event("allowed_warning", 0.82));
    writeFileSync(path.join(dir, "turn.jsonl"), `${lines.join("\n")}\n`);
    const s = setup(2, false, dir);
    await s.host.send(SESSION, s.where, HELLO);
    await turnEnded(s);
    expect(s.host.status(SESSION).limit).toEqual({
      state: "warning",
      window: "5-hour limit",
      used: 0.82,
      resets: 1792374000_000,
    });
  });

  it("an MCP server's form is a card, and only the fields it asked for go back", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-chat-rec-"));
    const fixtures = path.join(import.meta.dirname, "../fixtures/chat");
    const lines = readFileSync(path.join(fixtures, "turn.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    const at = lines.findIndex((l) => JSON.parse(l).msg?.type === "assistant");
    lines.splice(
      at,
      0,
      JSON.stringify({
        t: JSON.parse(lines[at] as string).t,
        dir: "out",
        msg: {
          type: "control_request",
          request_id: "el-1",
          request: {
            subtype: "elicitation",
            mcp_server_name: "tickets",
            message: "Which board should the card go on?",
            mode: "form",
            requested_schema: {
              type: "object",
              properties: {
                board: { type: "string", enum: ["CDIT", "OPS"], title: "Board" },
                points: { type: "integer", title: "Points" },
                urgent: { type: "boolean" },
              },
              required: ["board"],
            },
          },
        },
      }),
    );
    writeFileSync(path.join(dir, "turn.jsonl"), `${lines.join("\n")}\n`);
    const s = setup(2, false, dir);
    await s.host.send(SESSION, s.where, HELLO);
    const card = await ask(s, "elicit");
    expect(s.cards).toEqual([[SESSION, "tickets asks"]]);
    expect(card.fields.map((f) => [f.key, f.type, f.required])).toEqual([
      ["board", "enum", true],
      ["points", "number", false],
      ["urgent", "boolean", false],
    ]);
    s.host.answer(SESSION, card.id, {
      kind: "elicit",
      action: "accept",
      content: { board: "CDIT", points: 3, urgent: true, sneaky: "x" },
    });
    expect(s.cards.at(-1)).toEqual([SESSION, null]);
    await turnEnded(s);
    expect(answers(s)).toContainEqual({
      action: "accept",
      content: { board: "CDIT", points: 3, urgent: true },
    });
  });

  it("a form still open when its claude goes is gone from needs-you with it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-chat-rec-"));
    const fixtures = path.join(import.meta.dirname, "../fixtures/chat");
    const lines = readFileSync(path.join(fixtures, "turn.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    const at = lines.findIndex((l) => JSON.parse(l).msg?.type === "assistant");
    lines.splice(
      at,
      0,
      JSON.stringify({
        t: JSON.parse(lines[at] as string).t,
        dir: "out",
        msg: {
          type: "control_request",
          request_id: "el-1",
          request: {
            subtype: "elicitation",
            mcp_server_name: "linear",
            message: "Sign in to Linear",
            mode: "url",
            url: "https://linear.app/oauth",
          },
        },
      }),
    );
    writeFileSync(path.join(dir, "turn.jsonl"), `${lines.join("\n")}\n`);
    const s = setup(2, false, dir);
    await s.host.send(SESSION, s.where, HELLO);
    await ask(s, "elicit");
    expect(s.cards).toEqual([[SESSION, "linear asks"]]);
    s.host.dispose();
    await until(() => s.cards.length === 2, "the card to go");
    expect(s.cards.at(-1)).toEqual([SESSION, null]);
  });

  it("knows a dialog by its payload, and leaves one it does not know to claude", () => {
    expect(dialogOf("1", "auto_mode_server_fallback", { paragraphs: ["a", 4, ""] })).toEqual({
      id: "1",
      kind: "auto-fallback",
      paragraphs: ["a"],
    });
    expect(dialogOf("1", "refusal_fallback_prompt", { originalModel: "x" })).toBeUndefined();
    expect(dialogOf("1", "fable_overage_consent_prompt", {})).toBeUndefined();
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

  it("says why auto mode's check failed, and starts claude without clearing when it was the extra body", async () => {
    // claude code 2.1.310's frame for a check that failed, as grove's 0.34 body made every one fail
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-chat-rec-"));
    const fixtures = path.join(import.meta.dirname, "../fixtures/chat");
    const denied = {
      type: "system",
      subtype: "permission_denied",
      tool_name: "mcp__claude-in-chrome__tabs_context_mcp",
      tool_use_id: "t1",
      decision_reason_type: "classifier",
      decision_reason: "Classifier unavailable",
      message:
        "claude-sonnet-5[1m] is temporarily unavailable, so auto mode cannot determine the safety of mcp__claude-in-chrome__tabs_context_mcp right now. Wait a moment and then try this action again.",
    };
    const lines = readFileSync(path.join(fixtures, "turn.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        const o = JSON.parse(l);
        if (o.msg?.type !== "system" || o.msg.subtype !== "init") return [l];
        return [l, JSON.stringify({ t: o.t, dir: "out", msg: denied })];
      });
    writeFileSync(path.join(dir, "turn.jsonl"), `${lines.join("\n")}\n`);
    const s = setup(2, false, dir);
    // claude code's file of what the api said, in the session's folder
    const folder = path.join(path.dirname(s.transcript), SESSION);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, CLASSIFIER_ERROR_FILE),
      '=== ERROR ===\n400 {"type":"error","error":{"type":"invalid_request_error","message":"`clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive"},"request_id":"req_1"}\n\n=== CONTEXT COMPARISON ===\n',
    );
    s.host.attach(SESSION, s.window);
    await s.host.send(SESSION, s.where, HELLO);
    await until(() => s.host.status(SESSION).error === CLEARING_REFUSED, "the restart said");
    expect(s.host.status(SESSION).notes).toContainEqual({
      kind: "denied",
      text: "tabs_context_mcp was turned down: auto mode's check failed. The API said 400 `clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive",
    });
    const starts = s.log().filter((l) => l.argv) as Array<{ env: Record<string, string> }>;
    expect(starts.map((l) => l.env.extraBody !== undefined)).toEqual([true, false]);
  });

  it("reads the api's error out of claude code's file, and knows one about the extra body", () => {
    const file = (line: string) =>
      `=== ERROR ===\n${line}\n\n=== CONTEXT COMPARISON ===\nmodel: x\n`;
    const thinking = classifierError(
      file(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"`clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive"}}',
      ),
    );
    expect(thinking).toBe(
      "400 `clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive",
    );
    expect(refusedClearingCheck(thinking ?? "")).toBe(true);
    expect(refusedClearingCheck("400 context_management: Extra inputs are not permitted")).toBe(
      true,
    );
    // no json: the line as it is
    expect(classifierError(file("Request timed out."))).toBe("Request timed out.");
    expect(classifierError("nothing here")).toBeUndefined();
    for (const other of [
      "529 Overloaded",
      "400 prompt is too long",
      "Request timed out.",
      "500 clear_thinking_20251015 went wrong",
    ])
      expect(refusedClearingCheck(other), other).toBe(false);
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

  it("has the api clear old reads, except where it would refuse every request or the person set their own", () => {
    const body = (e: NodeJS.ProcessEnv, settings?: Record<string, unknown>) =>
      clearingEnv(e, settings).CLAUDE_CODE_EXTRA_BODY;
    const edits = JSON.parse(body({ HOME: "/Users/v" }) ?? "{}").context_management.edits;
    // no clear_thinking: the classifier runs with thinking off and the api 400s it, so auto mode
    // and claude in chrome failed closed on every check
    expect(edits.map((e: { type: string }) => e.type)).toEqual(["clear_tool_uses_20250919"]);
    expect(edits[0].keep.value).toBe(CLEARING.keep);
    // the probe's numbers, through the same builder
    const small = clearingEnv({}, {}, { trigger: 30_000, keep: 20, atLeast: 2_000 });
    expect(
      JSON.parse(small.CLAUDE_CODE_EXTRA_BODY ?? "{}").context_management.edits[0],
    ).toMatchObject({
      trigger: { value: 30_000 },
      clear_at_least: { value: 2_000 },
    });
    // anthropic's own api, said out loud, is still it
    expect(body({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/" })).toBeDefined();
    // a flag turned off is off
    expect(body({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "0" })).toBeDefined();
    expect(body({ CLAUDE_CODE_USE_BEDROCK: "false" })).toBeDefined();
    for (const e of [
      // claude code drops the beta and still sends the body: a 400 on every request (probe o3)
      { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" },
      { CLAUDE_CODE_USE_BEDROCK: "1" },
      { CLAUDE_CODE_USE_VERTEX: "true" },
      { CLAUDE_CODE_USE_FOUNDRY: "1" },
      // a gateway: claude code does not send it the first-party betas
      { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" },
      // the person's own: theirs stays
      { CLAUDE_CODE_EXTRA_BODY: '{"metadata":{}}' },
    ]) {
      expect(body(e), JSON.stringify(e)).toBeUndefined();
      // claude code's settings.json env counts as much as the process's
      expect(body({}, e), `settings ${JSON.stringify(e)}`).toBeUndefined();
    }
    // its settings win over the process env, as in claude code
    expect(
      body(
        { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "0" },
        { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" },
      ),
    ).toBeUndefined();
    // a value of another type in the settings is not a crash
    expect(body({}, { CLAUDE_CODE_USE_BEDROCK: 1, ANTHROPIC_BASE_URL: null })).toBeDefined();
  });

  it("reads claude code's settings.json env for it, a number typed there too, and still starts", async () => {
    const s = setup();
    // the fake claude's config folder: where its transcripts go
    const settings = path.join(s.transcript.split("/projects/")[0] as string, "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        showThinkingSummaries: true,
        env: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 1, X: { a: 1 } },
      }),
    );
    await s.host.warm(SESSION, s.where);
    expect(s.host.status(SESSION).live).toBe(true);
    const { env } = s.log()[0] as { env: Record<string, string> };
    expect(env.extraBody).toBeUndefined();
  });

  it("knows a turn the api refused for the extra body from any other failed one", () => {
    const result = (o: Record<string, unknown>) => ({ type: "result", subtype: "success", ...o });
    const extra = "API Error: 400 context_management: Extra inputs are not permitted";
    const order =
      "API Error: 400 context_management: `clear_thinking_20251015` must be the first strategy in `context_management.edits` when provided";
    expect(refusedClearing(result({ is_error: true, api_error_status: 400, result: extra }))).toBe(
      true,
    );
    // without the status field, its text says it
    expect(refusedClearing(result({ is_error: true, result: order }))).toBe(true);
    for (const other of [
      result({
        is_error: true,
        api_error_status: 400,
        result: "API Error: 400 prompt is too long",
      }),
      result({ is_error: true, api_error_status: 529, result: "API Error: 529 Overloaded" }),
      result({ is_error: false, result: "context_management is a thing" }),
      { type: "assistant", is_error: true, result: extra },
    ])
      expect(refusedClearing(other), JSON.stringify(other)).toBe(false);
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
    expect(parseAnswer({ kind: "plan", approve: true, mode: "acceptEdits" })).toEqual({
      kind: "plan",
      approve: true,
      mode: "acceptEdits",
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
      { kind: "plan", approve: true, mode: "yolo" },
      { kind: "permission", allow: "forever" },
      { kind: "dialog", choice: "yes" },
      { kind: "permission", allow: "once", message: 4 },
      { kind: "bash", command: "rm -rf /" },
    ]) {
      expect(() => parseAnswer(bad), JSON.stringify(bad)?.slice(0, 60)).toThrow("not an answer");
    }
  });

  it("takes from a page only files grove sends, within its caps, and nothing riding along", () => {
    const png = { kind: "image", mediaType: "image/png", data: "iVBORw0KGgo=" };
    const named = { ...png, name: "shot.png" };
    const paste = { kind: "data", name: "notes.md", mediaType: "text/markdown", data: "IyBoaQ==" };
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments([png, { ...named, extra: 1 }, { ...paste, extra: 1 }])).toEqual([
      png,
      named,
      paste,
    ]);
    // chromium gives a type it does not know as empty
    expect(parseAttachments([{ ...paste, mediaType: "" }])[0]).toMatchObject({ mediaType: "" });
    for (const bad of [
      "png",
      [null],
      [{ ...png, mediaType: "image/svg+xml" }],
      [{ ...png, data: "not base64!" }],
      [{ ...png, data: "A".repeat(ATTACH.bytes + 4) }],
      [{ ...named, name: "" }],
      [{ ...named, name: "../shot.png" }],
      [{ ...paste, data: "not base64!" }],
      [{ ...paste, data: "A".repeat(ATTACH.bytes + 4) }],
      [{ ...paste, name: "" }],
      [{ ...paste, name: 4 }],
      // its name becomes a file's in grove's uploads: never a path somewhere else
      [{ ...paste, name: "../../.zshrc" }],
      [{ ...paste, name: "a\nb" }],
      [{ ...paste, mediaType: 4 }],
      // the shapes before 0.27: a pdf or a text file went inline
      [{ kind: "pdf", name: "spec.pdf", data: "JVBERi0=" }],
      [{ kind: "text", name: "data.csv", text: "a,b" }],
      [{ kind: "docx", name: "a.docx", data: "AAAA" }],
      Array.from({ length: 11 }, () => png),
    ]) {
      expect(() => parseAttachments(bad), JSON.stringify(bad)?.slice(0, 60)).toThrow(
        "not a file Claude can take",
      );
    }
  });

  it("takes any other file by its path: a file there now, counted, never read", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-attach-"));
    const clip = path.join(dir, "clip.mp4");
    writeFileSync(clip, "not really a video");
    const file = { kind: "file", name: "clip.mp4", path: clip, mediaType: "video/mp4", size: 1 };
    // main's own size, from the disk, and the name is the path's
    expect(parseAttachments([{ ...file, name: "other.mov", extra: 1 }])).toEqual([
      { kind: "file", name: "clip.mp4", path: clip, mediaType: "video/mp4", size: 18 },
    ]);
    // a type chromium does not know is empty
    expect(parseAttachments([{ ...file, mediaType: "" }])[0]).toMatchObject({ mediaType: "" });
    for (const bad of [
      [{ ...file, path: "clip.mp4" }],
      [{ ...file, path: 4 }],
      [{ ...file, path: `${clip}\n/etc/passwd` }],
      [{ ...file, mediaType: 4 }],
      [{ ...file, name: "" }],
      Array.from({ length: 11 }, () => file),
    ]) {
      expect(() => parseAttachments(bad), JSON.stringify(bad)?.slice(0, 60)).toThrow(
        "not a file Claude can take",
      );
    }
    expect(() => parseAttachments([{ ...file, path: path.join(dir, "gone.mp4") }])).toThrow(
      "clip.mp4 is not there any more.",
    );
    expect(() => parseAttachments([{ ...file, path: dir }])).toThrow("clip.mp4 is not a file.");
  });

  /** the user messages claude got, as their content blocks */
  const userContents = (s: Setup) =>
    s.log().flatMap((l) => {
      const m = l.in as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
      return m?.type === "user" ? [m.message?.content ?? []] : [];
    });

  /** a fake pdftoppm in a folder of its own, for a PATH that has one */
  const withPdftoppm = () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "grove-poppler-"));
    writeFileSync(path.join(bin, "pdftoppm"), "#!/bin/sh\n");
    chmodSync(path.join(bin, "pdftoppm"), 0o755);
    return bin;
  };

  it("sends a file in the session's folders by its own path, as a text block before the words", async () => {
    const s = setup();
    const clip = path.join(s.where.cwd, "clip.mp4");
    writeFileSync(clip, "not really a video");
    await s.host.send(SESSION, s.where, HELLO, [
      { kind: "file", name: "clip.mp4", path: clip, mediaType: "video/mp4", size: 18 },
    ]);
    await turnEnded(s);
    expect(userContents(s)[0]).toEqual([
      {
        type: "text",
        text: [
          "<attached-file>",
          "The user attached this file to their message. It is on disk, not in the message: open it from its path.",
          "If you need its exact contents again later, read it again rather than answering from memory.",
          "If Read says the file is unchanged since your last read but that earlier result is gone, Grep it or Read it with an offset.",
          `path: ${clip}`,
          "type: video/mp4",
          "size: 18 bytes",
          "</attached-file>",
        ].join("\n"),
      },
      { type: "text", text: HELLO },
    ]);
    // nothing of it was copied
    expect(existsSync(path.join(s.uploads, SESSION))).toBe(false);
  });

  it("clones a file from elsewhere into the session's uploads and sends the copy, which outlives the original", async () => {
    const s = setup(2, false, undefined, undefined, { PATH: `${withPdftoppm()}:/usr/bin:/bin` });
    const away = mkdtempSync(path.join(os.tmpdir(), "grove-downloads-"));
    const pdf = path.join(away, "spec.pdf");
    const csv = path.join(away, "data.csv");
    writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");
    writeFileSync(csv, "a,b\n1,2\n");
    await s.host.send(SESSION, s.where, HELLO, [
      { kind: "file", name: "spec.pdf", path: pdf, mediaType: "application/pdf", size: 15 },
      { kind: "file", name: "data.csv", path: csv, mediaType: "text/csv", size: 8 },
      { kind: "data", name: "notes.md", mediaType: "text/markdown", data: "IyBoaQ==" },
      // a second paste by the same name: its own place, under its own name
      { kind: "data", name: "notes.md", mediaType: "text/markdown", data: "IyB0d28=" },
    ]);
    await turnEnded(s);
    const mine = path.join(s.uploads, SESSION);
    const [content] = userContents(s);
    const texts = (content ?? []).map((b) => b.text as string);
    expect(texts.at(-1)).toBe(HELLO);
    expect(texts[0]).toContain(
      `\npath: ${mine}/spec.pdf\ncopy of: ${pdf}\ntype: application/pdf\nsize: 15 bytes\n`,
    );
    // pdftoppm is there: pages work, nothing is said of them
    expect(texts[0]).not.toContain("pages");
    expect(texts[1]).toContain(`\npath: ${mine}/data.csv\ncopy of: ${csv}\ntype: text/csv\n`);
    // a paste has no original: written there, never copied
    expect(texts[2]).toContain(`\npath: ${mine}/notes.md\ntype: text/markdown\nsize: 4 bytes\n`);
    expect(texts[2]).not.toContain("copy of:");
    expect(texts[3]).toContain(`\npath: ${mine}/2/notes.md\n`);
    expect(readFileSync(path.join(mine, "notes.md"), "utf8")).toBe("# hi");
    expect(readFileSync(path.join(mine, "2", "notes.md"), "utf8")).toBe("# two");
    // the original moved or deleted in finder: the copy claude reads is still there
    rmSync(pdf);
    expect(readFileSync(path.join(mine, "spec.pdf"), "utf8")).toBe("%PDF-1.4\n%%EOF\n");
  });

  it("says to read a pdf whole where claude's PATH has no pdftoppm, looked up once", async () => {
    const s = setup(2, false, undefined, undefined, { PATH: "/usr/bin:/bin" });
    const pdf = path.join(s.where.cwd, "spec.pdf");
    writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");
    const file = { kind: "file" as const, name: "spec.pdf", path: pdf, mediaType: "", size: 15 };
    const clip = { ...file, name: "clip.mp4", path: path.join(s.where.cwd, "clip.mp4") };
    writeFileSync(clip.path, "x");
    await s.host.send(SESSION, s.where, HELLO, [file, clip]);
    await turnEnded(s);
    const [content] = userContents(s);
    // a .pdf chromium gave no type is still a pdf
    expect(content?.[0]?.text).toContain(
      "\nRead the whole PDF, without `pages`: reading pages needs pdftoppm, which is not installed.\n",
    );
    expect(content?.[1]?.text).not.toContain("pages");
  });

  it("sends an image inline, and one typed mid-turn by a path: claude code drops documents there and sends images unshrunk", async () => {
    const s = setup();
    const png = "iVBORw0KGgo=";
    await s.host.send(SESSION, s.where, HELLO, [
      { kind: "image", mediaType: "image/png", data: png, name: "shot.png" },
    ]);
    await turnEnded(s);
    expect(userContents(s)[0]?.[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: png },
    });
    await s.host.send(SESSION, s.where, COUNT);
    await until(() => s.host.text(SESSION).length > 0, "the count");
    await s.host.send(SESSION, s.where, AFTER, [
      { kind: "image", mediaType: "image/png", data: png, name: "shot.png" },
      { kind: "image", mediaType: "image/jpeg", data: png },
    ]);
    expect(s.host.status(SESSION).queued.map((q) => q.text)).toEqual([`${AFTER} [2 images]`]);
    const queued = await until(() => userContents(s)[2], "the queued message");
    const mine = path.join(s.uploads, SESSION);
    expect(queued.map((b) => b.type)).toEqual(["text", "text", "text"]);
    expect(queued[0]?.text).toContain(`\npath: ${mine}/shot.png\ntype: image/png\nsize: 8 bytes\n`);
    // a paste with no name is called what it is
    expect(queued[1]?.text).toContain(`\npath: ${mine}/image.jpg\ntype: image/jpeg\n`);
    expect(readFileSync(path.join(mine, "shot.png")).toString("base64")).toBe(png);
    await s.host.interrupt(SESSION);
    await until(() => s.host.status(SESSION).queued.length === 0, "the queue to clear");
  });

  it("puts a message's files on disk before it goes, and never lets the next overtake it", async () => {
    const s = setup();
    await s.host.warm(SESSION, s.where);
    const big = path.join(mkdtempSync(path.join(os.tmpdir(), "grove-big-")), "big.bin");
    writeFileSync(big, Buffer.alloc(8 * 1024 * 1024));
    await Promise.all([
      s.host.send(SESSION, s.where, HELLO, [
        { kind: "file", name: "big.bin", path: big, mediaType: "", size: 1 },
      ]),
      s.host.send(SESSION, s.where, AFTER),
    ]);
    // the copy takes a moment, the second has nothing to copy: it still goes second
    const sent = await until(() => userContents(s).length >= 2 && userContents(s), "both sends");
    expect(sent.map((c) => c.at(-1)?.text)).toEqual([HELLO, AFTER]);
  });

  it("starts claude again without clearing when the api refuses it, says so once, and leaves it off", async () => {
    const s = setup(2, false, undefined, undefined, { GROVE_FAKE_CHAT_REFUSE_EXTRA_BODY: "1" });
    // a session grove just made: its first claude starts it, the second resumes it
    const where = { ...s.where, fresh: true };
    await s.host.send(SESSION, where, HELLO);
    await until(() => s.host.status(SESSION).error === CLEARING_REFUSED, "the refusal said");
    expect(s.host.status(SESSION).live).toBe(true);
    const starts = s.log().filter((l) => l.argv) as Array<{
      argv: string[];
      env: Record<string, string>;
    }>;
    expect(starts).toHaveLength(2);
    const [first, second] = starts as [(typeof starts)[0], (typeof starts)[0]];
    expect(first.env.extraBody).toBeDefined();
    expect(first.argv).toContain(`--session-id=${SESSION}`);
    expect(second.env.extraBody).toBeUndefined();
    expect(second.argv).toContain(`--resume=${SESSION}`);
    // the turn that failed is in the transcript as the api error it was: its "Try again" re-sends it
    const lines = readFileSync(s.transcript, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.isApiErrorMessage)).toHaveLength(1);
    // tried again, it runs, and the line is gone with the turn it was about
    await s.host.send(SESSION, s.where, HELLO);
    await turnEnded(s);
    expect(readFileSync(s.transcript, "utf8")).toContain("hello from the spike");
    expect(s.host.status(SESSION).error).toBeUndefined();
    // another chat of this grove starts without it: it would only be refused again
    const other = "22222222-3333-4444-8555-666666666666";
    await s.host.warm(other, s.where);
    const third = s
      .log()
      .filter((l) => l.argv)
      .at(-1) as { env: Record<string, string> };
    expect(third.env.extraBody).toBeUndefined();
  });

  it("a session grove makes starts on its project's model and effort, a resumed one on its own", async () => {
    const s = setup(2);
    await s.host.warm(SESSION, { ...s.where, fresh: true, model: "sonnet", effort: "low" });
    const other = "22222222-3333-4444-8555-666666666666";
    await s.host.warm(other, { ...s.where, model: "sonnet", effort: "low" });
    const starts = await until(() => {
      const a = s.log().filter((l) => l.argv) as Array<{ argv: string[] }>;
      return a.length >= 2 && a;
    }, "both started");
    const [fresh, resumed] = starts.map((x) => x.argv.join(" "));
    expect(fresh).toContain("--model=sonnet");
    expect(fresh).toContain("--effort=low");
    expect(resumed).not.toContain("--model");
    expect(resumed).not.toContain("--effort");
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
