// grove chat (beta): a session in its own window, talked to through a fake claude that plays back
// the spike's recordings (test/fixtures/chat). with the switch off, nothing of it is there.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { writeFakeClaude } from "./helpers/fakeClaude.ts";
import {
  appendTurn,
  hookEvent,
  makeFixture,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { groveTest, type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { liveSession, writeProject } from "./helpers/project.ts";

const SID = "cccccccc-0000-4000-8000-000000000001";
const TITLE = "talk to it here";
// the recorded prompts: the fake plays the turn whose prompt it is sent
const HELLO = "Reply with exactly: hello from the spike";
const QUESTION =
  "Use the AskUserQuestion tool once to ask me which colour I prefer, with exactly two options: Red and Blue. Then reply with one line saying which I picked. Do not use any other tool.";
const COUNT = "Count from 1 to 400, one number per line, nothing else.";
const PLAN =
  "Plan how to create notes.txt containing the word hi in the current folder. Keep the plan to three short steps, then present it with ExitPlanMode. Do not read or write any files.";
const WRITE = "Create a file named perm.txt containing the letter x, using the Write tool.";
/** recordings/d-background: a foreground Bash, sent to the background once claude makes it a task */
const BACKGROUND =
  "Run the Bash command `sleep 10 && echo bg-done` in the foreground (do not set run_in_background), then reply with one short line.";
/** recordings/c-start: haiku 5.5 thinks, with the summary text */
const THINK = "Think step by step, then reply with just the number: 23*19 + 7^3 - 45?";
/** recordings/c-denied: under dontAsk a Write is turned down without asking */
const DENIED = "Create a file named x.txt containing x, using the Write tool.";
/** recordings/c-agents: two background agents, then a Bash of its own */
const AGENTS = [
  "Do exactly these three things, in this order, with no other tools:",
  "1. Use the Agent tool with subagent_type general-purpose, run_in_background true, description 'slow lister', and prompt 'Run the Bash command `sleep 4 && ls` and reply with its output.'",
  "2. Use the Agent tool with subagent_type general-purpose, run_in_background true, description 'long sleeper', and prompt 'Run the Bash command `sleep 60` and then reply done.'",
  "3. Run the Bash command `sleep 5 && echo main-done` yourself.",
  "Then reply with one short line.",
].join("\n");

/** recordings/d-workflowstop: a Workflow of six agents one after another, stopped mid-run */
const WORKFLOW = (
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, "../test/fixtures/chat/workflow.jsonl"), "utf8")
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

/** a 2x2 png */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==";

let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

function seed(chat: boolean) {
  const fx = makeFixture({ withCompanion: true });
  if (chat) writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ chat: true }));
  const { id, root } = writeProject(fx, { name: "chat-trial" });
  const file = writeSession(fx, {
    cwd: root,
    sessionId: SID,
    title: TITLE,
    prompt: "set the scene",
  });
  const fake = writeFakeClaude(fx.dir);
  const chatLog = path.join(fx.dir, "chat.log");
  return { fx, id, root, file, fake, chatLog };
}

async function launch(s: ReturnType<typeof seed>, extra: Record<string, string> = {}) {
  app = await launchApp(s.fx, {
    GROVE_CLAUDE_BIN: s.fake.bin,
    GROVE_FAKE_CHAT_LOG: s.chatLog,
    GROVE_FAKE_CHAT_DELAY_MS: "40",
    ...extra,
  });
  return app;
}

/** the chat window that shows this session: a page on `#/chat` with it in its root */
async function chatWindow(electron: ElectronApplication, sessionId: string): Promise<Page> {
  let found: Page | undefined;
  await waitFor(async () => {
    for (const p of electron.windows()) {
      if (!p.url().includes("#/chat")) continue;
      if ((await p.locator(`[data-testid="chat"][data-id="${sessionId}"]`).count()) > 0) {
        found = p;
        return true;
      }
    }
    return false;
  }, 15_000);
  return found as Page;
}

const openRow = async (page: Page, id: string) => {
  await page.locator(`[data-testid="project-item"][data-id="${id}"]`).click();
  await page.locator(`[data-testid="session-row"][data-id="${SID}"]`).dblclick();
};

/** grove's uploads under a test root: userData is <root>/.grove/electron */
const uploadsOf = (s: ReturnType<typeof seed>) =>
  path.join(s.fx.root, ".grove", "electron", "uploads");

/** what the fake claude was sent: its answers to the permission requests among them */
function sentToClaude(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("switched off, grove is as it was: one window, and a double-click opens the editor", async () => {
  const s = seed(false);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  await waitFor(async () => readExecLog(s.fx).length > 0);
  expect(readExecLog(s.fx)[0]?.bin).toBe("code");
  // no spare, no chat window: only the main one
  await page.waitForTimeout(1500);
  expect(electron.windows()).toHaveLength(1);
  await expect(page.getByTestId("panel-chat")).toHaveCount(0);
  // the panel is the transcript, as it was: no session card
  await expect(page.getByTestId("session-panel").getByTestId("turn")).toHaveCount(1);
  await expect(page.getByTestId("session-card")).toHaveCount(0);
  // the switch is in Settings, off
  await page.keyboard.press("Meta+,");
  await expect(page.getByTestId("setting-chat")).toHaveAttribute("aria-checked", "false");
  expect(sentToClaude(s.chatLog)).toEqual([]);
});

test("grove names a session with its window open: the header and the window's title follow", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await expect(chat.locator("h1")).toHaveText(TITLE);
  await chat.getByTestId("chat-files").click();
  await expect(chat.getByTestId("files")).toBeVisible();
  // what Claude Code appends when grove's hook hands it a name
  appendFileSync(
    s.file,
    `${JSON.stringify({ type: "custom-title", customTitle: "the retry loop", sessionId: SID })}\n`,
  );
  await expect(chat.locator("h1")).toHaveText("the retry loop");
  await expect.poll(() => chat.title()).toBe("the retry loop · chat-trial");
  // only the name moved: the window was not loaded again
  await expect(chat.getByTestId("files")).toBeVisible();
});

test("switched on, a double-click opens the session's own window, and a prompt streams back", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await expect(chat.locator("h1")).toHaveText(TITLE);
  // named for the Window menu and Mission Control: the session, then its project
  await expect.poll(() => chat.title()).toBe(`${TITLE} · chat-trial`);
  // the header is in the project's colour, the same hue as its mark, and says the project first
  const hue = await chat
    .getByTestId("chat-header")
    .getByTestId("project-mark")
    .getAttribute("data-hue");
  await expect(chat.getByTestId("chat-header")).toHaveClass(new RegExp(`bg-project-${hue}-soft`));
  await expect(chat.getByTestId("chat-project")).toHaveText("chat-trial/");
  // the transcript is drawn before any claude runs
  await expect(chat.getByTestId("turn")).toHaveCount(1);
  expect(sentToClaude(s.chatLog)).toEqual([]);
  // nothing opened in the editor
  expect(readExecLog(s.fx)).toEqual([]);

  const composer = chat.getByTestId("composer");
  await expect(composer).toBeFocused();
  await composer.fill(HELLO);
  await composer.press("Enter");
  // what was sent shows at once, and the answer comes in under it
  await expect(chat.getByTestId("turn")).toHaveCount(2);
  await expect(chat.getByTestId("panel-text")).toContainText("hello from the spike");
  await expect(chat.getByTestId("state")).toHaveCount(0);
  // claude ran in the project's folder, on this session, with its settings
  const [first] = sentToClaude(s.chatLog) as Array<{ argv: string[]; cwd: string }>;
  expect(first?.cwd).toBe(s.root);
  expect(first?.argv).toContain(`--resume=${SID}`);
  // the main window knows grove runs it
  await expect(
    page.locator(`[data-testid="session-row"][data-id="${SID}"] [data-testid="runtime-chip"]`),
  ).toHaveAttribute("data-runtime", "grove");

  // a second double-click brings the same window back, not another
  await openRow(page, s.id);
  await page.waitForTimeout(500);
  const chats = electron.windows().filter((p) => p.url().includes("#/chat"));
  // that one, and the spare made after it
  expect(chats).toHaveLength(2);
});

test("a question comes as a card, and the pick goes back to claude", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(QUESTION);
  await composer.press("Enter");
  const card = chat.getByTestId("ask-question");
  await expect(card).toContainText("Which colour do you prefer?");
  await expect(chat.getByTestId("state")).toHaveAttribute("data-state", "turn");
  await card.getByTestId("ask-option").filter({ hasText: "Blue" }).click();
  await expect(card).toHaveCount(0);
  await expect(chat.getByTestId("panel-text")).toContainText("You picked Blue.");
  const answer = sentToClaude(s.chatLog)
    .map((l) => l.in as { type?: string; response?: { response?: Record<string, unknown> } })
    .find((m) => m?.type === "control_response")?.response?.response;
  expect(answer).toMatchObject({
    behavior: "allow",
    updatedInput: { answers: { "Which colour do you prefer?": "Blue" } },
  });
});

test("several questions are tabs: one at a time, multi-select picks any, and Submit sends them all", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(QUESTIONS);
  await composer.press("Enter");
  const card = chat.getByTestId("ask-question");
  await expect(card.getByTestId("ask-tab")).toHaveText(["Language", "Checks", "Output"], {
    timeout: 15_000,
  });
  // the card has the keys: a hover shows an option's preview, 2 picks Go and moves on
  await card.getByTestId("ask-option").filter({ hasText: "Go" }).hover();
  await expect(card.getByTestId("ask-preview")).toContainText("fmt.Println");
  await card.getByTestId("ask-body").press("2");
  await expect(card.getByTestId("ask-tab").first()).toHaveAttribute("aria-selected", "false");
  // multi-select: two picks, then Next
  await card.getByTestId("ask-option").filter({ hasText: "Lint" }).click();
  await card.getByTestId("ask-option").filter({ hasText: "Tests" }).click();
  await card.getByTestId("ask-next").click();
  // words of your own for the last, and Enter moves to the review
  await card.getByTestId("ask-other").fill("a slack message");
  await card.getByTestId("ask-other").press("Enter");
  await expect(card.getByTestId("ask-review")).toContainText("Lint, Tests");
  await expect(card.getByTestId("ask-tab")).toHaveText([/Language/, /Checks/, /Output/]);
  await card.getByTestId("ask-body").press("Enter");
  await expect(chat.getByTestId("panel-text")).toContainText("Checks: Lint, Tests", {
    timeout: 15_000,
  });
  const answered = sentToClaude(s.chatLog)
    .map(
      (l) =>
        (l.in as { response?: { response?: { updatedInput?: { answers?: unknown } } } })?.response
          ?.response?.updatedInput?.answers,
    )
    .find(Boolean);
  expect(answered).toEqual({
    "Which language should the script use?": "Go",
    "Which checks should run?": "Lint, Tests",
    "Where should the results go?": "a slack message",
  });
});

test("the session card: what it waits on is answered from the main window, and a reply goes to the same claude", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s, { GROVE_FAKE_CHAT_TOOL_MS: "4000" });
  // no transcript in the panel: the card, with a reply box R goes to
  await page.locator(`[data-testid="project-item"][data-id="${s.id}"]`).click();
  await page.locator(`[data-testid="session-row"][data-id="${SID}"]`).click();
  const card = page.getByTestId("session-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("session-panel").getByTestId("turn")).toHaveCount(0);
  await expect(card.getByTestId("card-tail")).toBeVisible();
  // the row has the keyboard: R moves it to the reply
  await page.keyboard.press("r");
  await expect(card.getByTestId("card-reply")).toBeFocused();
  // a reply starts grove's own claude on it, and a question comes back to the card
  await card.getByTestId("card-reply").fill(QUESTION);
  await card.getByTestId("card-reply").press("Enter");
  const asked = card.getByTestId("ask-question");
  await expect(asked).toBeVisible({ timeout: 15_000 });
  // the chat window, opened now, shows the same ask, and the card's answer settles both
  await page.getByTestId("panel-chat").click();
  const chat = await chatWindow(electron, SID);
  await expect(chat.getByTestId("ask-question")).toBeVisible();
  await page.bringToFront();
  await asked.getByTestId("ask-option").filter({ hasText: "Blue" }).click();
  await expect(chat.getByTestId("ask-question")).toHaveCount(0);
  await expect(chat.getByTestId("panel-text")).toContainText("Blue", { timeout: 15_000 });
  await expect(card.getByTestId("card-tail")).toContainText("Blue", { timeout: 15_000 });
  // while a turn runs the card says what it is doing, and a reply queues
  await card.getByTestId("card-reply").fill(AGENTS);
  await card.getByTestId("card-reply").press("Enter");
  await expect(card.getByTestId("card-live")).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId("card-reply")).toHaveAttribute("placeholder", "Queue a reply…");
  await card.getByTestId("card-reply").fill(HELLO);
  await card.getByTestId("card-reply").press("Enter");
  await expect(chat.getByTestId("chat-queued")).toContainText(HELLO);
  // the card has it too, over its reply box. it is taken back from the chat window
  await expect(card.getByTestId("chat-queued")).toContainText("You, queued");
  await expect(card.getByTestId("chat-queued")).toContainText(HELLO);
  await expect(card.getByTestId("chat-unqueue")).toHaveCount(0);
  // taken back before claude got to it: its words come back to the reply box's twin, the composer
  await chat.getByTestId("chat-queued").hover();
  await chat.getByTestId("chat-unqueue").click();
  await expect(chat.getByTestId("chat-queued")).toHaveCount(0);
  await expect(card.getByTestId("chat-queued")).toHaveCount(0);
  await expect(chat.getByTestId("composer")).toHaveValue(HELLO);
  // what runs for it is one line, and it opens the chat window's agents
  await expect(card.getByTestId("card-agents")).toContainText(
    "2 running · slow lister, long sleeper",
  );
  await card.getByTestId("card-agents").click();
  await expect(chat.getByTestId("agents")).toBeVisible();
});

