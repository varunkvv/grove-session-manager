import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FAKE_SHORT_ID, fakeClaudeCalls, writeFakeClaude } from "./helpers/fakeClaude.ts";
import {
  type Fixture,
  makeFixture,
  makePlainDir,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { asAgent, asPerson, liveSession, writeProject } from "./helpers/project.ts";

const SID = {
  /** holds AUTH-1, and its tab is closed */
  idp: "aaaaaaaa-0000-4000-8000-000000000001",
  /** holds AUTH-2, in the editor */
  login: "bbbbbbbb-0000-4000-8000-000000000002",
  /** in no project */
  numbers: "cccccccc-0000-4000-8000-000000000003",
  /** in no project. only its transcript says `flamingo` */
  notes: "dddddddd-0000-4000-8000-000000000004",
};

let fx: Fixture;
let app: LaunchedApp;
let root: string;
/** a folder that belongs to no project */
let scratch: string;

test.afterEach(async () => {
  await app?.close();
});

/**
 * two projects. in auth-sso, AUTH-1's holder closed its tab, AUTH-2's is in the editor, and one
 * decision waits in the inbox. two sessions sit in a folder outside every project.
 */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  root = writeProject(fx, { name: "auth-sso", prefix: "AUTH", goal: "SSO for the dashboard" }).root;
  writeProject(fx, { name: "billing-export", prefix: "BILL", goal: "Invoice exports" });
  const you = asPerson(root);
  for (const title of [
    "Point staging at okta",
    "Login page with the SSO button",
    "Token storage",
  ]) {
    you("card_create", { title });
  }
  const agent = (sessionId: string, name: string) => {
    writeSession(fx, { cwd: root, sessionId, title: name });
    return asAgent(fx, root, { sessionId, name });
  };
  // a transcript and no registry entry: the tab is closed
  agent(SID.idp, "idp config")("card_claim", { card: "AUTH-1" });
  const login = agent(SID.login, "login page");
  login("card_claim", { card: "AUTH-2" });
  login("conclusion_record", {
    kind: "decision",
    what: "State and nonce go in a signed cookie.",
    why: "No redis round trip on the callback.",
    by: "agent",
    card: "AUTH-2",
  });
  liveSession(fx, { sessionId: SID.login, kind: "interactive", entrypoint: "claude-vscode" });

  scratch = makePlainDir(fx, "scratch");
  writeSession(fx, { cwd: scratch, sessionId: SID.numbers, title: "quarterly numbers" });
  writeSession(fx, {
    cwd: scratch,
    sessionId: SID.notes,
    title: "meeting notes",
    reply: "The flamingo migration is done, the old table can go.",
    ageMs: 3 * 60 * 60_000,
  });
  return fx;
}

/** the record is read and the sessions are indexed after the page is up */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const b = await window.grove.bootstrap();
      const found = await window.grove.findSessions("quarterly");
      return !!b.record["auth-sso"]?.readAt && found.length > 0;
    },
    undefined,
    { timeout: 30_000 },
  );
}

const palette = (page: Page) => page.getByTestId("palette");
const input = (page: Page) => page.getByTestId("palette-input");
const items = (page: Page) => page.getByTestId("palette-item");
const item = (page: Page, id: string) =>
  page.locator(`[data-testid="palette-item"][data-id="${id}"]`);
const ids = (page: Page) =>
  items(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
const toast = (page: Page, text: string) => page.getByTestId("toast").filter({ hasText: text });

/** cmd-K, then the query. fill focuses the field itself, whatever window the machine is on */
async function ask(page: Page, query: string): Promise<void> {
  if (!(await palette(page).isVisible())) await page.getByTestId("open-palette").click();
  await input(page).fill(query);
}

/** what the app left for the editor's window */
function pendingIntents(): Array<Record<string, unknown>> {
  const dir = path.join(fx.root, ".grove", "pending");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((n) => JSON.parse(readFileSync(path.join(dir, n), "utf8")));
}

test("opens empty on its first item, the keys and the mouse run an item, Escape hands the keyboard back", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);

  await page.keyboard.press("Meta+k");
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("");
  expect(
    await page
      .getByTestId("palette-section")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))),
  ).toEqual(["Go to", "Projects", "This project", "App"]);
  // no session and no takeover row until there is a word. no repair row: nothing has drifted
  expect(await ids(page)).toEqual([
    "go-inbox",
    "go-cards",
    "go-conclusions",
    "project:auth-sso",
    "project:billing-export",
    "start-editor",
    "start-background",
    "long-work",
    "review-all",
    "delete-project",
    "settings",
  ]);
  await expect(item(page, "start-editor")).toHaveText("Start an agent in VS Code");
  await expect(item(page, "go-inbox")).toHaveAttribute("data-active", "true");
  await expect(input(page)).toHaveAttribute("aria-activedescendant", "palette-go-inbox");

  // the arrows stop at the ends
  await page.keyboard.press("ArrowUp");
  await expect(item(page, "go-inbox")).toHaveAttribute("data-active", "true");
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "go-cards")).toHaveAttribute("data-active", "true");
  await expect(item(page, "go-inbox")).not.toHaveAttribute("data-active");
  // the list behind it did not move. Tab stays in the field, and so does a click on a label
  await page.keyboard.press("Tab");
  await expect(input(page)).toBeFocused();
  await palette(page).getByText("Go to", { exact: true }).click();
  await expect(input(page)).toBeFocused();
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "cards");

  // a word start matches, a middle does not: `clusions` is not Conclusions
  await ask(page, "conc");
  await expect.poll(() => ids(page)).toEqual(["go-conclusions"]);
  await input(page).fill("clusions");
  await expect(page.getByTestId("palette-empty")).toHaveText("No matches.");
  await expect(items(page)).toHaveCount(0);

  // Escape closes and the screen has the keyboard again
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator("[data-list]")).toBeFocused();
  // so does a click outside
  await ask(page, "");
  await page.mouse.click(20, 400);
  await expect(palette(page)).toHaveCount(0);

  // the mouse: the other project, which is checked the next time
  await ask(page, "switch");
  await expect.poll(() => ids(page)).toEqual(["project:auth-sso", "project:billing-export"]);
  await item(page, "project:billing-export").click();
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByTestId("project-switcher")).toContainText("billing-export");
  await ask(page, "");
  await expect(item(page, "project:billing-export").locator("svg")).toHaveCount(1);
  await expect(item(page, "project:auth-sso").locator("svg")).toHaveCount(0);
});

