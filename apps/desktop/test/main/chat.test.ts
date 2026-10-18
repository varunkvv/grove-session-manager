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
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatHost,
  hostEnv,
  modesFor,
  parseAnswer,
  parseImages,
  REAP_MS,
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

function setup(delayMs = 2, failFirst = false): Setup {
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
      // what a grove started from a claude code session would pass on
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
    }),
    now: () => now.at,
    claudeSettings: path.join(claudeDir, "settings.json"),
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

  it("takes from a page only images the api takes, and no more of them than it takes", () => {
    const png = { mediaType: "image/png", data: "iVBORw0KGgo=" };
    expect(parseImages(undefined)).toEqual([]);
    expect(parseImages([png, { ...png, mediaType: "image/webp", extra: 1 }])).toEqual([
      png,
      { mediaType: "image/webp", data: "iVBORw0KGgo=" },
    ]);
    for (const bad of [
      "png",
      [null],
      [{ ...png, mediaType: "image/svg+xml" }],
      [{ ...png, mediaType: "text/html" }],
      [{ ...png, data: "not base64!" }],
      [{ ...png, data: 4 }],
      [{ ...png, data: "A".repeat(7_000_000) }],
      Array.from({ length: 11 }, () => png),
    ]) {
      expect(() => parseImages(bad), JSON.stringify(bad)?.slice(0, 60)).toThrow("not an image");
    }
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