/**
 * watches the conversation every frame from now on: the words are on screen, as a row, his block
 * or a prompt, and never gone once seen. `gap()` says if a frame ever missed them
 */
async function watchFor(page: Page, words: string) {
  await page.evaluate((w) => {
    const g = window as unknown as { gapSeen?: boolean; gapMissed?: number };
    g.gapSeen = false;
    g.gapMissed = 0;
    const look = () => {
      const on = !!document.querySelector('[data-testid="conversation"]')?.textContent?.includes(w);
      if (on) g.gapSeen = true;
      else if (g.gapSeen) g.gapMissed = (g.gapMissed ?? 0) + 1;
      requestAnimationFrame(look);
    };
    look();
  }, words);
  return {
    gap: () => page.evaluate(() => (window as unknown as { gapMissed?: number }).gapMissed ?? 0),
  };
}

test("a message typed while it works stays on screen as claude takes it, and lands where it was taken", async () => {
  const s = seed(true);
  const typed = "and run the retry tests once the lister is back";
  const { app: electron, page } = await launch(s, {
    GROVE_FAKE_CHAT_TOOL_MS: "2500",
    GROVE_FAKE_CHAT_FOLD: "1",
    GROVE_FAKE_CHAT_FOLD_MS: "1500",
  });
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(AGENTS);
  await composer.press("Enter");
  await expect(chat.getByTestId("state")).toHaveAttribute("data-state", "working");
  await composer.fill(typed);
  // a screenshot with it: claude code would send it mid-turn unshrunk, so it goes by a path
  await chat.evaluate((b64) => {
    const paste = new DataTransfer();
    paste.items.add(
      new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "shot.png", {
        type: "image/png",
      }),
    );
    document
      .querySelector('[data-testid="composer"]')
      ?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: paste, bubbles: true, cancelable: true }),
      );
  }, PNG);
  await expect(chat.getByTestId("composer-files").locator("img")).toHaveCount(1);
  await composer.press("Enter");
  const row = chat.getByTestId("chat-queued");
  await expect(row).toContainText("You, queued");
  await expect(row).toContainText(`${typed} [1 image]`);
  const watch = await watchFor(chat, typed);
  // claude took it: the same row, as sent, and nothing to take back. the transcript has not got it
  await expect(row).toHaveAttribute("data-taken", "", { timeout: 15_000 });
  await expect(row).toContainText("You, while it worked");
  await expect(row).toContainText(typed);
  await expect(row.getByTestId("chat-unqueue")).toHaveCount(0);
  await expect(chat.getByTestId("turn-typed")).toHaveCount(0);
  // the transcript has it: his block in the turn, where it was taken, and the row gone
  const turn = chat.getByTestId("turn").last();
  await expect(turn.getByTestId("turn-typed")).toContainText(typed, { timeout: 15_000 });
  await expect(turn.getByTestId("typed-attached")).toHaveText(" · shot.png");
  await expect(row).toHaveCount(0);
  const shot = path.join(uploadsOf(s), SID, "shot.png");
  expect(readFileSync(shot).toString("base64")).toBe(PNG);
  const said = sentToClaude(s.chatLog)
    .map((l) => l.in as { type?: string; message?: { content?: Array<Record<string, unknown>> } })
    .filter((m) => m?.type === "user")
    .at(-1);
  expect(said?.message?.content?.map((c) => c.type)).toEqual(["text", "text"]);
  expect(said?.message?.content?.[0]?.text).toContain(`\npath: ${shot}\ntype: image/png\n`);
  // after the steps that ran before it, before what claude said after it, not under the prompt
  await expect(chat.getByTestId("state")).toHaveCount(0, { timeout: 30_000 });
  const order = await turn.evaluate((el) =>
    [
      ...el.querySelectorAll(
        '[data-testid="step-fold"], [data-testid="turn-typed"], [data-testid="panel-text"]',
      ),
    ].map((x) => x.getAttribute("data-testid")),
  );
  expect(order.indexOf("turn-typed")).toBeGreaterThan(order.indexOf("step-fold"));
  expect(order.indexOf("turn-typed")).toBeLessThan(order.lastIndexOf("panel-text"));
  await expect(turn.getByTestId("panel-prompt")).not.toContainText(typed);
  expect(await watch.gap()).toBe(0);
});

test("a message still queued when the turn ends runs as the next turn, on screen all the way", async () => {
  const s = seed(true);
  const after = "Reply with exactly: after the interrupt";
  const { app: electron, page } = await launch(s, { GROVE_FAKE_CHAT_NEXT_MS: "1500" });
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(COUNT);
  await composer.press("Enter");
  await expect(chat.getByTestId("panel-text")).toContainText("3");
  await composer.fill(after);
  await composer.press("Enter");
  await expect(chat.getByTestId("chat-queued")).toContainText("You, queued");
  const watch = await watchFor(chat, after);
  await composer.press("Escape");
  // the turn is over and claude has it to run next: the same row, as sent
  await expect(chat.getByTestId("state")).toHaveCount(0);
  await expect(chat.getByTestId("chat-queued")).toHaveAttribute("data-taken", "");
  await expect(chat.getByTestId("chat-queued")).toContainText("You, while it worked");
  // the next turn's prompt, and the row gone
  await expect(chat.getByTestId("turn").last().getByTestId("panel-prompt")).toHaveText(after, {
    timeout: 15_000,
  });
  await expect(chat.getByTestId("panel-text")).toHaveText("after the interrupt");
  await expect(chat.getByTestId("chat-queued")).toHaveCount(0);
  expect(await watch.gap()).toBe(0);
});

test("the session card of a session live in VS Code only points there", async () => {
  const s = seed(true);
  liveSession(s.fx, { sessionId: SID, kind: "interactive", entrypoint: "claude-vscode" });
  const { page } = await launch(s);
  await page.locator(`[data-testid="project-item"][data-id="${s.id}"]`).click();
  await page.locator(`[data-testid="session-row"][data-id="${SID}"]`).click();
  const card = page.getByTestId("session-card");
  await expect(card.getByTestId("card-elsewhere")).toHaveText("Live in VS Code. Answer it there.");
  await expect(card.getByTestId("card-reply")).toHaveCount(0);
});

test("a plan is approved into a mode, and a permission is turned down with a reason", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(PLAN);
  await composer.press("Enter");
  const plan = chat.getByTestId("ask-plan");
  // the modes this session offers, the most hands-off first
  await expect(plan.getByTestId("plan-approve")).toHaveText(
    ["Approve, bypass permissions", "Approve, accept edits", "Approve, ask before edits"],
    { timeout: 15_000 },
  );
  await plan.getByTestId("plan-note").fill("add a check that the file exists");
  await plan.getByTestId("plan-note").press("Enter");
  await expect(chat.getByTestId("ask-plan")).toBeVisible({ timeout: 15_000 });
  await chat.getByTestId("ask-plan").locator('[data-mode="acceptEdits"]').click();
  await expect(chat.getByTestId("ask-plan")).toHaveCount(0);
  const replies = () =>
    sentToClaude(s.chatLog).flatMap((l) => {
      const m = l.in as { type?: string; response?: { response?: Record<string, unknown> } };
      return m?.type === "control_response" ? [m.response?.response ?? {}] : [];
    });
  await waitFor(async () => replies().some((r) => r.behavior === "allow"));
  expect(replies().find((r) => r.behavior === "deny")).toMatchObject({
    message: "add a check that the file exists",
  });
  expect(replies().find((r) => r.behavior === "allow")).toMatchObject({
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  });
  await expect(chat.getByTestId("chat-stop")).toHaveCount(0, { timeout: 15_000 });
  // what its Write made opens from the step, as a diff
  const turn = chat.getByTestId("turn").last();
  await turn.getByTestId("turn-steps-toggle").click();
  await turn.getByTestId("step").filter({ hasText: "proj/notes.txt" }).click();
  await expect(turn.getByTestId("diff")).toContainText("+hi");
  // a permission, turned down with words of its own: an edit's card shows what it would write
  await composer.fill(WRITE);
  await composer.press("Enter");
  const ask = chat.getByTestId("ask-permission");
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await expect(ask.getByTestId("diff")).toHaveText("+x");
  await ask.getByTestId("permission-why").fill("call it notes.txt instead");
  await expect(ask.getByTestId("permission-deny")).toHaveText("Deny and say why");
  await ask.getByTestId("permission-why").press("Enter");
  await waitFor(async () =>
    replies().some((r) => r.behavior === "deny" && r.message === "call it notes.txt instead"),
  );
});

test("the mode is a menu: every mode the session can take, said in a line, and the pick goes to claude", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const button = chat.getByTestId("chat-mode");
  // before claude is up the button says nothing it does not know
  await expect(button).toHaveText("Mode");
  await button.click();
  const menu = chat.getByTestId("mode-menu");
  // opening it starts claude, which is what knows the mode: the recording started in bypass
  await expect(menu.getByTestId("menu-item")).toHaveText([
    /^Manual.*Asks before each edit and command/,
    /^Accept edits/,
    /^Plan.*changes nothing until you approve/,
    /^Bypass permissions.*Runs every tool without asking/,
  ]);
  await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveAttribute(
    "data-key",
    "bypassPermissions",
  );
  await expect(menu).toContainText("⇧⇥ to switch");
  // the keyboard: up from bypass is plan, Enter takes it
  await menu.press("ArrowUp");
  await menu.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveAttribute("data-mode", "plan");
  await expect(button).toHaveText("Plan");
  await expect(chat.getByTestId("composer")).toBeFocused();
  const asked = sentToClaude(s.chatLog)
    .map((l) => l.in as { request?: { subtype?: string; mode?: string } } | undefined)
    .filter((m) => m?.request?.subtype === "set_permission_mode");
  expect(asked.map((m) => m?.request?.mode)).toEqual(["plan"]);
  // Esc closes it and changes nothing
  await button.click();
  await expect(menu).toBeVisible();
  await menu.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveText("Plan");
});

test("⌘K runs any action by name, ⌘/ lists every key, and the header's … holds the session's", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await chat.getByTestId("composer").press("Meta+k");
  const palette = chat.getByTestId("chat-palette");
  await expect(palette).toBeVisible();
  await chat.getByTestId("chat-palette-input").fill("perm mode");
  await expect(palette.getByTestId("chat-palette-item").first()).toContainText("Permission mode");
  await chat.getByTestId("chat-palette-input").press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(chat.getByTestId("mode-menu")).toBeVisible();
  await chat.getByTestId("mode-menu").press("Escape");
  // a key runs it from anywhere: the files pane
  await chat.getByTestId("composer").press("Meta+Shift+f");
  await expect(chat.getByTestId("files")).toBeVisible();
  await chat.getByTestId("composer").press("Meta+/");
  const sheet = chat.getByTestId("chat-shortcuts");
  await expect(sheet).toContainText("Model and effort…");
  await expect(sheet).toContainText("⇧⌘E");
  await sheet.press("Escape");
  await expect(sheet).toHaveCount(0);
  // the files pane did not close on that Esc: the sheet took it
  await expect(chat.getByTestId("files")).toBeVisible();
  await chat.getByTestId("chat-more").click();
  await expect(chat.getByTestId("more-menu").getByTestId("menu-item")).toContainText([
    "Open in VS Code",
  ]);
});

