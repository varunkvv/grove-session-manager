// grove chat (beta): a session in its own window, talked to through a fake claude that plays back
// the spike's recordings (test/fixtures/chat). with the switch off, nothing of it is there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { writeFakeClaude } from "./helpers/fakeClaude.ts";
import { makeFixture, readExecLog, writeSession } from "./helpers/fixture.ts";
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

let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

function seed(chat: boolean) {
  const fx = makeFixture({ withCompanion: true });
  if (chat) writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ chat: true }));
  const { id, root } = writeProject(fx, { name: "chat-trial" });
  writeSession(fx, { cwd: root, sessionId: SID, title: TITLE, prompt: "set the scene" });
  const fake = writeFakeClaude(fx.dir);
  const chatLog = path.join(fx.dir, "chat.log");
  return { fx, id, root, fake, chatLog };
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

test("switched on, a double-click opens the session's own window, and a prompt streams back", async () => {
  const s = seed(true);
  const { app: electron, page } = await launch(s);
  await openRow(page, s.id);
  const chat = await chatWindow(electron, SID);
  await expect(chat.locator("h1")).toHaveText(TITLE);
  await expect.poll(() => chat.title()).toBe(TITLE);
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
  // what runs for it is one line, and it opens the chat window's agents
  await expect(card.getByTestId("card-agents")).toContainText(
    "2 running · slow lister, long sleeper",
  );
  await card.getByTestId("card-agents").click();
  await expect(chat.getByTestId("agents")).toBeVisible();
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
  await expect(menu).toContainText("Shift-Tab to switch");
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
  await card.getByTestId("refusal-edit").click();
  await expect(chat.getByTestId("composer")).toHaveValue("try the migration");
  await waitFor(async () =>
    sentToClaude(s.chatLog).some(
      (l) =>
        (l.in as { response?: { response?: { result?: string } } })?.response?.response?.result ===
        "edit_prompt",
    ),
  );
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
  await expect(menu).toContainText("Max is for this session only");
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
  }, TITLE);
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
  await expect(turn.getByTestId("panel-text")).toContainText("Launched both agents", {
    timeout: 20_000,
  });
  const toggle = turn.getByTestId("turn-steps-toggle");
  await expect(toggle).toContainText("3 steps");
  await expect(turn.getByTestId("steps")).toHaveCount(0);
  await toggle.click();
  await expect(turn.getByTestId("step")).toHaveText([
    /^Agent\s*slow lister/,
    /^Agent\s*long sleeper/,
    /^Bash\s*sleep 5 && echo main-done/,
  ]);
  // the panel in the main window draws the same turn as it always has: no steps to open
  await page.bringToFront();
  await page.locator(`[data-testid="session-row"][data-id="${SID}"]`).click();
  await expect(page.getByTestId("session-panel").getByTestId("turn")).toHaveCount(2);
  await expect(page.getByTestId("session-panel").getByTestId("turn-steps-toggle")).toHaveCount(0);
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
  // the old session is no longer grove's
  await expect(
    page.locator(`[data-testid="session-row"][data-id="${SID}"] [data-testid="runtime-chip"]`),
  ).not.toHaveAttribute("data-runtime", "grove");
});

test("a notification click lands in the session's chat window", async () => {
  const s = seed(true);
  const { app: electron } = await launch(s);
  await groveTest(electron).reveal(SID);
  const chat = await chatWindow(electron, SID);
  await expect(chat.locator("h1")).toHaveText(TITLE);
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

test("files: the + menu's picker, a drop anywhere, chips, and what can't be attached goes in as its path", async () => {
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
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toContainText("spec.pdf");
  await expect(chips.last()).toContainText("data.csv");
  // a docx is no type claude takes: the message names where it is instead
  await expect(chat.getByTestId("chat-note")).toContainText(
    "report.docx can't be attached, so its path is in the message",
  );
  const composer = chat.getByTestId("composer");
  await expect(composer).toHaveValue(`${docx} `);
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
  await expect(chips).toHaveCount(3);
  // one taken back
  await chips.last().getByTestId("chip-remove").click();
  await expect(chips).toHaveCount(2);
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(chips).toHaveCount(0);
  await expect(chat.getByTestId("panel-text")).toContainText("hello from the spike");
  await expect(chat.getByTestId("turn").last().getByTestId("turn-attached")).toHaveText(
    " · spec.pdf · data.csv",
  );
  const sent = sentToClaude(s.chatLog)
    .map((l) => l.in as { type?: string; message?: { content?: Array<Record<string, unknown>> } })
    .find((m) => m?.type === "user");
  expect(sent?.message?.content).toEqual([
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQKJSVFT0YK" },
      title: "spec.pdf",
    },
    {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "a,b\n1,2\n" },
      title: "data.csv",
    },
    { type: "text", text: HELLO },
  ]);
  // Mention a file puts an @ where the caret is, and the files menu opens on it
  await chat.getByTestId("chat-attach").click();
  await menu.getByTestId("menu-item").last().click();
  await expect(composer).toHaveValue("@");
  await expect(chat.getByTestId("suggest")).toHaveAttribute("data-kind", "@");
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
  }, TITLE);
  await page.waitForTimeout(700);
  const a = await bounds(TITLE);
  await page.locator(`[data-testid="session-row"][data-id="${SID2}"]`).dblclick();
  await chatWindow(electron, SID2);
  await expect.poll(() => bounds("another")).toMatchObject({ width: 700, height: 640 });
  const b = await bounds("another");
  expect(b?.x).toBe((a?.x ?? 0) + 26);
  expect(b?.y).toBe((a?.y ?? 0) + 26);
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
