import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type Fixture, makeFixture } from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, step } from "./helpers/launchApp.ts";
import { asAgent, interrupted, liveSession, writeProject } from "./helpers/project.ts";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

const IDP = "aaaaaaaa-0000-4000-8000-000000000001";
const ROUTE = "bbbbbbbb-0000-4000-8000-000000000002";
const STORE = "cccccccc-0000-4000-8000-000000000003";

/** one project with a card in every display status, written the way agents write them */
function setup(): { root: string; idp: ReturnType<typeof asAgent> } {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "auth-sso",
    prefix: "AUTH",
    goal: "SSO for the dashboard",
  });
  const idp = asAgent(fx, root, { sessionId: IDP, name: "idp config" });
  const route = asAgent(fx, root, { sessionId: ROUTE, name: "callback route" });
  const store = asAgent(fx, root, { sessionId: STORE, name: "session store" });
  for (const title of [
    "Point staging at okta",
    "Callback route",
    "Session store",
    "Login page",
    "Logout",
    "Pick the IdP",
    "SAML fallback",
  ]) {
    idp("card_create", { title });
  }
  // waiting: its holder asked the person. the holder is a live VS Code tab
  idp("card_claim", { card: "AUTH-1" });
  idp("question_ask", { card: "AUTH-1", text: "A dev tenant, or the prod one?", to: "person" });
  liveSession(fx, { sessionId: IDP, kind: "interactive", entrypoint: "claude-vscode" });
  // done, then in progress in the background
  route("card_claim", { card: "AUTH-6" });
  route("card_done", { card: "AUTH-6", summary: "Okta. Auth0 has no SCIM on our plan." });
  route("card_claim", { card: "AUTH-2" });
  liveSession(fx, { sessionId: ROUTE, kind: "bg", status: "busy" });
  // stopped: its holder went away mid-turn
  store("card_claim", { card: "AUTH-3" });
  interrupted(fx, { [STORE]: Date.now() - 60_000 });
  idp("card_cancel", { card: "AUTH-7", reason: "Nobody on the pilot uses SAML." });
  return { root, idp };
}

async function openCards(page: Page): Promise<void> {
  await page.getByTestId("nav-cards").click();
  await expect(page.getByTestId("cards-header")).toBeVisible();
}

const idsIn = (page: Page, group: string) =>
  page
    .locator(`[data-testid="card-group"][data-group="${group}"] [data-testid="card-row"]`)
    .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.id));

test("cards sit in groups by display status, with who holds the live ones", async () => {
  setup();
  app = await launchApp(fx);
  const { page } = app;
  await openCards(page);
  await expect(page.getByTestId("card-row")).toHaveCount(7);

  await expect(page.getByTestId("cards-header").locator("h1")).toHaveText("auth-sso");
  await expect(page.getByTestId("goal")).toHaveText("SSO for the dashboard");
  // the canceled card is not part of the total
  await expect(page.getByTestId("done-count")).toHaveText("1 of 6 done");

  await expect
    .poll(() =>
      page
        .getByTestId("card-group")
        .evaluateAll((gs) => gs.map((g) => (g as HTMLElement).dataset.group)),
    )
    .toEqual(["waiting", "in_progress", "todo", "done", "canceled"]);
  await expect(page.getByTestId("card-group").first()).toContainText("Waiting on you2");
  // waiting and stopped share a group. the newest moves first, and both moved in the same instant here
  expect((await idsIn(page, "waiting")).sort()).toEqual(["AUTH-1", "AUTH-3"]);
  expect(await idsIn(page, "in_progress")).toEqual(["AUTH-2"]);
  // the backlog in the order it was written
  expect(await idsIn(page, "todo")).toEqual(["AUTH-4", "AUTH-5"]);
  expect(await idsIn(page, "done")).toEqual(["AUTH-6"]);
  expect(await idsIn(page, "canceled")).toEqual(["AUTH-7"]);

  const row = (id: string) => page.locator(`[data-testid="card-row"][data-id="${id}"]`);
  await expect(row("AUTH-1")).toHaveAttribute("data-status", "waiting");
  await expect(row("AUTH-1")).toContainText("idp config");
  await expect(row("AUTH-1").getByTestId("runtime-chip")).toHaveText("VS Code");
  // the question and the new card are both in the inbox
  await expect(row("AUTH-1").getByTestId("card-pending")).toHaveText("2");
  await expect(row("AUTH-2").getByTestId("runtime-chip")).toHaveText("Background");
  await expect(row("AUTH-3")).toHaveAttribute("data-status", "stopped");
  await expect(row("AUTH-3")).toContainText("session store");
  await expect(row("AUTH-3").getByTestId("runtime-chip")).toHaveText("Closed");
  // nobody holds these, and a closed card says nothing on the right
  for (const id of ["AUTH-4", "AUTH-6", "AUTH-7"]) {
    await expect(row(id).getByTestId("runtime-chip"), id).toHaveCount(0);
  }
});