test("an answer and a code block copy from a button on hover, and ⇧⌘C copies the last answer", async () => {
  const fx = makeFixture({ withCompanion: true });
  writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ chat: true }));
  const { id, root } = writeProject(fx, { name: "chat-trial" });
  writeSession(fx, {
    cwd: root,
    sessionId: SID,
    title: TITLE,
    prompt: "set the scene",
    reply: "Run this:\n\n```sh\npnpm test retry\n```\n\nIt passes now.",
  });
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: writeFakeClaude(fx.dir).bin });
  await openRow(app.page, id);
  const chat = await chatWindow(app.app, SID);
  const clipboard = () => app.app.evaluate(({ clipboard }) => clipboard.readText());
  const answer = chat.getByTestId("panel-text");
  await answer.hover();
  await answer.getByTestId("answer-actions").getByTestId("copy").click();
  await expect.poll(clipboard).toContain("It passes now.");
  await answer.locator("pre").hover();
  await answer.locator("pre").locator("..").getByTestId("copy").click();
  await expect.poll(clipboard).toBe("pnpm test retry");
  await app.app.evaluate(({ clipboard }) => clipboard.writeText(""));
  await chat.getByTestId("composer").press("Meta+Shift+c");
  await expect.poll(clipboard).toContain("```sh");
});

test("hovering a message says when it was written, and how long ago past a day", async () => {
  const fx = makeFixture({ withCompanion: true });
  writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ chat: true }));
  const { id, root } = writeProject(fx, { name: "chat-trial" });
  writeSession(fx, {
    cwd: root,
    sessionId: SID,
    title: TITLE,
    prompt: "set the scene",
    reply: "Done.",
    ageMs: 3 * 24 * 3_600_000,
  });
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: writeFakeClaude(fx.dir).bin });
  await openRow(app.page, id);
  const chat = await chatWindow(app.app, SID);
  const turn = chat.getByTestId("turn").last();
  const said = turn.getByTestId("panel-prompt");
  await said.hover();
  await expect(turn.getByTestId("message-time").first()).toHaveText(/ · 3 days ago$/);
  // nothing is said while the pointer is elsewhere
  await chat.getByTestId("composer").hover();
  await expect(turn.getByTestId("message-time").first()).toBeHidden();
  const answer = chat.getByTestId("panel-text");
  await answer.hover();
  await expect(answer.getByTestId("message-time")).toHaveText(/ · 3 days ago$/);
});

test("up and down walk what was said in the session, and Latest brings back the end", async () => {
  const fx = makeFixture({ withCompanion: true });
  writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ chat: true }));
  const { id, root } = writeProject(fx, { name: "chat-trial" });
  // a long answer: the conversation scrolls
  const paragraphs = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of the answer.`);
  writeSession(fx, {
    cwd: root,
    sessionId: SID,
    title: TITLE,
    prompt: "set the scene",
    reply: paragraphs.join("\n\n"),
  });
  app = await launchApp(fx, {
    GROVE_CLAUDE_BIN: writeFakeClaude(fx.dir).bin,
    GROVE_FAKE_CHAT_DELAY_MS: "20",
  });
  await openRow(app.page, id);
  const chat = await chatWindow(app.app, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(chat.getByTestId("panel-text")).toContainText("hello from the spike", {
    timeout: 20_000,
  });
  await expect(chat.getByTestId("chat-stop")).toHaveCount(0, { timeout: 20_000 });
  // what is being typed is kept: up walks back, down past the newest gives it back
  await composer.fill("half typed");
  await composer.press("Home");
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue(HELLO);
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("set the scene");
  await composer.press("ArrowDown");
  await expect(composer).toHaveValue(HELLO);
  await composer.press("ArrowDown");
  await expect(composer).toHaveValue("half typed");
  // scrolled up a long way: Latest, and ⌘↓, go back to the end
  const conversation = chat.getByTestId("conversation");
  await conversation.evaluate((el) => el.scrollTo({ top: 0 }));
  await chat.getByTestId("chat-latest").click();
  await expect(chat.getByTestId("chat-latest")).toHaveCount(0);
  const atEnd = () =>
    conversation.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  await expect.poll(atEnd).toBe(true);
  await conversation.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(chat.getByTestId("chat-latest")).toBeVisible();
  await composer.press("Meta+ArrowDown");
  await expect.poll(atEnd).toBe(true);
});

test("⌘F in a chat window finds in its conversation, and the main window stays where it is", async () => {
  const fx = makeFixture({ withCompanion: true });
  writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ chat: true }));
  const { id, root } = writeProject(fx, { name: "chat-trial" });
  const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} says retry.`);
  writeSession(fx, {
    cwd: root,
    sessionId: SID,
    title: TITLE,
    prompt: "set the scene",
    reply: paragraphs.join("\n\n"),
  });
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: writeFakeClaude(fx.dir).bin });
  await openRow(app.page, id);
  const chat = await chatWindow(app.app, SID);
  await chat.bringToFront();
  await chat.getByTestId("composer").press("Meta+f");
  const find = chat.getByTestId("find");
  await expect(find).toBeVisible();
  await expect(chat.getByTestId("find-input")).toBeFocused();
  await chat.getByTestId("find-input").fill("retry");
  await expect(chat.getByTestId("find-count")).toHaveText("1 of 60");
  await chat.getByTestId("find-input").press("Enter");
  await expect(chat.getByTestId("find-count")).toHaveText("2 of 60");
  await chat.getByTestId("find-input").press("Shift+Enter");
  await chat.getByTestId("find-input").press("Shift+Enter");
  await expect(chat.getByTestId("find-count")).toHaveText("60 of 60");
  await chat.getByTestId("find-input").fill("nowhere");
  await expect(chat.getByTestId("find-count")).toHaveText("None");
  // the main window's own search was not touched
  await expect(app.page.locator("#search")).not.toBeFocused();
  await chat.getByTestId("find-input").press("Escape");
  await expect(find).toHaveCount(0);
  await expect(chat.getByTestId("composer")).toBeFocused();
});

test("a refusal is a card that switches models or gives the prompt back, and a failed turn can be tried again", async () => {
  // the hello turn, with claude code asking first what to do about a refusal (vs code's shape)
  const rec = path.join(makeFixture({}).dir, "recordings");
  mkdirSync(rec, { recursive: true });
  const fixtures = path.join(import.meta.dirname, "../test/fixtures/chat");
  const lines = readFileSync(path.join(fixtures, "turn.jsonl"), "utf8").split("\n").filter(Boolean);
  const at = lines.findIndex((l) => JSON.parse(l).msg?.type === "assistant");
  lines.splice(
    at,
    0,
    JSON.stringify({
      t: JSON.parse(lines[at] as string).t,
      dir: "out",
      msg: {
        type: "control_request",
        request_id: "dlg-1",
        request: {
          subtype: "request_user_dialog",
          dialog_kind: "refusal_fallback_prompt",
          payload: { originalModel: "claude-opus-5-5", fallbackModel: "claude-sonnet-5" },
        },
      },
    }),
  );
  writeFileSync(path.join(rec, "turn.jsonl"), `${lines.join("\n")}\n`);
  const s = seed(true);
  // the session's last turn died on an api error
  const file = writeSession(s.fx, {
    cwd: s.root,
    sessionId: SID,
    title: TITLE,
    prompt: "set the scene",
  });
  const stamp = new Date().toISOString();
  const env = {
    isSidechain: false,
    userType: "external",
    cwd: s.root,
    sessionId: SID,
    version: "2.1.296",
    timestamp: stamp,
  };
  writeFileSync(
    file,
    `${[
      {
        type: "user",
        ...env,
        uuid: "f0000000-0000-4000-8000-000000000011",
        message: { role: "user", content: [{ type: "text", text: "try the migration" }] },
      },
      {
        type: "assistant",
        ...env,
        uuid: "f0000000-0000-4000-8000-000000000012",
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          id: "synthetic-1",
          model: "<synthetic>",
          content: [{ type: "text", text: "API Error: 529 Overloaded" }],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")}\n`,
    { flag: "a" },
  );
  const { app: electron, page } = await launch(s, { GROVE_FAKE_CHAT_RECORDINGS: rec });
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await expect(chat.getByTestId("turn-note").last()).toContainText("API Error: 529");
  await chat.getByTestId("turn-retry").click();
  await waitFor(async () =>
    sentToClaude(s.chatLog).some(
      (l) =>
        (l.in as { message?: { content?: Array<{ text?: string }> } })?.message?.content?.[0]
          ?.text === "try the migration",
    ),
  );
  // the recording's turn plays: claude code asks about a refusal first
  const card = chat.getByTestId("ask-refusal");
  await expect(card).toContainText("Opus 5.5 turned this request down", { timeout: 15_000 });
  await expect(card.getByTestId("refusal-switch")).toHaveText("Switch to Sonnet 5");
  // claude raises no hook for a dialog: grove chat puts it in needs-you itself, until it goes
  const g = groveTest(electron);
  const paused = async () =>
    (await g.trayMenu()).some((i) => i.sublabel?.includes("Session paused") === true);
  await expect.poll(paused, { timeout: 15_000 }).toBe(true);
  await card.getByTestId("refusal-edit").click();
  await expect.poll(paused).toBe(false);
  await expect(chat.getByTestId("composer")).toHaveValue("try the migration");
  await waitFor(async () =>
    sentToClaude(s.chatLog).some(
      (l) =>
        (l.in as { response?: { response?: { result?: string } } })?.response?.response?.result ===
        "edit_prompt",
    ),
  );
});

test("where the api refuses clearing old reads, claude starts again without it and the message can be tried again", async () => {
  const s = seed(true);
  // the fake answers every message as the api does a context_management it does not take
  const { app: electron, page } = await launch(s, { GROVE_FAKE_CHAT_REFUSE_EXTRA_BODY: "1" });
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(chat.getByTestId("turn-note").last()).toContainText(
    "API Error: 400 context_management",
  );
  await expect(chat.getByTestId("chat-error")).toContainText(
    "The API refused clearing old reads here, so Claude restarted without it.",
  );
  // the first claude had the extra body, the one after it does not, on the same session
  const starts = sentToClaude(s.chatLog).filter((l) => l.argv) as Array<{
    argv: string[];
    env: { extraBody?: string };
  }>;
  expect(starts).toHaveLength(2);
  expect(JSON.parse(starts[0]?.env.extraBody ?? "{}").context_management.edits).toHaveLength(2);
  expect(starts[1]?.env.extraBody).toBeUndefined();
  expect(starts[1]?.argv).toContain(`--resume=${SID}`);
  // tried again, it answers, and the line goes with the turn it was about
  await chat.getByTestId("turn-retry").click();
  await expect(chat.getByTestId("panel-text").last()).toContainText("hello from the spike");
  await expect(chat.getByTestId("chat-error")).toHaveCount(0);
});

test("a long tool offers to run in the background, and goes there", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await chat.getByTestId("composer").fill(BACKGROUND);
  await chat.getByTestId("composer").press("Enter");
  const link = chat.getByTestId("chat-background");
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await waitFor(async () =>
    sentToClaude(s.chatLog).some(
      (l) => (l.in as { request?: { subtype?: string } })?.request?.subtype === "background_tasks",
    ),
  );
  await expect(chat.getByTestId("chat-stop")).toHaveCount(0, { timeout: 20_000 });
});

test("/model and /plan are the window's own: they open its menu and set its mode, not go to claude", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill("/model");
  // the / menu is open on what was typed: Esc leaves it, Enter sends
  await composer.press("Escape");
  await composer.press("Enter");
  await expect(chat.getByTestId("model-menu")).toBeVisible();
  await expect(composer).toHaveValue("");
  await chat.getByTestId("model-menu").press("Escape");
  await composer.fill("/plan");
  await composer.press("Escape");
  await composer.press("Enter");
  await expect(chat.getByTestId("chat-mode")).toHaveAttribute("data-mode", "plan");
  const typed = sentToClaude(s.chatLog).filter((l) => (l.in as { type?: string })?.type === "user");
  expect(typed).toEqual([]);
});

