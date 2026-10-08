import { expect, test } from "@playwright/test";
import { type Fixture, hookEvent, makeFixture, writeSession } from "./helpers/fixture.ts";
import { groveTest, type LaunchedApp, launchApp } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

const IDP = "aaaaaaaa-0000-4000-8000-000000000001";
const EXPORT = "bbbbbbbb-0000-4000-8000-000000000002";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/** two projects, and in each a session whose turn ended on a question */
function setup(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const auth = writeProject(fx, {
    name: "auth-sso",
    prefix: "AUTH",
    goal: "SSO for the dashboard",
  });
  const billing = writeProject(fx, { name: "billing-export", prefix: "BILL" });
  writeSession(fx, { cwd: auth.root, sessionId: IDP, title: "idp config" });
  writeSession(fx, { cwd: billing.root, sessionId: EXPORT, title: "export job" });
  hookEvent(fx, IDP, "Stop", { last_assistant_message: "A dev tenant, or the prod one?" });
  hookEvent(fx, EXPORT, "Stop", { last_assistant_message: "csv only, or parquet too?" });
  return fx;
}

/** the statuses are read after the page is up: wait for both to reach the tray */
async function ready(app: LaunchedApp) {
  const g = groveTest(app.app);
  await expect.poll(() => g.trayTitle(), { timeout: 15_000 }).toBe("2");
  return g;
}

test("the menu lists the newest rows across projects, then Open Grove and Quit", async () => {
  app = await launchApp(setup());
  const g = await ready(app);
  const menu = await g.trayMenu();
  expect(menu).toHaveLength(5);
  // newest first, whichever millisecond each was written in
  expect(
    menu
      .slice(0, 2)
      .map((i) => [i.label, i.sublabel])
      .sort(),
  ).toEqual([
    ["Your turn  export job", "billing-export · csv only, or parquet too?"],
    ["Your turn  idp config", "auth-sso · A dev tenant, or the prod one?"],
  ]);
  expect(menu.slice(2)).toEqual([{}, { label: "Open Grove" }, { role: "quit" }]);
});

test("the close button hides the window, the app stays, and Open Grove brings it back", async () => {
  app = await launchApp(setup());
  const g = await ready(app);
  expect(await g.isMainVisible()).toBe(true);
  await g.closeMain();
  await expect.poll(() => g.isMainVisible()).toBe(false);
  // still running, and the hidden page still answers
  expect((await app.page.evaluate(() => window.grove.bootstrap())).projects).toHaveLength(2);
  await g.trayClick(3);
  await expect.poll(() => g.isMainVisible()).toBe(true);
});

test("a row shows the window on that session: its inbox row, with its panel open", async () => {
  app = await launchApp(setup());
  const g = await ready(app);
  const menu = await g.trayMenu();
  const billing = menu.findIndex((i) => i.label === "Your turn  export job");
  // from a project's screen, with the window closed
  await app.page.locator('[data-testid="project-item"][data-id="auth-sso"]').click();
  await g.closeMain();
  await expect.poll(() => g.isMainVisible()).toBe(false);
  await g.trayClick(billing);
  await expect.poll(() => g.isMainVisible()).toBe(true);
  await expect(app.page.locator('[data-testid="screen"][data-view="inbox"]')).toBeAttached();
  await expect(app.page.getByTestId("session-panel")).toHaveAttribute("data-id", EXPORT);
  await expect(app.page.locator('[data-testid="inbox-row"][data-open]')).toHaveAttribute(
    "data-project",
    "billing-export",
  );
});

test("--hidden starts with no visible window and a working page", async () => {
  app = await launchApp(setup(), {}, ["--hidden"]);
  const g = await ready(app);
  expect(await g.isMainVisible()).toBe(false);
  expect((await app.page.evaluate(() => window.grove.bootstrap())).inbox.rows).toHaveLength(2);
  await g.trayClick(3);
  await expect.poll(() => g.isMainVisible()).toBe(true);
});
