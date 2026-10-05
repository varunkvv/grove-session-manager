import { expect, type Page, test } from "@playwright/test";
import { type Fixture, makeFixture, pendingIntents, readExecLog } from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { asAgent, asPerson, liveSession, writeProject } from "./helpers/project.ts";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

const IDP = "aaaaaaaa-0000-4000-8000-000000000001";

/** auth-sso with a held card, a question in the inbox and a decision, and billing-export beside it */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "auth-sso",
    prefix: "AUTH",
    goal: "SSO for the dashboard",
  });
  writeProject(fx, { name: "billing-export", prefix: "BILL", goal: "Invoice exports" });
  const idp = asAgent(fx, root, { sessionId: IDP, name: "idp config" });
  idp("card_create", { title: "Point staging at okta" });
  idp("card_claim", { card: "AUTH-1" });
  idp("question_ask", { card: "AUTH-1", text: "A dev tenant, or the prod one?", to: "person" });
  idp("conclusion_record", {
    kind: "decision",
    what: "State and nonce go in a signed cookie.",
    why: "No redis round trip on the callback.",
    by: "agent",
    card: "AUTH-1",
  });
  liveSession(fx, { sessionId: IDP, kind: "interactive", entrypoint: "claude-vscode" });
  return fx;
}

const region = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .first()
    .evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region"));

/** everything on screen that takes a click and computes to a window drag region */
const dragged = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'button, a, input, [role="option"], [role="menuitem"], [role="menuitemradio"]',
      ),
    ]
      .filter((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region") === "drag")
      .map((e) => e.dataset.testid ?? e.textContent?.slice(0, 40) ?? e.tagName),
  );

// why this exists: playwright clicks through the devtools protocol, which never meets the window's
// drag regions, so every click in this suite lands where no mouse can. macOS takes a press on
// `-webkit-app-region: drag` as the start of a window drag, the property is inherited, and the top
// bar is one: 0.10.16 shipped a project menu that took no clicks, with every test green. the
// computed value is the only stand-in for a real mouse there is
test("nothing that takes a click sits in a window drag region", async () => {
  app = await launchApp(seed());
  const { page } = app;
  const sweep = async (screen: string) => expect(await dragged(page), screen).toEqual([]);

  await expect(page.getByTestId("inbox-row").first()).toBeVisible({ timeout: 15_000 });
  await sweep("inbox");

  // the menu is drawn inside the top bar, which is the drag region
  await page.getByTestId("project-switcher").click();
  await expect(page.getByTestId("project-menu")).toBeVisible();
  const menu = ["project-menu", "project-item", "new-project", "overlay-backdrop"];
  const regions = await Promise.all(menu.map((id) => region(page, id)));
  expect(menu.filter((_, i) => regions[i] === "drag")).toEqual([]);
  await sweep("the open switcher");
  await page.keyboard.press("Escape");

  await page.getByTestId("nav-cards").click();
  await expect(page.getByTestId("card-row")).toHaveCount(1);
  await sweep("cards");

  await page.getByTestId("card-row").click();
  await expect(page.getByTestId("card-side")).toBeVisible();
  await sweep("a card");

  await page.getByTestId("nav-conclusions").click();
  await page.getByTestId("conclusion-row").click();
  await sweep("conclusions");

  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("project-name")).toBeVisible();
  await sweep("new project");
  await page.keyboard.press("Escape");

  await page.getByTestId("open-palette").click();
  await expect(page.getByTestId("palette-item").first()).toBeVisible();
  expect(await region(page, "overlay-backdrop")).not.toBe("drag");
  await sweep("the palette");
});

const NAMES = [
  "auth-sso",
  "billing-export",
  "chat-features",
  "data-objects",
  "Émile café",
  "infra-cleanup",
  "mobile-push",
  "ops-jobs",
  "pay-fix",
  "search-relevance",
  "web-perf",
  "zeta-reports",
];

/** more projects than the menu shows at once. the first has a card, so its Cards screen has a list */
function manyProjects(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const roots = NAMES.map(
    (name, i) =>
      writeProject(fx, { name, prefix: `P${String.fromCharCode(65 + i)}`, goal: name }).root,
  );
  asPerson(roots[0] as string)("card_create", { title: "Point staging at okta" });
  return fx;
}

const switcher = (page: Page) => page.getByTestId("project-switcher");
const menu = (page: Page) => page.getByTestId("project-menu");
const search = (page: Page) => page.getByTestId("project-search");
const items = (page: Page) => page.getByTestId("project-item");
const item = (page: Page, id: string) =>
  page.locator(`[data-testid="project-item"][data-id="${id}"]`);
const newProject = (page: Page) => page.getByTestId("new-project");
const names = (page: Page) => items(page).evaluateAll((els) => els.map((e) => e.textContent));