test("a click on the title renames the session, through its claude, and the list follows", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  // claude up first: the name goes through it
  await chat.getByTestId("composer").press("a");
  await expect(chat.getByTestId("chat-mode")).not.toHaveText("Mode");
  await chat.getByTestId("chat-title").click();
  const field = chat.getByTestId("chat-rename");
  await expect(field).toBeFocused();
  // Esc keeps the name
  await field.fill("not this");
  await field.press("Escape");
  await expect(chat.getByTestId("chat-title")).toHaveText(TITLE);
  await chat.getByTestId("composer").press("Meta+Shift+r");
  await chat.getByTestId("chat-rename").fill("the retry loop");
  await chat.getByTestId("chat-rename").press("Enter");
  await expect(chat.getByTestId("chat-title")).toHaveText("the retry loop");
  await expect.poll(() => chat.title()).toBe("the retry loop · chat-trial");
  await waitFor(async () =>
    sentToClaude(s.chatLog).some(
      (l) =>
        (l.in as { request?: { subtype?: string; title?: string } })?.request?.title ===
        "the retry loop",
    ),
  );
  // claude code kept it: the main window's row says it
  await expect(page.locator(`[data-testid="session-row"][data-id="${SID}"]`)).toContainText(
    "the retry loop",
    { timeout: 15_000 },
  );
});

test("the keyboard reaches the model menu's effort and ultracode, not only its rows", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await chat.getByTestId("composer").press("Meta+Shift+e");
  const menu = chat.getByTestId("model-menu");
  await expect(menu.getByTestId("effort")).toBeVisible({ timeout: 15_000 });
  // Tab walks past the rows into the effort levels, Enter picks one
  const rows = await menu.getByTestId("menu-item").count();
  for (let i = 0; i <= rows; i++) await chat.keyboard.press("Tab");
  await expect(menu.getByTestId("effort-low")).toBeFocused();
  await chat.keyboard.press("Enter");
  await expect(menu.getByTestId("effort-low")).toHaveAttribute("aria-checked", "true");
  // on to the switch, and Space turns ultracode on
  for (let i = 0; i < 5; i++) await chat.keyboard.press("Tab");
  await expect(menu.getByTestId("ultracode")).toBeFocused();
  await chat.keyboard.press("Space");
  await expect(chat.getByTestId("ultra-chip")).toBeVisible();
  // the menu stayed open for all of it; Esc closes it
  await chat.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("older turns show on asking, and the conversation copies or exports as markdown", async () => {
  const fx = makeFixture({ withCompanion: true });
  writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ chat: true }));
  const { id, root } = writeProject(fx, { name: "chat-trial" });
  const file = writeSession(fx, {
    cwd: root,
    sessionId: SID,
    title: TITLE,
    prompt: "set the scene",
  });
  // 120 more turns: the window opens on the last 100
  const env = {
    isSidechain: false,
    userType: "external",
    cwd: root,
    sessionId: SID,
    version: "2.1.296",
  };
  const at = (n: number) => new Date(Date.now() - 50_000 + n * 100).toISOString();
  const more = Array.from({ length: 120 }, (_, n) => [
    {
      type: "user",
      ...env,
      uuid: `e0000000-0000-4000-8000-${String(2 * n).padStart(12, "0")}`,
      timestamp: at(2 * n),
      message: { role: "user", content: [{ type: "text", text: `question ${n}` }] },
    },
    {
      type: "assistant",
      ...env,
      uuid: `e0000000-0000-4000-8000-${String(2 * n + 1).padStart(12, "0")}`,
      timestamp: at(2 * n + 1),
      message: {
        role: "assistant",
        id: `m${n}`,
        model: "claude-opus-5",
        content: [{ type: "text", text: `answer ${n}` }],
      },
    },
  ]).flat();
  writeFileSync(file, `${more.map((l) => JSON.stringify(l)).join("\n")}\n`, { flag: "a" });
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: writeFakeClaude(fx.dir).bin });
  await openRow(app.page, id);
  const chat = await chatWindow(app.app, SID);
  await expect(chat.getByTestId("turn")).toHaveCount(100);
  await chat.getByTestId("chat-older").click();
  await expect(chat.getByTestId("turn")).toHaveCount(121);
  await expect(chat.getByTestId("chat-older")).toHaveCount(0);
  // all of it, as markdown, on the clipboard
  await chat.getByTestId("composer").press("Meta+Alt+Shift+c");
  const clipboard = () => app.app.evaluate(({ clipboard }) => clipboard.readText());
  await expect.poll(clipboard).toContain("## You\n\nquestion 119\n\n## Claude\n\nanswer 119");
  expect(await clipboard()).toContain("## You\n\nset the scene");
  // and into a file the person picks
  const out = path.join(fx.dir, "exported.md");
  await app.app.evaluate(({ dialog }, to) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: to })) as never;
  }, out);
  await chat.getByTestId("composer").press("Meta+Shift+s");
  await expect(chat.getByTestId("chat-note")).toContainText("Saved to");
  expect(readFileSync(out, "utf8")).toContain(`# ${TITLE}`);
});

test("the … menu lists the MCP servers, and a failed one is tried again", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await chat.getByTestId("chat-more").click();
  await chat.getByTestId("more-menu").locator('[data-key="mcp"]').click();
  const menu = chat.getByTestId("mcp-menu");
  await expect(menu.getByTestId("menu-item")).toHaveText(
    [/figma\s*Connected/, /sentry\s*Failed: connect ECONNREFUSED/],
    { timeout: 15_000 },
  );
  await menu.locator('[data-key="sentry"]').click();
  await expect(menu.locator('[data-key="sentry"]')).toContainText("Connected");
  expect(
    sentToClaude(s.chatLog).some(
      (l) =>
        (l.in as { request?: { subtype?: string; serverName?: string } })?.request?.serverName ===
        "sentry",
    ),
  ).toBe(true);
});

test("a long paste becomes a chip that goes with the message, and an attached image opens full size", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  const log = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  await composer.fill("what does this log say?");
  await composer.evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, log);
  await expect(chat.getByTestId("paste-chip")).toHaveText(/Pasted text.*60 lines/);
  await expect(composer).toHaveValue("what does this log say?");
  // an image dropped in opens full size from its thumbnail, and Esc closes it
  await chat.evaluate((b64) => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "shot.png", {
        type: "image/png",
      }),
    );
    document
      .querySelector('[data-testid="conversation"]')
      ?.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==");
  // the tiny test image sits mostly under its remove button: the click goes to its corner
  await chat.getByTestId("chip-view").click({ position: { x: 3, y: 36 } });
  await expect(chat.getByTestId("lightbox")).toBeVisible();
  await chat.keyboard.press("Escape");
  await expect(chat.getByTestId("lightbox")).toHaveCount(0);
  await chat.getByTestId("chip-remove").first().click({ force: true });
  await composer.press("Enter");
  await waitFor(async () =>
    sentToClaude(s.chatLog).some((l) => {
      const c = (l.in as { type?: string; message?: { content?: Array<{ text?: string }> } })
        ?.message?.content;
      return !!c?.some((b) => b.text?.startsWith("what does this log say?\n\nline 1\nline 2"));
    }),
  );
  await expect(chat.getByTestId("paste-chip")).toHaveCount(0);
});

test("fast mode and thinking are switches on the models that have them, and the output style is a menu", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await chat.getByTestId("chat-model").click();
  const menu = chat.getByTestId("model-menu");
  // haiku 5.5: no fast mode, and it always thinks
  await expect(menu.getByTestId("effort")).toBeVisible({ timeout: 15_000 });
  await expect(menu.getByTestId("fast")).toHaveCount(0);
  await expect(menu.getByTestId("thinking")).toHaveCount(0);
  await menu.locator('[data-key="opus"]').click();
  await chat.getByTestId("chat-model").click();
  await chat.getByTestId("model-menu").getByTestId("fast").click();
  await expect(chat.getByTestId("model-menu").getByTestId("fast")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await chat.getByTestId("model-menu").press("Escape");
  // haiku 4.5 can answer without thinking
  await chat.getByTestId("chat-model").click();
  await chat.getByTestId("model-menu").locator('[data-key="claude-haiku-4-5-20251001"]').click();
  await chat.getByTestId("chat-model").click();
  await chat.getByTestId("model-menu").getByTestId("thinking").click();
  await waitFor(async () =>
    sentToClaude(s.chatLog).some(
      (l) =>
        (l.in as { request?: { subtype?: string; max_thinking_tokens?: number } })?.request
          ?.max_thinking_tokens === 0,
    ),
  );
  await chat.getByTestId("model-menu").press("Escape");
  // the output style, from the … menu
  await chat.getByTestId("chat-more").click();
  await chat.getByTestId("more-menu").locator('[data-key="style"]').click();
  await chat.getByTestId("style-menu").locator('[data-key="Explanatory"]').click();
  await waitFor(async () =>
    sentToClaude(s.chatLog).some(
      (l) =>
        (l.in as { request?: { settings?: { outputStyle?: string } } })?.request?.settings
          ?.outputStyle === "Explanatory",
    ),
  );
});

test("a message's hover actions: rewind its files, edit and send it again, or fork from an answer", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(chat.getByTestId("panel-text")).toContainText("hello from the spike", {
    timeout: 15_000,
  });
  await expect(chat.getByTestId("chat-stop")).toHaveCount(0, { timeout: 15_000 });
  const turn = chat.getByTestId("turn").last();
  // rewind: what it would do is asked and said first
  let asked = "";
  chat.once("dialog", (d) => {
    asked = d.message();
    void d.accept();
  });
  await turn.hover();
  await turn.getByTestId("prompt-rewind").click();
  await expect(chat.getByTestId("chat-note")).toHaveText("Put back 1 file.");
  expect(asked).toContain("Put 1 file back as they were before that message? (+1 -1)");
  const rewinds = sentToClaude(s.chatLog)
    .map(
      (l) =>
        (l.in as { request?: { subtype?: string; dry_run?: boolean; user_message_id?: string } })
          ?.request,
    )
    .filter((r) => r?.subtype === "rewind_files");
  expect(rewinds.map((r) => r?.dry_run)).toEqual([true, false]);
  expect(rewinds[0]?.user_message_id).toMatch(/^[0-9a-f-]{36}$/);
  // edit and send again: a new session from before it, with the words in its composer
  await turn.hover();
  await turn.getByTestId("prompt-edit").click();
  let fork: Page | undefined;
  await waitFor(async () => {
    for (const p of electron.windows()) {
      if (!p.url().includes("#/chat")) continue;
      const id = await p
        .getByTestId("chat")
        .getAttribute("data-id")
        .catch(() => null);
      if (id && id !== SID) {
        fork = p;
        return true;
      }
    }
    return false;
  });
  await expect((fork as Page).getByTestId("composer")).toHaveValue(HELLO);
  // its transcript is this one's up to before that message: the scene-setting turn only
  await expect((fork as Page).getByTestId("turn")).toHaveCount(1, { timeout: 20_000 });
  await expect((fork as Page).getByTestId("turn")).toContainText("set the scene");
  // fork from the answer: a new session with all of it, in a window of its own
  await chat.bringToFront();
  await turn.getByTestId("panel-text").hover();
  await turn.getByTestId("answer-fork").click();
  const chatIds = async () => {
    const ids = new Map<string, Page>();
    for (const p of electron.windows()) {
      const id = p.url().includes("#/chat")
        ? await p
            .getByTestId("chat")
            .getAttribute("data-id")
            .catch(() => null)
        : null;
      if (id) ids.set(id, p);
    }
    return ids;
  };
  await waitFor(async () => (await chatIds()).size >= 3);
  // edit and send again from before the first message, into a cold window: an appearance change
  // just dropped the spare (it comes back 500ms later), so the window loads its page from scratch
  // and still gets the words
  const had = new Set((await chatIds()).keys());
  const pages = new Set(electron.windows());
  await page.evaluate(() => window.grove.updateSettings({ appearance: "dark" }));
  await chat.evaluate(() => window.grove.chatFork(null, "start it again"));
  let cold: Page | undefined;
  await waitFor(async () => {
    for (const [id, p] of await chatIds()) if (!had.has(id)) cold = p;
    return !!cold;
  });
  expect(pages.has(cold as Page)).toBe(false);
  await expect((cold as Page).getByTestId("composer")).toHaveValue("start it again");
});