test("a session outside every project is found, by its title or by what was said in it, and Enter lands on it", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);

  await ask(page, "quarterly");
  const hit = page.locator('[data-testid="palette-item"][data-id^="session:"]');
  await expect(hit).toHaveCount(1);
  await expect(page.getByTestId("palette-section")).toHaveAttribute("aria-label", "Sessions");
  await expect(hit).toContainText("quarterly numbers");
  await expect(hit.locator("mark")).toHaveText("quarterly");
  // where it ran, since no project has it
  await expect(hit).toContainText("scratch");

  // only the transcript has this word: the row says where
  await input(page).fill("flamingo");
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText("meeting notes");
  await expect(hit).toContainText("The flamingo migration is done");

  await input(page).fill("quarterly");
  await expect(hit).toContainText("quarterly numbers");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(toast(page, "Opening quarterly numbers in VS Code")).toBeVisible();
  const code = () => readExecLog(fx).filter((l) => l.bin === "code");
  await waitFor(async () => code().length === 1);
  // its own folder, not a project's window
  expect(code()[0]?.argv[0]).toBe(scratch);
  expect(pendingIntents()).toMatchObject([
    { kind: "resume", sessionId: SID.numbers, source: "app" },
  ]);
});

test("Start a new agent on a card whose holder is closed: asked first, then the takeover prompt", async () => {
  seed();
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), []);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  await ready(page);

  // a row per card would be long on a busy project: none until there is a word
  await ask(page, "");
  await expect(page.locator('[data-id^="takeover:"]')).toHaveCount(0);
  // the card's title finds it. AUTH-2's holder is in the editor, so it is not offered
  await input(page).fill("okta");
  await expect(item(page, "takeover:AUTH-1")).toHaveText("Start a new agent on AUTH-1");
  await input(page).fill("takeover");
  await expect.poll(() => ids(page)).toEqual(["takeover:AUTH-1"]);

  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toHaveAttribute("aria-label", "Start a new agent on AUTH-1?");
  await expect(dialog).toContainText(
    "idp config still holds it, but its session is closed. A new agent in the background takes the card over and carries on from the record.",
  );
  // nothing ran yet
  const started = () => fakeClaudeCalls(fake).filter((c) => c.argv.includes("--bg"));
  expect(started()).toEqual([]);
  await expect(dialog.getByTestId("confirm-run")).toHaveText("Start a new agent");
  await dialog.getByTestId("confirm-run").click();

  await expect(toast(page, `started in background · ${FAKE_SHORT_ID}`)).toBeVisible();
  expect(started()).toMatchObject([
    {
      cwd: root,
      argv: [
        "--bg",
        "--",
        "Call record_state first. I want you to take over AUTH-1 from idp config, whose session is no longer running: Point staging at okta\n\nTake it with card_takeover, then read it with card_show and carry on from where it stopped.",
      ],
    },
  ]);
});

test("No matches. waits for the session search to answer", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  // a main that takes its time over the search
  await app.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("grove:findSessions");
    ipcMain.handle("grove:findSessions", async () => {
      await new Promise((r) => setTimeout(r, 1_500));
      return [];
    });
  });

  await ask(page, "zzqqxv");
  // no command matches, and nothing is said while the sessions are still coming
  await page.waitForTimeout(700);
  await expect(items(page)).toHaveCount(0);
  await expect(page.getByTestId("palette-empty")).toHaveCount(0);
  await expect(page.getByTestId("palette-empty")).toHaveText("No matches.");
});

test("what the screens have no button for: long work, mark all reviewed, delete, settings", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  await expect(page.getByTestId("inbox-row")).toHaveCount(1, { timeout: 15_000 });

  // the row says what choosing it does, the toast what it did
  await ask(page, "long");
  await expect(item(page, "long-work")).toHaveText("Run long work in the conversation");
  await page.keyboard.press("Enter");
  await expect(toast(page, "Long work runs in the conversation in auth-sso")).toBeVisible();
  await ask(page, "long");
  await expect(item(page, "long-work")).toHaveText("Run long work in the background");
  await page.keyboard.press("Escape");

  await ask(page, "mark");
  await expect(item(page, "review-all")).toHaveText("Mark all reviewed in auth-sso");
  await page.keyboard.press("Enter");
  await expect(toast(page, "Marked 1 reviewed")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();
  // nothing left to mark, so no row
  await ask(page, "mark");
  await expect(page.getByTestId("palette-empty")).toBeVisible();

  await input(page).fill("delete");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByTestId("delete-dialog")).toHaveAttribute("aria-label", "Delete auth-sso?");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("delete-dialog")).toHaveCount(0);

  await ask(page, "preferences");
  await expect.poll(() => ids(page)).toEqual(["settings"]);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
});