test("the switcher: typing narrows it, the keys move and pick, Escape hands the keyboard back", async () => {
  app = await launchApp(manyProjects());
  const { page } = app;
  await page.getByTestId("nav-cards").click();
  await expect(page.getByTestId("card-row")).toHaveCount(1, { timeout: 15_000 });

  await switcher(page).click();
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveAttribute("placeholder", "Find a project");
  expect(await names(page)).toEqual(NAMES);
  // it opens on the project on screen, which is the checked one
  await expect(item(page, "auth-sso")).toHaveAttribute("data-active", "true");
  await expect(item(page, "auth-sso")).toHaveAttribute("aria-checked", "true");
  await expect(search(page)).toHaveAttribute("aria-activedescendant", "switcher-0");

  // twelve do not fit: the list scrolls inside the menu, and New project… is not part of what scrolls
  const scroller = items(page).first().locator("..");
  expect(await scroller.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  await expect(item(page, "zeta-reports")).not.toBeInViewport();
  await expect(newProject(page)).toBeInViewport();
  // the keys: End is New project…, and the arrows keep their item in view
  await page.keyboard.press("End");
  await expect(newProject(page)).toHaveAttribute("data-active", "true");
  await page.keyboard.press("ArrowDown");
  await expect(newProject(page)).toHaveAttribute("data-active", "true");
  await page.keyboard.press("ArrowUp");
  await expect(item(page, "zeta-reports")).toHaveAttribute("data-active", "true");
  await expect(item(page, "zeta-reports")).toBeInViewport();
  await page.keyboard.press("Home");
  await expect(item(page, "auth-sso")).toHaveAttribute("data-active", "true");
  await expect(item(page, "auth-sso")).toBeInViewport();
  await page.keyboard.press("ArrowUp");
  await expect(item(page, "auth-sso")).toHaveAttribute("data-active", "true");

  // every word, in any order, whatever the case. the first match is the keyboard's
  await search(page).fill("PORT bill");
  expect(await names(page)).toEqual(["billing-export"]);
  await expect(item(page, "billing-export")).toHaveAttribute("data-active", "true");
  await expect(newProject(page)).toBeVisible();
  // accents do not count
  await search(page).fill("emile cafe");
  expect(await names(page)).toEqual(["Émile café"]);
  // nothing found: one line, and New project… is still there
  await search(page).fill("nothing like it");
  await expect(items(page)).toHaveCount(0);
  await expect(page.getByTestId("project-none")).toHaveText("No projects match.");
  await expect(newProject(page)).toBeVisible();

  // Escape closes it without switching, and the list behind has the keyboard again
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(switcher(page)).toContainText("auth-sso");
  await expect(page.locator("[data-list]")).toBeFocused();

  // every open starts empty. Enter picks the first match
  await switcher(page).click();
  await expect(search(page)).toHaveValue("");
  await search(page).fill("e");
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "chat-features")).toHaveAttribute("data-active", "true");
  await search(page).fill("zeta");
  await page.keyboard.press("Enter");
  await expect(menu(page)).toHaveCount(0);
  await expect(switcher(page)).toContainText("zeta-reports");
  // the same screen in the other project
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "cards");
});

test("the switcher by mouse: a click picks a project, New project… opens the form, a click outside closes it", async () => {
  app = await launchApp(manyProjects());
  const { page } = app;

  await switcher(page).click();
  await item(page, "chat-features").click();
  await expect(menu(page)).toHaveCount(0);
  await expect(switcher(page)).toContainText("chat-features");

  // the check moved with it, and a click in the list leaves the keyboard in the field
  await switcher(page).click();
  await expect(item(page, "chat-features").locator("svg")).toHaveCount(1);
  await expect(item(page, "auth-sso").locator("svg")).toHaveCount(0);
  await menu(page).getByRole("separator").click();
  await expect(search(page)).toBeFocused();

  await page.mouse.click(700, 400);
  await expect(menu(page)).toHaveCount(0);
  await expect(switcher(page)).toContainText("chat-features");

  await switcher(page).click();
  await search(page).fill("pay");
  await newProject(page).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByTestId("project-name")).toBeVisible();
});

test("Open in VS Code in the top bar opens the window of the project on screen", async () => {
  app = await launchApp(seed());
  const { page } = app;
  const open = page.getByTestId("open-project");
  const code = () => readExecLog(fx).filter((l) => l.bin === "code");

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

  // it is on every screen, and follows the switcher
  for (const nav of ["nav-cards", "nav-conclusions"]) {
    await page.getByTestId(nav).click();
    await expect(open).toBeVisible();
  }
  await switcher(page).click();
  await item(page, "billing-export").click();
  await expect(open).toHaveAttribute("title", "Open billing-export in VS Code");
  await open.click();
  await waitFor(async () => code().length === 2);
  expect(code()[1]?.argv[0]).toMatch(/billing-export\.code-workspace$/);
});