test("/btw asks on the side: the answer shows beside the conversation and never goes into it", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await chat.getByTestId("composer").press("Meta+Alt+b");
  await expect(chat.getByTestId("composer")).toHaveValue("/btw ");
  await chat.getByTestId("composer").pressSequentially("which file was it?");
  await chat.getByTestId("composer").press("Escape");
  await chat.getByTestId("composer").press("Enter");
  const side = chat.getByTestId("chat-side");
  await expect(side).toContainText("Asked on the side: which file was it?");
  await expect(side).toContainText("On the side: 18 characters asked.", { timeout: 15_000 });
  expect(
    sentToClaude(s.chatLog).filter((l) => (l.in as { type?: string })?.type === "user"),
  ).toEqual([]);
  await expect(chat.getByTestId("turn")).toHaveCount(1);
});

test("the files pane lists what is not committed, each opening its diff", async () => {
  const s = seed(true);
  // the project is a repo with one change and one new file
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", s.root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
  writeFileSync(path.join(s.root, "retry.ts"), "const a = 1;\nconst b = 2;\n");
  git("add", "retry.ts");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "retry");
  writeFileSync(path.join(s.root, "retry.ts"), "const a = 1;\nconst b = 3;\n");
  writeFileSync(path.join(s.root, "notes.md"), "# notes\n");
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await chat.getByTestId("chat-files").click();
  const changes = chat.getByTestId("changes");
  // grove's own .claude/long-work.md is new in it too
  await expect(changes.getByTestId("change-item").filter({ hasText: "retry.ts" })).toContainText(
    "+1 -1",
  );
  await expect(changes.getByTestId("change-item").filter({ hasText: "notes.md" })).toContainText(
    "new",
  );
  await changes.getByTestId("change-item").filter({ hasText: "retry.ts" }).click();
  const diff = chat.getByTestId("viewer-diff");
  await expect(diff.getByTestId("diff")).toContainText("-const b = 2;");
  await expect(diff.getByTestId("diff")).toContainText("+const b = 3;");
  await chat.getByTestId("viewer-list").click();
  await chat
    .getByTestId("changes")
    .getByTestId("change-item")
    .filter({ hasText: "notes.md" })
    .click();
  await expect(chat.getByTestId("viewer-diff").getByTestId("diff")).toHaveText("+# notes");
});

test("a file picked from the session's own folder is a chip, and goes by its own path, not a copy", async () => {
  const s = seed(true);
  const inside = path.join(s.root, "notes.md");
  writeFileSync(inside, "# notes\n");
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await chat.getByTestId("chat-attach").click();
  const chooser = chat.waitForEvent("filechooser");
  await chat.getByTestId("attach-menu").getByTestId("menu-item").first().click();
  await (await chooser).setFiles([inside]);
  const composer = chat.getByTestId("composer");
  await expect(composer).toHaveValue("");
  await expect(chat.getByTestId("chip")).toContainText("notes.md");
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(chat.getByTestId("panel-text")).toContainText("hello from the spike");
  await expect(chat.getByTestId("turn").last().getByTestId("turn-attached")).toHaveText(
    " · notes.md",
  );
  const sent = sentToClaude(s.chatLog)
    .map((l) => l.in as { type?: string; message?: { content?: Array<Record<string, unknown>> } })
    .find((m) => m?.type === "user");
  expect(sent?.message?.content?.[0]?.text).toContain(`\npath: ${inside}\n`);
  expect(sent?.message?.content?.[0]?.text).not.toContain("copy of:");
  expect(existsSync(path.join(uploadsOf(s), SID))).toBe(false);
});

test("the context ring shows once the conversation is half full, and compacts from its menu", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s, { GROVE_FAKE_CHAT_CONTEXT: "700000" });
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await expect(chat.getByTestId("chat-context")).toHaveCount(0);
  await chat.getByTestId("composer").press("a");
  const ring = chat.getByTestId("chat-context");
  await expect(ring).toHaveText("72%");
  await ring.click();
  await expect(chat.getByTestId("context-menu")).toContainText("700k of 967k tokens");
  await chat.getByTestId("context-menu").getByTestId("menu-item").click();
  await waitFor(async () =>
    sentToClaude(s.chatLog).some(
      (l) =>
        (l.in as { type?: string; message?: { content?: Array<{ text?: string }> } })?.type ===
          "user" &&
        (l.in as { message: { content: Array<{ text?: string }> } }).message.content[0]?.text ===
          "/compact",
    ),
  );
  // the draft was left alone
  await expect(chat.getByTestId("composer")).toHaveValue("a");
});

test("the model is a menu with the model's own effort levels and ultracode, read back from claude", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const button = chat.getByTestId("chat-model");
  await button.click();
  const menu = chat.getByTestId("model-menu");
  await expect(menu.getByTestId("menu-item")).toHaveCount(5);
  // claude says it is on haiku at medium
  await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toContainText("Haiku");
  await expect(button).toHaveText(/Haiku.*· Medium/);
  await expect(menu.getByTestId("effort").getByRole("radio")).toHaveText([
    "Low",
    "Medium",
    "High",
    "Extra high",
    "Max",
  ]);
  await menu.getByTestId("effort-max").click();
  await expect(button).toHaveText(/· Max/);
  await expect(menu).toContainText("Max can run long");
  await menu.getByTestId("ultracode").click();
  await expect(chat.getByTestId("ultra-chip")).toBeVisible();
  await menu.getByTestId("effort-high").click();
  await expect(button).toHaveText(/· High/);
  // ultracode stayed on: the level went with it
  await expect(chat.getByTestId("ultra-chip")).toBeVisible();
  const applies = sentToClaude(s.chatLog)
    .map((l) => (l.in as { request?: { subtype?: string; settings?: unknown } })?.request)
    .filter((r) => r?.subtype === "apply_flag_settings")
    .map((r) => r?.settings);
  expect(applies).toEqual([
    { effortLevel: "max" },
    { ultracode: true },
    { effortLevel: "high", ultracode: true },
  ]);
  // a model with no effort and no ultracode: both leave the toolbar
  await menu.getByTestId("menu-item").filter({ hasText: "Haiku 4.5" }).click();
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveText("Haiku 4.5");
  await expect(chat.getByTestId("ultra-chip")).toHaveCount(0);
  await button.click();
  await expect(menu.getByTestId("effort")).toHaveCount(0);
  await expect(menu.getByTestId("ultracode")).toHaveCount(0);
});

test("closing the window leaves the turn running under grove, and reopening it picks it up", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  let chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(COUNT);
  await composer.press("Enter");
  await expect(chat.getByTestId("panel-text")).toContainText("3");
  await expect(chat.getByTestId("state")).toHaveAttribute("data-state", "working");

  await electron.evaluate(({ BrowserWindow }, title) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === title)
      ?.close();
  }, `${TITLE} · chat-trial`);
  await waitFor(async () => !electron.windows().some((p) => p.isClosed() === false && p === chat));
  // still going: the main window says so
  await expect(
    page.locator(`[data-testid="session-row"][data-id="${SID}"] [data-testid="runtime-chip"]`),
  ).toHaveAttribute("data-runtime", "grove");

  await openRow(page, s.id);
  chat = await chatWindow(electron, SID);
  // the answer so far, from the host, and still working
  await expect(chat.getByTestId("panel-text")).toContainText("1\n2\n3");
  await expect(chat.getByTestId("state")).toHaveAttribute("data-state", "working");
  // Esc stops it
  await chat.getByTestId("composer").press("Escape");
  await expect(chat.getByTestId("state")).toHaveCount(0);
  await expect(chat.getByTestId("turn").last()).toContainText("Interrupted");
});

test("send turns into stop while a turn runs, and stop ends the turn", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await expect(chat.getByTestId("chat-send")).toBeVisible();
  await composer.fill(COUNT);
  await composer.press("Enter");
  await expect(chat.getByTestId("panel-text")).toContainText("3");
  const stop = chat.getByTestId("chat-stop");
  await expect(stop).toBeVisible();
  // the header says for how long, as a clock
  await expect(chat.getByTestId("chat-elapsed")).toHaveText(/^\d+:\d\d$/);
  // typing gives send back: what is typed now queues
  await composer.fill("and then?");
  await expect(stop).toHaveCount(0);
  await composer.fill("");
  await stop.click();
  await expect(chat.getByTestId("state")).toHaveCount(0);
  await expect(chat.getByTestId("turn").last()).toContainText("Interrupted");
  await expect(chat.getByTestId("chat-send")).toBeVisible();
  const asked = sentToClaude(s.chatLog).map(
    (l) => l.in as { request?: { subtype?: string } } | undefined,
  );
  expect(asked.filter((m) => m?.request?.subtype === "interrupt")).toHaveLength(1);
});

test("while it works, the live line says which tool, on what, and for how long", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s, { GROVE_FAKE_CHAT_TOOL_MS: "2500" });
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(AGENTS);
  await composer.press("Enter");
  const live = chat.getByTestId("chat-live");
  await expect(live).toContainText("sleep 5 && echo main-done", { timeout: 20_000 });
  await expect(live.getByTestId("chat-tool")).toHaveText("Bash");
  await expect(live).toContainText(/\d+s$/);
});

test("thinking: said while it thinks, then folded above the answer until opened", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s, { GROVE_FAKE_CHAT_DELAY_MS: "500" });
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(THINK);
  await composer.press("Enter");
  await expect(chat.getByTestId("chat-thinking")).toContainText("Thinking");
  await expect(chat.getByTestId("panel-text")).toHaveText("735");
  const thought = chat.getByTestId("turn").last().getByTestId("thought");
  await expect(thought).toHaveText(/^Thought/);
  await expect(chat.getByTestId("thought-text")).toHaveCount(0);
  await thought.getByRole("button").click();
  await expect(chat.getByTestId("thought-text")).toContainText("23 times 19 is 437");
});

test("a turn's steps open from its work line: each tool and what it acted on", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(AGENTS);
  await composer.press("Enter");
  const turn = chat.getByTestId("turn").nth(1);
  const toggle = turn.getByTestId("turn-steps-toggle");
  // done: its work line, not its last message. the agents' reports have no prompt of their own,
  // so they land in this turn as later messages, sooner on a fast machine than on a slow one
  await expect(toggle).toHaveText(/^3 steps · \d/, { timeout: 20_000 });
  await expect(turn.getByTestId("steps")).toHaveCount(0);
  await toggle.click();
  await expect(turn.getByTestId("step")).toHaveText([
    /^Agent\s*slow lister/,
    /^Agent\s*long sleeper/,
    /^Bash\s*sleep 5 && echo main-done/,
  ]);
  // the main window's panel is the session card with grove chat on: no turns, no steps to open
  await page.bringToFront();
  await page.locator(`[data-testid="session-row"][data-id="${SID}"]`).click();
  await expect(page.getByTestId("session-card")).toBeVisible();
  await expect(page.getByTestId("session-panel").getByTestId("turn")).toHaveCount(0);
  await expect(page.getByTestId("session-panel").getByTestId("turn-steps-toggle")).toHaveCount(0);
});

test("a turn reads in order: each thing claude said in full, the steps between them folded", async () => {
  const s = seed(true);
  const link = "https://claude.ai/code/artifact/5c6ce80e-62a5-4f85-9d6a-6e91bc9e31fb";
  const outline = `outline up: ${link} - now orienting on the stack`;
  appendTurn(
    s.file,
    { sessionId: SID, cwd: s.root },
    {
      prompt: "write the stack up in a doc",
      tools: [
        { name: "Bash", input: { command: "git log --oneline" }, said: outline },
        { name: "Bash", input: { command: "gh pr list" } },
        { name: "Grep", input: { pattern: "req.body.scope" }, said: "the stack section is in" },
      ],
      reply: "Two need a change before they merge.",
    },
  );
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const turn = chat.getByTestId("turn").last();
  await expect(chat.getByTestId("panel-text")).toHaveText("Two need a change before they merge.");
  // what it said on the way is full-weight markdown, its link live
  await expect(turn.getByTestId("turn-said")).toHaveText([outline, "the stack section is in"]);
  await expect(turn.getByRole("link", { name: link })).toHaveAttribute("href", link);
  // the steps between are folded where they ran, the work line over them all
  const folds = turn.getByTestId("step-fold");
  await expect(folds).toHaveText(["2 steps", "1 step"]);
  await expect(turn.getByTestId("steps")).toHaveCount(0);
  await folds.first().getByRole("button").click();
  await expect(turn.getByTestId("step")).toHaveText([/^Bash\s*git log/, /^Bash\s*gh pr list/]);
  await turn.getByTestId("turn-steps-toggle").click();
  await expect(turn.getByTestId("steps")).toHaveCount(2);
  await expect(turn.getByTestId("step")).toHaveCount(3);
  await turn.getByTestId("turn-steps-toggle").click();
  await expect(turn.getByTestId("steps")).toHaveCount(0);
  // the answer stays last, and copying it copies only the answer. his clipboard goes back after
  const clipboard = () => electron.evaluate(({ clipboard }) => clipboard.readText());
  const was = await clipboard();
  await turn.getByTestId("panel-text").hover();
  await turn.getByRole("button", { name: "Copy answer" }).click();
  await expect.poll(clipboard).toBe("Two need a change before they merge.");
  await electron.evaluate(({ clipboard }, text) => clipboard.writeText(text), was);
});

