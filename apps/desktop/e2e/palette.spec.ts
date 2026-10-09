import { expect, type Page, test } from "@playwright/test";
import {
  type Fixture,
  makeFixture,
  makePlainDir,
  pendingIntents,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

const SID = {
  /** in auth-sso */
  idp: "aaaaaaaa-0000-4000-8000-000000000001",
  /** in no project */
  numbers: "cccccccc-0000-4000-8000-000000000003",
  /** in no project. only its transcript says `flamingo` */
  notes: "dddddddd-0000-4000-8000-000000000004",
};

let fx: Fixture;
let app: LaunchedApp;
/** a folder that belongs to no project */
let scratch: string;

test.afterEach(async () => {
  await app?.close();
});

/** two projects, one session in the first, and two sessions in a folder outside every project */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "auth-sso",
    goal: "SSO for the dashboard",
  });
  writeProject(fx, { name: "billing-export", goal: "Invoice exports" });
  writeSession(fx, { cwd: root, sessionId: SID.idp, title: "idp config" });

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

/** the sessions are indexed after the page is up */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => (await window.grove.findSessions("quarterly")).length > 0,
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
const sections = (page: Page) =>
  page
    .getByTestId("palette-section")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
const toast = (page: Page, text: string) => page.getByTestId("toast").filter({ hasText: text });
const project = (page: Page, id: string) =>
  page.locator(`[data-testid="project-item"][data-id="${id}"]`).click();

/** cmd-K, then the query. fill focuses the field itself, whatever window the machine is on */
async function ask(page: Page, query: string): Promise<void> {
  if (!(await palette(page).isVisible())) await page.getByTestId("open-palette").click();
  await input(page).fill(query);
}

test("opens empty on its first item, the keys and the mouse run an item, Escape hands the keyboard back", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);

  // on the inbox, which is every project's: where to go, and nothing about one project
  await page.keyboard.press("Meta+k");
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("");
  expect(await sections(page)).toEqual(["Go to", "Projects", "App"]);
  await page.keyboard.press("Escape");

  await project(page, "auth-sso");
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await page.keyboard.press("Meta+k");
  expect(await sections(page)).toEqual(["Go to", "Projects", "This project", "App"]);
  // no session until there is a word. no repair row: nothing has drifted
  expect(await ids(page)).toEqual([
    "go-inbox",
    "go-usage",
    "project:auth-sso",
    "project:billing-export",
    "new-session",
    "start-background",
    "long-work",
    "archive-project",
    "delete-project",
    "settings",
  ]);
  // the home screen by its name on screen
  await expect(item(page, "go-inbox")).toContainText("All sessions");
  await expect(item(page, "new-session")).toHaveText("New session in VS Code");
  await expect(item(page, "start-background")).toHaveText("Start a background session…");
  await expect(item(page, "go-inbox")).toHaveAttribute("data-active", "true");
  await expect(input(page)).toHaveAttribute("aria-activedescendant", "palette-go-inbox");
  // the project on screen is checked
  await expect(item(page, "project:auth-sso").locator("svg")).toHaveCount(1);
  await expect(item(page, "project:billing-export").locator("svg")).toHaveCount(0);

  // the arrows stop at the ends
  await page.keyboard.press("ArrowUp");
  await expect(item(page, "go-inbox")).toHaveAttribute("data-active", "true");
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "go-usage")).toHaveAttribute("data-active", "true");
  await expect(item(page, "go-inbox")).not.toHaveAttribute("data-active");
  // the list behind it did not move. Tab stays in the field, and so does a click on a label
  await page.keyboard.press("Tab");
  await expect(input(page)).toBeFocused();
  await palette(page).getByText("Go to", { exact: true }).click();
  await expect(input(page)).toBeFocused();
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "sessions");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");

  // a word start matches, a middle does not: `ttings` is not Settings
  await ask(page, "sett");
  await expect.poll(() => ids(page)).toEqual(["settings"]);
  await input(page).fill("ttings");
  await expect(page.getByTestId("palette-empty")).toHaveText("No matches.");
  await expect(items(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);

  // the mouse: a project, which is its sessions. Escape there and the list has the keyboard again
  await ask(page, "switch");
  await expect.poll(() => ids(page)).toEqual(["project:auth-sso", "project:billing-export"]);
  await item(page, "project:auth-sso").click();
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByTestId("project-name")).toHaveText("auth-sso");
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await ask(page, "");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator("[data-list]")).toBeFocused();
  // so does a click outside
  await ask(page, "");
  await page.mouse.click(600, 700);
  await expect(palette(page)).toHaveCount(0);
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
  expect(pendingIntents(fx)).toMatchObject([
    { kind: "resume", sessionId: SID.numbers, source: "app" },
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

test("what the screens have no button for: long work, delete, settings", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  await project(page, "auth-sso");

  // the row says what choosing it does, the toast what it did
  await ask(page, "long");
  await expect(item(page, "long-work")).toHaveText("Run long work in the conversation");
  await page.keyboard.press("Enter");
  await expect(toast(page, "Long work runs in the conversation in auth-sso")).toBeVisible();
  await ask(page, "long");
  await expect(item(page, "long-work")).toHaveText("Run long work in the background");

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
