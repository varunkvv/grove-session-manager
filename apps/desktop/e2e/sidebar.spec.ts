import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  type Fixture,
  hookEvent,
  makeFixture,
  pendingIntents,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

const IDP = "aaaaaaaa-0000-4000-8000-000000000001";
const QUIET = "bbbbbbbb-0000-4000-8000-000000000002";

/** auth-sso with a session that needs him and one that does not, and billing-export beside it */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "auth-sso",
    goal: "SSO for the dashboard",
  });
  writeProject(fx, { name: "billing-export", goal: "Invoice exports" });
  writeSession(fx, { cwd: root, sessionId: IDP, title: "idp config" });
  writeSession(fx, { cwd: root, sessionId: QUIET, title: "okta research" });
  hookEvent(fx, IDP, "Stop", { last_assistant_message: "A dev tenant, or the prod one?" });
  return fx;
}

const item = (page: Page, id: string) =>
  page.locator(`[data-testid="project-item"][data-id="${id}"]`);

/** everything on screen that takes a click and computes to a window drag region */
const dragged = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, a, input, [role="option"]')]
      .filter((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region") === "drag")
      .map((e) => e.dataset.testid ?? e.textContent?.slice(0, 40) ?? e.tagName),
  );

// why this exists: playwright clicks through the devtools protocol, which never meets the window's
// drag regions, so every click in this suite lands where no mouse can. macOS takes a press on
// `-webkit-app-region: drag` as the start of a window drag, the property is inherited, and the top
// bar and the top of the sidebar are drag regions: 0.10.16 shipped a project menu that took no
// clicks, with every test green. the computed value is the only stand-in for a real mouse there is
test("nothing that takes a click sits in a window drag region", async () => {
  app = await launchApp(seed());
  const { page } = app;
  const sweep = async (screen: string) => expect(await dragged(page), screen).toEqual([]);

  await expect(page.getByTestId("inbox-row")).toHaveCount(1, { timeout: 15_000 });
  await sweep("inbox");
  await page.getByTestId("inbox-row").click();
  await expect(page.getByTestId("panel-text")).toBeVisible();
  await sweep("the inbox with a session in its panel");
  await page.keyboard.press("Escape");

  // a project's screen puts a field and five buttons in the top bar, which is the drag region
  await item(page, "auth-sso").click();
  await expect(page.getByTestId("session-row")).toHaveCount(2);
  await sweep("sessions");
  await page.getByTestId("session-row").first().click();
  await expect(page.getByTestId("panel-text")).toBeVisible();
  await sweep("sessions with a session in its panel");
  await item(page, "billing-export").click();
  await expect(page.getByTestId("sessions-empty")).toBeVisible();
  await sweep("a project with no sessions");

  await page.getByTestId("new-project").click();
  await expect(page.getByTestId("project-name")).toBeVisible();
  await sweep("new project");
  await page.keyboard.press("Escape");

  await page.getByTestId("open-palette").click();
  await expect(page.getByTestId("palette-item").first()).toBeVisible();
  await sweep("the palette");
  await page.keyboard.press("Escape");

  // what the window IS dragged by: the top bar, and the strip of the sidebar the traffic lights sit in
  const region = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region"));
  expect(await region('[data-testid="top-bar"]')).toBe("drag");
  expect(await region('[data-testid="sidebar"] > div')).toBe("drag");
  expect(await region('[data-testid="nav-inbox"]')).toBe("no-drag");
});

const NAMES = Array.from({ length: 26 }, (_, i) => `project-${String.fromCharCode(97 + i)}`);

test("the sidebar: All sessions on top, the projects in the file's order with their counts, and the one on screen marked", async () => {
  fx = makeFixture({ withCompanion: true });
  const roots = NAMES.map((name) => writeProject(fx, { name }).root);
  // the last project needs him, and nothing before it does
  const late = "cccccccc-0000-4000-8000-000000000003";
  writeSession(fx, { cwd: roots[25] as string, sessionId: late, title: "late one" });
  hookEvent(fx, late, "Stop", { last_assistant_message: "Ready?" });
  app = await launchApp(fx);
  const { page } = app;
  const names = () =>
    page
      .getByTestId("project-item")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));

  await expect(page.getByTestId("nav-inbox").getByTestId("count")).toHaveText("1", {
    timeout: 15_000,
  });
  expect(await names()).toEqual(NAMES);
  // the inbox is what the app opens on, and it is marked
  await expect(page.getByTestId("nav-inbox")).toHaveAttribute("aria-current", "page");
  await expect(page.locator('[data-testid="project-item"][aria-current]')).toHaveCount(0);
  await expect(item(page, "project-z").getByTestId("count")).toHaveText("1");
  await expect(item(page, "project-a").getByTestId("count")).toHaveCount(0);

  // twenty-six do not fit: they scroll by themselves, and the inbox stays put above them
  const list = page.getByTestId("projects");
  expect(await list.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  await expect(item(page, "project-z")).not.toBeInViewport();
  await item(page, "project-z").scrollIntoViewIfNeeded();
  await expect(item(page, "project-z")).toBeInViewport();
  await expect(page.getByTestId("nav-inbox")).toBeInViewport();

  // a click is the project's sessions, and the mark moves to it
  await item(page, "project-z").click();
  await expect(page.getByTestId("project-name")).toHaveText("project-z");
  await expect(item(page, "project-z")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-inbox")).not.toHaveAttribute("aria-current");
  await expect(page.getByTestId("session-row")).toHaveCount(1);

  // a count that changes moves no project: a session in an early one starts needing him
  const early = "dddddddd-0000-4000-8000-000000000004";
  writeSession(fx, { cwd: roots[1] as string, sessionId: early, title: "early one" });
  await page.waitForFunction(
    async () => (await window.grove.listSessions("project-b")).length === 1,
    undefined,
    { timeout: 20_000 },
  );
  hookEvent(fx, early, "Stop", { last_assistant_message: "And this?" });
  await expect(item(page, "project-b").getByTestId("count")).toHaveText("1");
  await expect(page.getByTestId("nav-inbox").getByTestId("count")).toHaveText("2");
  expect(await names()).toEqual(NAMES);

  // the keys: cmd-1 the inbox, cmd-2 back to the project, alt-arrows down the sidebar
  await page.keyboard.press("Meta+1");
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
  await expect(page.getByTestId("inbox-row")).toHaveCount(2);
  await page.keyboard.press("Meta+2");
  await expect(page.getByTestId("project-name")).toHaveText("project-z");
  await page.keyboard.press("Meta+1");
  await page.keyboard.press("Alt+ArrowDown");
  await expect(item(page, "project-a")).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Alt+ArrowDown");
  await expect(item(page, "project-b")).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.getByTestId("nav-inbox")).toHaveAttribute("aria-current", "page");

  // the + beside Projects is the new project form, and no project is marked while it is up
  await page.getByTestId("new-project").click();
  await expect(page.getByTestId("project-form")).toHaveAttribute("data-mode", "new");
  await expect(page.locator('[data-testid="sidebar"] [aria-current]')).toHaveCount(0);
});