test("agents: a count in the header, a list in the drawer with a stop each, and each one's own transcript", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s, { GROVE_FAKE_CHAT_TOOL_MS: "4000" });
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(AGENTS);
  await composer.press("Enter");
  // both started in the background: the header says so while they run
  const count = chat.getByTestId("chat-agents");
  await expect(count).toHaveText(/2 agents/, { timeout: 20_000 });
  await count.click();
  const rows = chat.getByTestId("agent-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("long sleeper");
  await expect(rows.first().getByTestId("agent-state")).toHaveAttribute("data-state", "running");
  // one stops from its own row, and only that one
  await chat
    .getByTestId("agent-row")
    .filter({ hasText: "long sleeper" })
    .locator("..")
    .getByTestId("agent-stop")
    .click();
  await waitFor(async () =>
    sentToClaude(s.chatLog).some(
      (l) => (l.in as { request?: { subtype?: string } })?.request?.subtype === "stop_task",
    ),
  );
  const stopped = sentToClaude(s.chatLog)
    .map((l) => (l.in as { request?: { subtype?: string; task_id?: string } })?.request)
    .filter((r) => r?.subtype === "stop_task");
  expect(stopped.map((r) => r?.task_id)).toEqual(["a4937abaedd25e9dd"]);
  expect(
    sentToClaude(s.chatLog).some(
      (l) => (l.in as { request?: { subtype?: string } })?.request?.subtype === "interrupt",
    ),
  ).toBe(false);
  // both end as the recording has them
  await expect(chat.getByTestId("agent-state")).toHaveText([/^Stopped/, /^Done/], {
    timeout: 30_000,
  });
  await expect(count).toHaveCount(0);
  // a row opens the agent's own transcript: what it was asked, what it ran, what it said
  await rows.filter({ hasText: "slow lister" }).click();
  const viewer = chat.getByTestId("agent-viewer");
  await expect(viewer.getByTestId("panel-prompt")).toContainText("sleep 4 && ls");
  await expect(viewer.getByTestId("step")).toContainText(["Bash"]);
  await expect(viewer.getByTestId("panel-text")).toContainText("produced no output");
  await viewer.getByTestId("agent-list").click();
  await expect(rows).toHaveCount(2);
  // the turn's Agent step opens its agent too
  await chat.getByTestId("agents-close").click();
  const turn = chat.getByTestId("turn").nth(1);
  await turn.getByTestId("turn-steps-toggle").click();
  await turn.getByTestId("step").filter({ hasText: "long sleeper" }).click();
  await expect(chat.getByTestId("agent-viewer")).toHaveAttribute("data-id", "a4937abaedd25e9dd");
});

test("a workflow shows as one row with its agents under it, stops whole, and each agent opens", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s, { GROVE_FAKE_CHAT_TOOL_MS: "4000" });
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(WORKFLOW);
  await composer.press("Enter");
  const count = chat.getByTestId("chat-agents");
  await expect(count).toHaveText(/1 workflow/, { timeout: 20_000 });
  await count.click();
  const flow = chat.getByTestId("workflow");
  await expect(flow.getByTestId("workflow-row")).toContainText("six agents one after another");
  await expect(flow.getByTestId("agent-row")).toHaveText([/step 1/]);
  // the workflow stops, not one of its agents
  await expect(flow.getByTestId("agent-row").getByTestId("agent-stop")).toHaveCount(0);
  await flow.getByTestId("agent-stop").click();
  await waitFor(async () =>
    sentToClaude(s.chatLog).some(
      (l) => (l.in as { request?: { subtype?: string } })?.request?.subtype === "stop_task",
    ),
  );
  const stopped = sentToClaude(s.chatLog)
    .map((l) => (l.in as { request?: { subtype?: string; task_id?: string } })?.request)
    .filter((r) => r?.subtype === "stop_task");
  expect(stopped.map((r) => r?.task_id)).toEqual(["whjgl3wqb"]);
  await expect(flow.getByTestId("workflow-row").getByTestId("agent-state")).toHaveText(/^Stopped/, {
    timeout: 30_000,
  });
  await expect(count).toHaveCount(0);
  // an agent of it opens its own transcript, like any agent
  await flow.getByTestId("agent-row").filter({ hasText: "step 1" }).click();
  const viewer = chat.getByTestId("agent-viewer");
  await expect(viewer.getByTestId("panel-prompt")).toContainText("Reply with exactly: ok 1");
  await expect(viewer.getByTestId("panel-text")).toContainText("ok 1");
  // the turn names its workflow, and that opens the list
  await chat.getByTestId("agent-viewer-close").click();
  await chat.getByTestId("turn").nth(1).getByTestId("turn-agents").click();
  await expect(chat.getByTestId("workflow")).toHaveCount(1);
});

test("what claude says along the way shows: a command's output, a tool it turned down, and /clear moves the window", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  // /context answers in its own words: the turn keeps them, muted
  await composer.fill("/context");
  await composer.press("Escape");
  await composer.press("Enter");
  await expect(chat.getByTestId("turn-output")).toContainText("Context Usage");
  // dontAsk turned a Write down without asking: a quiet line says so
  await composer.fill(DENIED);
  await composer.press("Enter");
  await expect(chat.getByTestId("chat-note-denied")).toContainText(
    "Write was turned down. Permission to use Write has been denied because Claude Code is running in don't ask mode.",
  );
  await expect(chat.getByTestId("panel-text")).toContainText("I couldn't create");
  // /clear: the same claude goes on as a new session, and the window with it
  await composer.fill("/clear");
  await composer.press("Escape");
  await composer.press("Enter");
  await expect(chat.locator("h1")).toHaveText("New session");
  const id = await chat.getByTestId("chat").getAttribute("data-id");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(id).not.toBe(SID);
  await expect(chat.getByTestId("chat-note-denied")).toHaveCount(0);
  // claude is already up: the window does not say it starts as you type
  await expect(chat.getByTestId("chat-fresh")).toHaveText("A new session in chat-trial.");
  // the old session is no longer grove's
  await expect(
    page.locator(`[data-testid="session-row"][data-id="${SID}"] [data-testid="runtime-chip"]`),
  ).not.toHaveAttribute("data-runtime", "grove");
});

test("a notification click lands in the session's chat window, in front, and it still needs him", async () => {
  const s = seed(true);
  hookEvent(s.fx, SID, "Stop", { last_assistant_message: "Ship it, or wait for review?" });
  const { app: electron } = await launch(s);
  const g = groveTest(electron);
  await expect.poll(() => g.trayTitle(), { timeout: 15_000 }).toBe("1");
  await g.reveal(SID);
  const chat = await chatWindow(electron, SID);
  await expect(chat.locator("h1")).toHaveText(TITLE);
  // which window has the keyboard, as electron has it: a page's own hasFocus() is emulated here
  const front = () =>
    electron.evaluate(({ BrowserWindow }) => {
      const url = BrowserWindow.getFocusedWindow()?.webContents.getURL();
      return url === undefined ? "none" : url.includes("#/chat") ? "chat" : "main";
    });
  await expect.poll(front).toBe("chat");
  // macOS reopening grove for the same click: the chat window stays in front of the main one
  await electron.evaluate(({ app: a }) => {
    a.emit("activate", {}, true);
  });
  await chat.waitForTimeout(300);
  expect(await front()).toBe("chat");
  // landing on it, and its window's focus, are not a reply
  expect(await g.trayTitle()).toBe("1");
  expect(readExecLog(s.fx)).toEqual([]);
});

test("Open in the editor while a turn runs moves it there once the turn is over", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(COUNT);
  await composer.press("Enter");
  await expect(chat.getByTestId("panel-text")).toContainText("3");
  // Open in the editor lives in the header's … menu
  await chat.getByTestId("chat-more").click();
  await chat.getByTestId("more-menu").locator('[data-key="editor"]').click();
  await chat.getByTestId("move-after").click();
  await expect(chat.getByTestId("chat-note")).toContainText("once this turn has finished");
  // nothing moves while it works
  await page.waitForTimeout(300);
  expect(readExecLog(s.fx)).toEqual([]);
  await composer.press("Escape");
  // the turn is over: grove lets claude go, the editor opens on it, and its chat window closes
  await waitFor(async () => readExecLog(s.fx).length > 0);
  expect(readExecLog(s.fx)[0]?.bin).toBe("code");
  await waitFor(async () => chat.isClosed());
  await expect(
    page.locator(`[data-testid="session-row"][data-id="${SID}"] [data-testid="runtime-chip"]`),
  ).not.toHaveAttribute("data-runtime", "grove");
});

test("quitting while a chat works asks first", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await composer.fill(COUNT);
  await composer.press("Enter");
  await expect(chat.getByTestId("panel-text")).toContainText("3");
  // a test root asks nobody: it counts the question and says yes. the count is taken before the
  // quit goes on, in the same turn of main's event loop
  const asked = await electron.evaluate(({ app: electronApp }) => {
    electronApp.quit();
    return (globalThis as unknown as { groveTest: { quitAsks(): number } }).groveTest.quitAsks();
  });
  expect(asked).toBe(1);
});

test("/ lists claude's commands and skills, and @ the session's files, both by the keyboard", async () => {
  const s = seed(true);
  mkdirSync(path.join(s.root, "plans"), { recursive: true });
  writeFileSync(path.join(s.root, "plans", "grove-chat.md"), "# plan");
  writeFileSync(path.join(s.root, "notes.txt"), "notes");
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");

  // the first key starts claude, which is what knows its commands
  await composer.press("/");
  const menu = chat.getByTestId("suggest");
  await expect(menu).toHaveAttribute("data-kind", "/");
  await expect(menu.getByTestId("suggest-item")).toHaveCount(2);
  await composer.pressSequentially("askm");
  await expect(menu.getByTestId("suggest-item")).toHaveText([/\/ask-matt/]);
  await composer.press("Enter");
  // Enter took the command into the message, and sent nothing
  await expect(composer).toHaveValue("/ask-matt ");
  await expect(menu).toHaveCount(0);

  await composer.pressSequentially("about @grvch");
  await expect(menu).toHaveAttribute("data-kind", "@");
  await expect(menu.getByTestId("suggest-item").first()).toHaveText("plans/grove-chat.md");
  await composer.press("Tab");
  await expect(composer).toHaveValue("/ask-matt about @plans/grove-chat.md ");
  // Esc closes a menu without touching the message
  await composer.pressSequentially("@no");
  await expect(menu).toBeVisible();
  await composer.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(composer).toHaveValue("/ask-matt about @plans/grove-chat.md @no");
  const users = sentToClaude(s.chatLog).filter((l) => (l.in as { type?: string })?.type === "user");
  expect(users).toEqual([]);
});

test("an image dropped or pasted into the composer goes to claude with the message", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==";
  // a drop on the composer, and a paste into it: what the page gets from Finder and a screenshot
  await chat.evaluate((b64) => {
    const file = () =>
      new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "shot.png", {
        type: "image/png",
      });
    const drop = new DataTransfer();
    drop.items.add(file());
    document
      .querySelector("footer")
      ?.dispatchEvent(
        new DragEvent("drop", { dataTransfer: drop, bubbles: true, cancelable: true }),
      );
    const paste = new DataTransfer();
    paste.items.add(file());
    document
      .querySelector('[data-testid="composer"]')
      ?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: paste, bubbles: true, cancelable: true }),
      );
  }, png);
  await expect(chat.getByTestId("composer-files").locator("img")).toHaveCount(2);
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(chat.getByTestId("composer-files")).toHaveCount(0);
  await expect(chat.getByTestId("panel-text")).toContainText("hello from the spike");
  await expect(chat.getByTestId("turn").last()).toContainText("You · 2 images");
  const sent = sentToClaude(s.chatLog)
    .map((l) => l.in as { type?: string; message?: { content?: Array<Record<string, unknown>> } })
    .find((m) => m?.type === "user");
  expect(sent?.message?.content?.map((c) => c.type)).toEqual(["image", "image", "text"]);
  expect(sent?.message?.content?.[0]).toMatchObject({
    source: { type: "base64", media_type: "image/png", data: png },
  });
});

