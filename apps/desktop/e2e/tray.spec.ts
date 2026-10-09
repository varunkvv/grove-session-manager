import { expect, test } from "@playwright/test";
import { type Fixture, hookEvent, makeFixture, writeSession } from "./helpers/fixture.ts";
import { groveTest, type LaunchedApp, launchApp } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

const IDP = "aaaaaaaa-0000-4000-8000-000000000001";
const EXPORT = "bbbbbbbb-0000-4000-8000-000000000002";
const QUIET = "cccccccc-0000-4000-8000-000000000003";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/**
 * two projects, and in each a session whose turn ended on a question. a third session needs
 * nothing: the home screen lists it, the tray and the counts do not
 */
function setup(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const auth = writeProject(fx, {
    name: "auth-sso",
    goal: "SSO for the dashboard",
  });
  const billing = writeProject(fx, { name: "billing-export" });
  writeSession(fx, { cwd: auth.root, sessionId: IDP, title: "idp config" });
  writeSession(fx, { cwd: billing.root, sessionId: EXPORT, title: "export job" });
  writeSession(fx, { cwd: billing.root, sessionId: QUIET, title: "csv columns" });
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

/** where Open Grove is: the rows above it come and go */
const openGrove = async (g: Awaited<ReturnType<typeof ready>>) =>
  (await g.trayMenu()).findIndex((i) => i.label === "Open Grove");

test("the menu lists the newest rows across projects, what is working, then Open Grove and Quit", async () => {
  app = await launchApp(setup());
  const g = await ready(app);
  const menu = await g.trayMenu();
  expect(menu).toHaveLength(7);
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
  expect(menu.slice(2)).toEqual([
    {},
    { label: "The Mac can sleep · nothing working", enabled: false },
    {},
    { label: "Open Grove" },
    { role: "quit" },
  ]);
});

test("a working session is listed under what keeps the Mac awake, and a click shows it", async () => {
  app = await launchApp(setup());
  const g = await ready(app);
  hookEvent(fx, QUIET, "UserPromptSubmit");
  // the turn is seconds old, and the menu counts in minutes
  const row = { label: "csv columns", sublabel: "billing-export · just started" };
  await expect.poll(() => g.trayMenu(), { timeout: 15_000 }).toContainEqual(row);
  const menu = await g.trayMenu();
  const at = menu.findIndex((i) => i.label === row.label);
  expect(menu[at - 1]).toEqual({
    label: "Keeping the Mac awake · 1 working · just started",
    enabled: false,
  });
  // it needs nothing, so the count is the two that do
  expect(await g.trayTitle()).toBe("2");
  await g.closeMain();
  await expect.poll(() => g.isMainVisible()).toBe(false);
  await g.trayClick(at);
  await expect.poll(() => g.isMainVisible()).toBe(true);
  await expect(app.page.getByTestId("session-panel")).toHaveAttribute("data-id", QUIET);

  // its turn ends, and nothing keeps the Mac awake
  hookEvent(fx, QUIET, "Stop", { last_assistant_message: "Comma or tab?" });
  await expect
    .poll(async () => (await g.trayMenu()).map((i) => i.label), { timeout: 15_000 })
    .toContain("The Mac can sleep · nothing working");
});

test("the close button hides the window, the app stays, and Open Grove brings it back", async () => {
  app = await launchApp(setup());
  const g = await ready(app);
  expect(await g.isMainVisible()).toBe(true);
  await g.closeMain();
  await expect.poll(() => g.isMainVisible()).toBe(false);
  // still running, and the hidden page still answers
  expect((await app.page.evaluate(() => window.grove.bootstrap())).projects).toHaveLength(2);
  await g.trayClick(await openGrove(g));
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
  // the home screen lists the session that needs nothing too. the tray never counted it
  await expect(app.page.locator(`[data-testid="session-row"][data-id="${QUIET}"]`)).toHaveCount(1);
  expect(await g.trayTitle()).toBe("2");
});

test("--hidden starts with no visible window and a working page", async () => {
  app = await launchApp(setup(), {}, ["--hidden"]);
  const g = await ready(app);
  expect(await g.isMainVisible()).toBe(false);
  expect((await app.page.evaluate(() => window.grove.bootstrap())).inbox.rows).toHaveLength(2);
  await g.trayClick(await openGrove(g));
  await expect.poll(() => g.isMainVisible()).toBe(true);
});