test("a click opens a card, and so does the keyboard after it shows its row", async () => {
  setup();
  app = await launchApp(fx);
  const { page } = app;
  await openCards(page);
  const card = page.locator('[data-testid="screen"][data-view="card"]');

  await page.locator('[data-testid="card-row"][data-id="AUTH-4"]').click();
  await expect(card).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("card-row")).toHaveCount(7);

  // the mouse left AUTH-4 the keyboard's row. the first Enter only shows it
  const active = page.locator('[data-testid="card-row"][data-active]');
  const at = (id: string) => expect(active).toHaveAttribute("data-id", id, { timeout: 2_000 });
  await step(async () => {
    // only while no row shows: a second Enter would open the card
    if ((await active.count()) === 0) await page.keyboard.press("Enter");
    await at("AUTH-4");
  });
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "Cards" })).toHaveAttribute(
    "aria-activedescendant",
    "row-AUTH-4",
  );
  await step(async () => {
    // an arrow while no row shows only shows it: the second one moves
    if ((await active.count()) === 0) await page.keyboard.press("ArrowDown");
    if ((await active.getAttribute("data-id")) === "AUTH-4") await page.keyboard.press("ArrowDown");
    await at("AUTH-5");
  });
  await step(async () => {
    if ((await card.count()) === 0) {
      if ((await active.count()) === 0) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    }
    await expect(card).toBeAttached({ timeout: 2_000 });
  });
});

test("a card an agent writes while the app is open shows up", async () => {
  const { idp } = setup();
  app = await launchApp(fx);
  const { page } = app;
  await openCards(page);
  await expect(page.getByTestId("card-row")).toHaveCount(7);

  idp("card_create", { title: "Rate limit the callback" });
  const row = page.locator('[data-testid="card-row"][data-id="AUTH-8"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute("data-status", "todo");
  await expect(row).toContainText("Rate limit the callback");
  expect(await idsIn(page, "todo")).toEqual(["AUTH-4", "AUTH-5", "AUTH-8"]);
});

test("a card file cut in half shows its problem, and the other cards are all there", async () => {
  const { root } = setup();
  const file = path.join(root, "cards", "AUTH-4", "card.md");
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.slice(0, Math.floor(text.length / 2)));
  app = await launchApp(fx);
  const { page } = app;
  await openCards(page);

  await expect(page.getByTestId("card-row")).toHaveCount(7);
  const cut = page.locator('[data-testid="card-row"][data-id="AUTH-4"]');
  await expect(cut.getByTestId("problem")).toHaveAttribute("aria-label", "Read with problems");
  await expect(page.getByTestId("problem")).toHaveCount(1);
});

test("a project with no cards shows the start state in place of the groups", async () => {
  fx = makeFixture({ withCompanion: true });
  writeProject(fx, { name: "billing-export", prefix: "BILL", goal: "Invoice exports" });
  app = await launchApp(fx);
  const { page } = app;
  await openCards(page);

  const start = page.getByTestId("start-state");
  await expect(start).toHaveAttribute("data-case", "ready");
  await expect(start).toContainText("No cards yet.");
  await expect(start).toContainText("Agents create cards as they work. Start one on the goal.");
  await expect(page.getByTestId("start-editor")).toHaveText("Start an agent in VS Code");
  await expect(page.getByTestId("start-background")).toHaveText("Start in the background");
  await expect(page.getByTestId("card-group")).toHaveCount(0);
  await expect(page.getByTestId("done-count")).toHaveCount(0);
});