test("files: the + menu's picker, a drop anywhere, chips, and each goes by a path claude reads without asking", async () => {
  const s = seed(true);
  const dir = path.join(s.fx.dir, "attach");
  mkdirSync(dir, { recursive: true });
  const pdf = path.join(dir, "spec.pdf");
  const csv = path.join(dir, "data.csv");
  const docx = path.join(dir, "report.docx");
  writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");
  writeFileSync(csv, "a,b\n1,2\n");
  writeFileSync(docx, "PK not really a docx");
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await chat.getByTestId("chat-attach").click();
  const menu = chat.getByTestId("attach-menu");
  await expect(menu.getByTestId("menu-item")).toHaveText([
    /Upload from computer/,
    /Mention a file/,
  ]);
  // Upload from computer opens the picker: what it hands back is the person's choice
  const chooser = chat.waitForEvent("filechooser");
  await menu.getByTestId("menu-item").first().click();
  await (await chooser).setFiles([pdf, csv, docx]);
  const chips = chat.getByTestId("chip");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText("spec.pdf");
  await expect(chips.nth(1)).toContainText("data.csv");
  // a docx is no type claude takes: it goes by its path, and nothing is typed for it
  await expect(chips.nth(2)).toContainText("report.docx");
  await expect(chips.nth(2)).toContainText("File · 20 B");
  await expect(chips.nth(2)).toHaveAttribute("title", docx);
  await expect(chat.getByTestId("chat-note")).toHaveCount(0);
  const composer = chat.getByTestId("composer");
  await expect(composer).toHaveValue("");
  // a drag over the window says where it lands
  await chat.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "notes.md", { type: "text/markdown" }));
    document
      .querySelector('[data-testid="conversation"]')
      ?.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
  });
  await expect(chat.getByTestId("drop-overlay")).toContainText("Drop to attach");
  await chat.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["# notes"], "notes.md", { type: "text/markdown" }));
    document
      .querySelector('[data-testid="conversation"]')
      ?.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(chat.getByTestId("drop-overlay")).toHaveCount(0);
  await expect(chips).toHaveCount(4);
  // a file the page made has no path: it goes as its bytes
  await expect(chips.nth(3)).toContainText("notes.md");
  await expect(chips.nth(3)).toContainText("File · 7 B");
  // one taken back
  await chips.nth(2).getByTestId("chip-remove").click();
  await expect(chips).toHaveCount(3);
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(chips).toHaveCount(0);
  await expect(chat.getByTestId("panel-text")).toContainText("hello from the spike");
  await expect(chat.getByTestId("turn").last().getByTestId("turn-attached")).toHaveText(
    " · spec.pdf · data.csv · notes.md",
  );
  const sent = sentToClaude(s.chatLog)
    .map((l) => l.in as { type?: string; message?: { content?: Array<Record<string, unknown>> } })
    .find((m) => m?.type === "user");
  // nothing inline: from outside the session's folders a clone in grove's uploads, which
  // claude reads without asking, and the paste written there
  const mine = path.join(uploadsOf(s), SID);
  const content = sent?.message?.content ?? [];
  expect(content.map((c) => c.type)).toEqual(["text", "text", "text", "text"]);
  expect(content[0]?.text).toContain(
    `\npath: ${mine}/spec.pdf\ncopy of: ${pdf}\ntype: application/pdf\nsize: 15 bytes\n`,
  );
  expect(content[1]?.text).toContain(`\npath: ${mine}/data.csv\ncopy of: ${csv}\ntype: text/csv\n`);
  expect(content[2]?.text).toContain(
    `\npath: ${mine}/notes.md\ntype: text/markdown\nsize: 7 bytes\n`,
  );
  expect(content[3]).toEqual({ type: "text", text: HELLO });
  expect(readFileSync(path.join(mine, "spec.pdf"), "utf8")).toBe("%PDF-1.4\n%%EOF\n");
  expect(readFileSync(path.join(mine, "notes.md"), "utf8")).toBe("# notes");
  const [first] = sentToClaude(s.chatLog) as Array<{ argv: string[] }>;
  expect(first?.argv).toContain(`--add-dir=${uploadsOf(s)}`);
  // Mention a file puts an @ where the caret is, and the files menu opens on it
  await chat.getByTestId("chat-attach").click();
  await menu.getByTestId("menu-item").last().click();
  await expect(composer).toHaveValue("@");
  await expect(chat.getByTestId("suggest")).toHaveAttribute("data-kind", "@");
});

test("a video picked or copied in finder goes by its path, as a chip, and shows as one after a reload", async () => {
  const s = seed(true);
  const dir = path.join(s.fx.dir, "media");
  mkdirSync(dir, { recursive: true });
  const clip = path.join(dir, "clip.mp4");
  const zip = path.join(dir, "notes.zip");
  const copied = path.join(dir, "Screen Recording.mov");
  // inside the session's folder: a video is still a chip, only text and pdfs get an @
  const inside = path.join(s.root, "demo.mp4");
  for (const f of [clip, zip, copied, inside]) writeFileSync(f, "not really a video");
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const composer = chat.getByTestId("composer");
  await chat.getByTestId("chat-attach").click();
  const chooser = chat.waitForEvent("filechooser");
  await chat.getByTestId("attach-menu").getByTestId("menu-item").first().click();
  await (await chooser).setFiles([clip, zip, inside]);
  const chips = chat.getByTestId("chip");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText("clip.mp4");
  await expect(chips.nth(0)).toContainText("Video · 18 B");
  await expect(chips.nth(1)).toContainText("notes.zip");
  await expect(chips.nth(1)).toContainText("File · 18 B");
  await expect(chips.nth(2)).toContainText("demo.mp4");
  await expect(composer).toHaveValue("");
  // a copy in finder pastes as a File with its path (probe, electron 44). the page's own input
  // hands one over with its path, as the clipboard does. finder puts the name on the clipboard as
  // a string too: electron 44 does not show it, and a paste that does must not type it in
  await chat.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "copied";
    input.hidden = true;
    document.body.append(input);
  });
  await chat.locator("#copied").setInputFiles(copied);
  const kept = await chat.evaluate(() => {
    const dt = new DataTransfer();
    const file = (document.getElementById("copied") as HTMLInputElement).files?.[0];
    if (file) dt.items.add(file);
    dt.setData("text/plain", "Screen Recording.mov");
    return document
      .querySelector('[data-testid="composer"]')
      ?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
  });
  // the box would type its name in: held back
  expect(kept).toBe(false);
  await expect(chips).toHaveCount(4);
  await expect(chips.nth(3)).toContainText("Screen Recording.mov");
  await expect(chips.nth(3)).toHaveAttribute("title", copied);
  await expect(composer).toHaveValue("");
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(chips).toHaveCount(0);
  await expect(chat.getByTestId("panel-text")).toContainText("hello from the spike");
  const sent = sentToClaude(s.chatLog)
    .map((l) => l.in as { type?: string; message?: { content?: Array<Record<string, unknown>> } })
    .find((m) => m?.type === "user");
  const content = sent?.message?.content ?? [];
  expect(content.map((c) => c.type)).toEqual(["text", "text", "text", "text", "text"]);
  // copies of the ones from elsewhere, so a move in finder does not lose them. the one in the
  // session's folder by its own path
  const mine = path.join(uploadsOf(s), SID);
  expect(content[0]?.text).toContain(
    `path: ${mine}/clip.mp4\ncopy of: ${clip}\ntype: video/mp4\nsize: 18 bytes`,
  );
  expect(content[1]?.text).toContain(`path: ${mine}/notes.zip\ncopy of: ${zip}\n`);
  expect(content[2]?.text).toContain(`path: ${inside}\ntype: video/mp4`);
  expect(content[3]?.text).toContain(
    `path: ${mine}/Screen Recording.mov\ncopy of: ${copied}\ntype: video/quicktime`,
  );
  expect(content[4]).toEqual({ type: "text", text: HELLO });
  expect(existsSync(path.join(mine, "demo.mp4"))).toBe(false);
  // his message names the files and says only what he typed: now, and read back from the transcript
  const turn = chat.getByTestId("turn").last();
  const files = " · clip.mp4 · notes.zip · demo.mp4 · Screen Recording.mov";
  await expect(turn.getByTestId("turn-attached")).toHaveText(files);
  await expect(turn.getByTestId("panel-prompt")).toHaveText(HELLO);
  await chat.reload();
  await expect(chat.getByTestId("panel-text")).toContainText("hello from the spike");
  await expect(chat.getByTestId("turn").last().getByTestId("turn-attached")).toHaveText(files);
  await expect(chat.getByTestId("turn").last().getByTestId("panel-prompt")).toHaveText(HELLO);
});

test("a big pdf or text file has no cap, and an image over 20 MB goes by its path too", async () => {
  const s = seed(true);
  const dir = path.join(s.fx.dir, "big");
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "big.log");
  const pdf = path.join(dir, "big.pdf");
  const png = path.join(dir, "huge.png");
  writeFileSync(log, "x".repeat(600 * 1024));
  writeFileSync(pdf, Buffer.alloc(40 * 1024 * 1024));
  writeFileSync(png, Buffer.alloc(21 * 1024 * 1024));
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await chat.getByTestId("chat-attach").click();
  const chooser = chat.waitForEvent("filechooser");
  await chat.getByTestId("attach-menu").getByTestId("menu-item").first().click();
  await (await chooser).setFiles([log, pdf, png]);
  const chips = chat.getByTestId("chip");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText("File · 600 KB");
  await expect(chips.nth(1)).toContainText("PDF · 40.0 MB");
  await expect(chips.nth(2)).toContainText("Image · 21.0 MB");
  await expect(chat.getByTestId("chat-error")).toHaveCount(0);
  const composer = chat.getByTestId("composer");
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(chat.getByTestId("panel-text")).toContainText("hello from the spike");
  const sent = sentToClaude(s.chatLog)
    .map((l) => l.in as { type?: string; message?: { content?: Array<Record<string, unknown>> } })
    .find((m) => m?.type === "user");
  const content = sent?.message?.content ?? [];
  const mine = path.join(uploadsOf(s), SID);
  expect(content.map((c) => c.type)).toEqual(["text", "text", "text", "text"]);
  expect(content[0]?.text).toContain(`path: ${mine}/big.log\ncopy of: ${log}\n`);
  expect(content[1]?.text).toContain(
    `path: ${mine}/big.pdf\ncopy of: ${pdf}\ntype: application/pdf`,
  );
  expect(content[2]?.text).toContain(`path: ${mine}/huge.png\ncopy of: ${png}\ntype: image/png`);
});

test("cmd-N starts a new session in grove chat, and cmd-shift-N is a new project", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await page.locator(`[data-testid="project-item"][data-id="${s.id}"]`).click();
  await page.keyboard.press("Meta+n");
  let chat: Page | undefined;
  await waitFor(async () => {
    for (const p of electron.windows()) {
      if (
        p.url().includes("#/chat") &&
        (await p.locator("h1", { hasText: "New session" }).count())
      ) {
        chat = p;
        return true;
      }
    }
    return false;
  }, 15_000);
  const c = chat as Page;
  const id = await c.getByTestId("chat").getAttribute("data-id");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(id).not.toBe(SID);
  // nothing to resume: no transcript, and nothing said about one. nothing to open in the editor yet
  await expect(c.getByTestId("chat-gone")).toHaveCount(0);
  await expect(c.getByTestId("chat-fresh")).toContainText("chat-trial");
  await c.getByTestId("chat-more").click();
  await expect(c.getByTestId("more-menu").locator('[data-key="editor"]')).toHaveCount(0);
  await c.getByTestId("more-menu").press("Escape");
  const composer = c.getByTestId("composer");
  await expect(composer).toBeFocused();
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(c.getByTestId("panel-text")).toContainText("hello from the spike");
  // claude started it under grove's id, in the project's folder
  const [first] = sentToClaude(s.chatLog) as Array<{ argv: string[]; cwd: string }>;
  expect(first?.cwd).toBe(s.root);
  expect(first?.argv.join(" ")).toContain(id);
  expect(first?.argv.some((a) => a.startsWith("--resume"))).toBe(false);
  // its transcript is in the list now, and the window shows it as any other session
  await expect(page.locator(`[data-testid="session-row"][data-id="${id}"]`)).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(c.locator("h1")).toHaveText(HELLO);
  await expect(c.getByTestId("turn")).toHaveCount(1);
  await c.getByTestId("chat-more").click();
  await expect(c.getByTestId("more-menu").locator('[data-key="editor"]')).toBeVisible();
  await c.getByTestId("more-menu").press("Escape");
  // the editor's project form moved a key over
  await page.bringToFront();
  await page.keyboard.press("Meta+Shift+n");
  await expect(page.getByTestId("project-form")).toBeVisible();
  expect(readExecLog(s.fx)).toEqual([]);
});

