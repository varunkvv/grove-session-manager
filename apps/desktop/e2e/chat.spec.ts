// grove chat (beta): a session in its own window, talked to through a fake claude that plays back
// the spike's recordings (test/fixtures/chat). with the switch off, nothing of it is there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { writeFakeClaude } from "./helpers/fakeClaude.ts";
import { makeFixture, readExecLog, writeSession } from "./helpers/fixture.ts";
import { groveTest, type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

const SID = "cccccccc-0000-4000-8000-000000000001";
const TITLE = "talk to it here";
// the recorded prompts: the fake plays the turn whose prompt it is sent
const HELLO = "Reply with exactly: hello from the spike";
const QUESTION =
  "Use the AskUserQuestion tool once to ask me which colour I prefer, with exactly two options: Red and Blue. Then reply with one line saying which I picked. Do not use any other tool.";
const COUNT = "Count from 1 to 400, one number per line, nothing else.";

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
  await chat.getByTestId("chat-open-editor").click();
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
  await expect(chat.getByTestId("composer-images").locator("img")).toHaveCount(2);
  await composer.fill(HELLO);
  await composer.press("Enter");
  await expect(chat.getByTestId("composer-images")).toHaveCount(0);
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
  // nothing to resume: no transcript, and nothing said about one
  await expect(c.getByTestId("chat-gone")).toHaveCount(0);
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
