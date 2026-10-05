import { expect, type Page, test } from "@playwright/test";
import { type Fixture, makeFixture } from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp } from "./helpers/launchApp.ts";
import { asAgent, liveSession, writeProject } from "./helpers/project.ts";

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