test("chat windows follow the appearance, cascade from the last one, and open at the size it was left", async () => {
  const s = seed(true);
  const SID2 = "cccccccc-0000-4000-8000-000000000002";
  writeSession(s.fx, { cwd: s.root, sessionId: SID2, title: "another", prompt: "and this" });
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const first = await chatWindow(electron, SID);
  // the setting moved while it was open: it draws in the new one at once
  await page.evaluate(() => window.grove.updateSettings({ appearance: "dark" }));
  await expect(first.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.evaluate(() => window.grove.updateSettings({ appearance: "light" }));
  await expect(first.locator("html")).toHaveAttribute("data-theme", "light");

  const bounds = (title: string) =>
    electron.evaluate(
      ({ BrowserWindow }, t) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === t)
          ?.getBounds(),
      title,
    );
  // the person makes it smaller
  await electron.evaluate(({ BrowserWindow }, t) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === t)
      ?.setSize(700, 640);
  }, `${TITLE} · chat-trial`);
  await page.waitForTimeout(700);
  const a = await bounds(`${TITLE} · chat-trial`);
  await page.locator(`[data-testid="session-row"][data-id="${SID2}"]`).dblclick();
  await chatWindow(electron, SID2);
  await expect
    .poll(() => bounds("another · chat-trial"))
    .toMatchObject({ width: 700, height: 640 });
  const b = await bounds("another · chat-trial");
  expect(b?.x).toBe((a?.x ?? 0) + 26);
  expect(b?.y).toBe((a?.y ?? 0) + 26);
});

test("text size: Settings and ⌘+ / ⌘- / ⌘0 grow what is read in every window, never the window's own controls", async () => {
  const s = seed(true);
  const code = `const wait = Math.min(30_000, 100 * 2 ** attempt++); // ${"a long line ".repeat(12)}`;
  appendTurn(
    s.file,
    { sessionId: SID, cwd: s.root },
    {
      prompt: "why does the retry loop spin",
      tools: [{ name: "Bash", input: { command: "rg -n attempt src/ingest" } }],
      reply: [
        "The backoff starts again on every 429.",
        "",
        "```ts",
        code,
        "```",
        "",
        "| attempt | waits |",
        "| --- | --- |",
        "| 1 | 100ms |",
        // enough below it that the conversation scrolls
        ...Array.from({ length: 30 }, (_, i) => `\nParagraph ${i + 1} of the write-up.`),
      ].join("\n"),
    },
  );
  const { app: electron, page } = await launch(s);
  const settingsFile = path.join(s.fx.root, "settings.json");
  const saved = () => JSON.parse(readFileSync(settingsFile, "utf8")).textScale;
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  const answer = chat.getByTestId("panel-text").locator("p").first();
  await expect(answer).toHaveText("The backoff starts again on every 429.");
  const turn = chat.getByTestId("turn").last();
  await turn.getByTestId("turn-steps-toggle").click();
  const px = (l: ReturnType<Page["locator"]>) =>
    l.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  const sizes = async () => ({
    answer: await px(answer),
    code: await px(turn.locator("pre code").first()),
    step: await px(turn.getByTestId("step").first()),
    composer: await px(chat.getByTestId("composer")),
    title: await px(chat.getByTestId("chat-title")),
    model: await px(chat.getByTestId("chat-model")),
  });
  const at = (scale: number) => ({
    answer: 13 * scale,
    code: 11.5 * scale,
    step: 12 * scale,
    composer: 13 * scale,
    title: 13,
    model: 12,
  });
  const close = (got: Record<string, number>, want: Record<string, number>) => {
    for (const k of Object.keys(want)) expect(got[k], k).toBeCloseTo(want[k] as number, 2);
  };
  close(await sizes(), at(1));

  // Settings: the window draws in it at once, and only what is read grows
  await page.bringToFront();
  await page.keyboard.press("Meta+,");
  await page.getByTestId("setting-text-size").selectOption("135");
  await page.getByTestId("save-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
  expect(saved()).toBe(135);
  await expect.poll(async () => (await sizes()).answer).toBeCloseTo(17.55, 2);
  close(await sizes(), at(1.35));
  // line heights are whole px
  expect(await answer.evaluate((el) => getComputedStyle(el).lineHeight)).toBe("27px");

  // the main window's session card follows the same setting, its header does not
  await page.locator(`[data-testid="session-row"][data-id="${SID}"]`).click();
  const tail = page.getByTestId("card-tail").locator("p").first();
  await expect(tail).toBeVisible();
  expect(await px(tail)).toBeCloseTo(17.55, 2);
  expect(await px(page.getByTestId("session-panel").locator("header h2"))).toBe(13);

  // the keys, from the chat window: a step each, saved, and the main window follows too
  // menu keys go to the window that has the keyboard
  await chat.bringToFront();
  const composer = chat.getByTestId("composer");
  await composer.focus();
  // the turn at the top of the conversation stays where it is as the text grows
  const box = chat.getByTestId("conversation");
  const turnTop = () =>
    box.evaluate((el) => {
      const t = [...el.querySelectorAll('[data-testid="turn"]')].at(-1) as HTMLElement;
      return t.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
  await box.evaluate((el) => {
    const t = [...el.querySelectorAll('[data-testid="turn"]')].at(-1) as HTMLElement;
    el.scrollTop += t.getBoundingClientRect().top - el.getBoundingClientRect().top - 16;
  });
  expect(await turnTop()).toBeCloseTo(16, 0);
  await composer.press("Meta+=");
  await expect.poll(saved).toBe(150);
  await expect.poll(async () => (await sizes()).composer).toBeCloseTo(19.5, 2);
  close(await sizes(), at(1.5));
  expect(Math.abs((await turnTop()) - 16)).toBeLessThanOrEqual(1);
  await expect.poll(() => px(tail)).toBeCloseTo(19.5, 2);
  // at the end a key does nothing
  await composer.press("Meta+Shift+=");
  await chat.waitForTimeout(300);
  expect(saved()).toBe(150);

  // at 150%: nothing in the turn is cut off by a fixed height
  const clipped = await chat.getByTestId("conversation").evaluate((box) =>
    [...box.querySelectorAll<HTMLElement>("*")]
      .filter((el) => {
        const o = getComputedStyle(el);
        const hides = /hidden|clip/.test(o.overflowY) || /hidden|clip/.test(o.overflow);
        return hides && el.textContent?.trim() && el.scrollHeight > el.clientHeight + 1;
      })
      .map((el) => `${el.tagName}.${el.className}`),
  );
  expect(clipped).toEqual([]);

  await composer.press("Meta+-");
  await expect.poll(saved).toBe(135);
  // and a window at the end of the conversation stays at its end
  await expect.poll(async () => (await sizes()).composer).toBeCloseTo(17.55, 2);
  await box.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await composer.press("Meta+=");
  await expect.poll(async () => (await sizes()).composer).toBeCloseTo(19.5, 2);
  expect(await box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(
    24,
  );
  await composer.press("Meta+0");
  await expect.poll(saved).toBeUndefined();
  await expect.poll(async () => (await sizes()).composer).toBe(13);
  close(await sizes(), at(1));
  // ⌘+ with shift, as the menu says it
  await composer.press("Meta+Shift+=");
  await expect.poll(saved).toBe(110);

  // and from the dialog back to the default: no setting left in the file
  await page.bringToFront();
  await page.keyboard.press("Meta+,");
  await expect(page.getByTestId("setting-text-size")).toHaveValue("110");
  await page.getByTestId("setting-text-size").selectOption("100");
  await page.getByTestId("save-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
  expect(saved()).toBeUndefined();
  await expect.poll(() => px(tail)).toBe(13);
});

test("⌘K lists the other chat windows: Enter goes to the one looked at last, and ⌘K Enter flips back", async () => {
  const s = seed(true);
  const SID2 = "cccccccc-0000-4000-8000-000000000002";
  writeSession(s.fx, { cwd: s.root, sessionId: SID2, title: "another", prompt: "and this" });
  const { app: electron, page } = await launch(s);
  const focused = () =>
    electron.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle());
  await openRow(page, s.id);
  const first = await chatWindow(electron, SID);
  // the only chat window: its ⌘K is the actions, as before there were windows to list
  await first.getByTestId("composer").press("Meta+k");
  const input = (p: Page) => p.getByTestId("chat-palette-input");
  const items = (p: Page) => p.getByTestId("chat-palette-item");
  await expect(input(first)).toHaveAttribute("placeholder", "Run an action");
  await expect(items(first).first()).toHaveAttribute("data-id", "editor");
  await expect(first.locator('[data-id^="window:"], [data-id="all-sessions"]')).toHaveCount(0);
  await input(first).press("Escape");

  await page.locator(`[data-testid="session-row"][data-id="${SID2}"]`).dblclick();
  const second = await chatWindow(electron, SID2);
  await expect.poll(focused).toBe("another · chat-trial");
  // the other window on top, by title and project, then All sessions
  await second.getByTestId("composer").press("Meta+k");
  await expect(input(second)).toHaveAttribute("placeholder", "Switch window or run an action");
  await expect(items(second).first()).toHaveAttribute("data-id", `window:${SID}`);
  await expect(items(second).first()).toContainText(TITLE);
  await expect(items(second).first()).toContainText("chat-trial");
  await expect(items(second).first().getByTestId("project-mark")).toHaveCount(1);
  await expect(items(second).nth(1)).toHaveAttribute("data-id", "all-sessions");
  await expect(items(second).nth(1)).toContainText("⌘1");
  await input(second).press("Enter");
  await expect(second.getByTestId("chat-palette")).toHaveCount(0);
  await expect.poll(focused).toBe(`${TITLE} · chat-trial`);
  // and back
  await first.getByTestId("composer").press("Meta+k");
  await expect(items(first).first()).toHaveAttribute("data-id", `window:${SID2}`);
  await input(first).press("Enter");
  await expect.poll(focused).toBe("another · chat-trial");
  // typed: a word of a window's title finds it above the actions
  await second.getByTestId("composer").press("Meta+k");
  await input(second).fill("talk");
  await expect(items(second).first()).toHaveAttribute("data-id", `window:${SID}`);
  await input(second).press("Escape");

  // the main window's ⌘K has both, the one looked at last first, and Enter goes to it
  await page.bringToFront();
  await page.keyboard.press("Meta+k");
  const rows = page.locator('[data-testid="palette-item"][data-id^="window:"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("data-id", `window:${SID2}`);
  await expect(rows.nth(1)).toHaveAttribute("data-id", `window:${SID}`);
  await rows.nth(1).click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect.poll(focused).toBe(`${TITLE} · chat-trial`);
  // All sessions in a chat window's ⌘K is ⌘1: the main window, on All sessions
  await first.getByTestId("composer").press("Meta+k");
  await items(first).filter({ hasText: "All sessions" }).click();
  await expect.poll(focused).toBe("Grove");
});

test("the summon key is grove chat's, can be changed in Settings, and brings the main window back", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  expect(await groveTest(electron).summonKey()).toBe("Control+Alt+Command+G");
  await page.keyboard.press("Meta+,");
  const key = page.getByTestId("setting-summon");
  await expect(key).toHaveText("⌃⌥⌘G");
  await key.click();
  await expect(key).toHaveText("Press keys…");
  // Esc keeps it, and the dialog stays
  await key.press("Escape");
  await expect(key).toHaveText("⌃⌥⌘G");
  await key.click();
  await key.press("Control+Alt+Meta+KeyK");
  await expect(key).toHaveText("⌃⌥⌘K");
  await page.getByTestId("save-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
  expect(await groveTest(electron).summonKey()).toBe("Control+Alt+Command+K");
  // hidden by its close button, and back on the key
  await groveTest(electron).closeMain();
  await waitFor(async () => !(await groveTest(electron).isMainVisible()));
  await groveTest(electron).summon();
  await waitFor(() => groveTest(electron).isMainVisible());
  // with grove chat off there is no key at all
  await page.evaluate(() => window.grove.updateSettings({ chat: false }));
  expect(await groveTest(electron).summonKey()).toBeNull();
});