test("Open in VS Code in the top bar opens the window of the project on screen", async () => {
  app = await launchApp(seed());
  const { page } = app;
  const open = page.getByTestId("open-project");
  const code = () => readExecLog(fx).filter((l) => l.bin === "code");

  // the inbox is every project's: it has no one window to open
  await expect(open).toHaveCount(0);
  await item(page, "auth-sso").click();
  await expect(open).toHaveText("Open in VS Code");
  await expect(open).toHaveAttribute("title", "Open auth-sso in VS Code");
  await open.click();
  await expect(
    page.getByTestId("toast").filter({ hasText: "Opening auth-sso in VS Code" }),
  ).toBeVisible();
  await waitFor(async () => code().length === 1);
  expect(code()[0]?.argv[0]).toMatch(/auth-sso\.code-workspace$/);
  // the project and no session: nothing is left for the editor to land on
  expect(pendingIntents(fx)).toEqual([]);

  // it follows the sidebar, and cmd-O does the same
  await item(page, "billing-export").click();
  await expect(open).toHaveAttribute("title", "Open billing-export in VS Code");
  await page.keyboard.press("Meta+o");
  await waitFor(async () => code().length === 2);
  expect(code()[1]?.argv[0]).toMatch(/billing-export\.code-workspace$/);
});

test("a double-click on a project starts a new session in it, and one whose folder is gone says why", async () => {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, { name: "auth-sso" });
  const gone = writeProject(fx, { name: "moved-away" });
  rmSync(gone.root, { recursive: true });
  app = await launchApp(fx);
  const { page } = app;
  const code = () => readExecLog(fx).filter((l) => l.bin === "code");

  await expect(item(page, "auth-sso")).toHaveAttribute(
    "title",
    "auth-sso - double-click for a new session",
  );
  await item(page, "auth-sso").dblclick();
  // the first click of the two went to the project: he sees where it starts
  await expect(page.getByTestId("project-name")).toHaveText("auth-sso");
  await expect(
    page
      .getByTestId("toast")
      .filter({ hasText: "Opening auth-sso in VS Code on a new conversation" }),
  ).toBeVisible();
  // the top bar's New session: the project's window, and a new conversation left for it. once
  await waitFor(async () => code().length === 1);
  expect(code()[0]?.argv[0]).toMatch(/auth-sso\.code-workspace$/);
  const [intent, ...more] = pendingIntents(fx);
  expect(more).toEqual([]);
  expect(intent).toMatchObject({ kind: "new", cwd: root, source: "app" });

  // a start that is known to fail is not made: the project comes on screen, and a toast says why
  await item(page, gone.id).dblclick();
  await expect(page.getByTestId("project-name")).toHaveText("moved-away");
  await expect(
    page.getByTestId("toast").filter({ hasText: "Could not start a session in moved-away" }),
  ).toContainText(`The project folder is missing: ${gone.root}`);
  await page.waitForTimeout(500);
  expect(code()).toHaveLength(1);
});
