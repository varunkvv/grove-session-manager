import { expect, test } from "@playwright/test";
import { type Fixture, makeFixture } from "./helpers/fixture.ts";
import { groveTest, type LaunchedApp, launchApp } from "./helpers/launchApp.ts";
import { asAgent, writeProject } from "./helpers/project.ts";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/** two projects, a question to the person in each, and rows of other kinds under them */
function setup(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const auth = writeProject(fx, {
    name: "auth-sso",
    prefix: "AUTH",
    goal: "SSO for the dashboard",
  });
  const billing = writeProject(fx, {
    name: "billing-export",
    prefix: "BILL",
    goal: "Invoice exports",
  });
  const idp = asAgent(fx, auth.root, {
    sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
    name: "idp config",
  });
  idp("card_create", { title: "Point staging at okta" });
  idp("card_claim", { card: "AUTH-1" });
  idp("conclusion_record", {
    kind: "decision",
    what: "State and nonce go in a signed cookie.",
    why: "No redis round trip on the callback.",
    by: "agent",
    card: "AUTH-1",
  });
  idp("question_ask", { card: "AUTH-1", text: "A dev tenant, or the prod one?", to: "person" });
  const exporter = asAgent(fx, billing.root, {
    sessionId: "bbbbbbbb-0000-4000-8000-000000000002",
    name: "export job",
  });
  exporter("card_create", { title: "Export job skeleton" });
  exporter("card_claim", { card: "BILL-1" });
  exporter("question_ask", { card: "BILL-1", text: "csv only, or parquet too?", to: "person" });
  return fx;
}

/** the record is read after the page is up: wait for both questions to reach the tray */
async function ready(app: LaunchedApp) {
  const g = groveTest(app.app);
  await expect.poll(() => g.trayTitle(), { timeout: 15_000 }).toBe("2");
  return g;
}

test("the menu lists the three top rows across projects, Asked first, then Open Grove and Quit", async () => {
  app = await launchApp(setup());
  const g = await ready(app);
  const menu = await g.trayMenu();
  expect(menu).toHaveLength(6);
  // newest first among the Asked ones, whichever second each was written in
  expect(
    menu
      .slice(0, 2)
      .map((i) => [i.label, i.sublabel])
      .sort(),
  ).toEqual([
    ["Asked  AUTH-1 Point staging at okta", "auth-sso · A dev tenant, or the prod one?"],
    ["Asked  BILL-1 Export job skeleton", "billing-export · csv only, or parquet too?"],
  ]);
  expect(menu[2]?.label).toMatch(/^(Decided|New card) {2}(AUTH|BILL)-1 /);
  expect(menu.slice(3)).toEqual([{}, { label: "Open Grove" }, { role: "quit" }]);
});

test("the close button hides the window, the app stays, and Open Grove brings it back", async () => {
  app = await launchApp(setup());
  const g = await ready(app);
  expect(await g.isMainVisible()).toBe(true);
  await g.closeMain();
  await expect.poll(() => g.isMainVisible()).toBe(false);
  // still running, and the hidden page still answers
  expect((await app.page.evaluate(() => window.grove.bootstrap())).projects).toHaveLength(2);
  await g.trayClick(4);
  await expect.poll(() => g.isMainVisible()).toBe(true);
});

test("a row with a card shows the window on that card, in its project", async () => {
  app = await launchApp(setup());
  const g = await ready(app);
  const menu = await g.trayMenu();
  const billing = menu.findIndex((i) => i.label?.startsWith("Asked  BILL-1"));
  await g.closeMain();
  await expect.poll(() => g.isMainVisible()).toBe(false);
  await g.trayClick(billing);
  await expect.poll(() => g.isMainVisible()).toBe(true);
  // the screens are stubs until their own pieces: the shell says which one is on
  await expect(app.page.locator('[data-testid="screen"][data-view="card"]')).toBeAttached();
  await expect(app.page.getByTestId("project-switcher")).toContainText("billing-export");
  // the inbox is behind it
  await app.page.keyboard.press("Escape");
  await expect(app.page.locator('[data-testid="screen"][data-view="inbox"]')).toBeAttached();
});

test("--hidden starts with no visible window and a working page", async () => {
  app = await launchApp(setup(), {}, ["--hidden"]);
  const g = await ready(app);
  expect(await g.isMainVisible()).toBe(false);
  expect((await app.page.evaluate(() => window.grove.bootstrap())).inbox.tray).toBe(2);
  await g.trayClick(4);
  await expect.poll(() => g.isMainVisible()).toBe(true);
});
