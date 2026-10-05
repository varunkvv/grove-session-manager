import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  type Fixture,
  makeFixture,
  makePlainDir,
  pendingIntents,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, step, waitFor } from "./helpers/launchApp.ts";
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

/** the sessions are indexed after the page is up, and the Cards screen asks for them when it mounts */
const sessionsIndexed = (page: Page, project: string, count: number) =>
  page.waitForFunction(
    async ([id, n]) => (await window.grove.projectSessions(id)).length === n,
    [project, count] as const,
    { timeout: 30_000 },
  );

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
  // every session here holds a card, or has no transcript: there is no Sessions group to show
  await expect(page.getByTestId("sessions-group")).toHaveCount(0);
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

const free = (i: number) => `1212121${i}-0000-4000-8000-000000000000`;

test("sessions that hold no card are listed under the cards, and open from the button or a double-click", async () => {
  const { root } = setup();
  // the holder of AUTH-1 has a transcript, and so do ten sessions that hold nothing
  writeSession(fx, { cwd: root, sessionId: IDP, title: "idp config" });
  for (let i = 0; i < 10; i++) {
    writeSession(fx, {
      cwd: root,
      sessionId: free(i),
      title: `scratch ${i}`,
      ageMs: (i + 1) * 60_000,
    });
  }
  // one started in a subfolder: Open would take it to that folder's own window
  const trial = path.join(root, "artifacts", "trial");
  mkdirSync(trial, { recursive: true });
  writeSession(fx, {
    cwd: trial,
    sessionId: "eeeeeeee-0000-4000-8000-000000000005",
    title: "scripted run",
    ageMs: 1000,
  });
  // and one in a folder no project has
  writeSession(fx, {
    cwd: makePlainDir(fx, "elsewhere"),
    sessionId: "dddddddd-0000-4000-8000-000000000004",
    title: "quarterly numbers",
  });
  app = await launchApp(fx);
  const { page } = app;
  await sessionsIndexed(page, "auth-sso", 10);
  await openCards(page);

  const group = page.getByTestId("sessions-group");
  const rows = group.getByTestId("session-row");
  const shown = () => rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
  const codeRuns = () => readExecLog(fx).filter((l) => l.bin === "code");
  const toast = (text: string) => page.getByTestId("toast").filter({ hasText: text });

  // eight, newest first. the holder is on its card's row, and the other two are the palette's
  await expect(rows).toHaveCount(8);
  expect(await shown()).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(free));
  await expect(group).toContainText("Sessions");
  await expect(group).not.toContainText("idp config");
  await expect(group).not.toContainText("scripted run");
  await expect(group).not.toContainText("quarterly numbers");
  // under the card groups and outside the list the arrows move in
  await expect(page.getByTestId("card-group").last()).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Cards" }).getByTestId("session-row")).toHaveCount(
    0,
  );
  const first = rows.first();
  await expect(first.getByTestId("runtime-chip")).toHaveText("Closed");
  await expect(first).toContainText("scratch 0");
  await expect(first).toContainText("1m ago");
  // the button is there without a hover, and is a tab stop like any other
  const open = first.getByTestId("session-open");
  await expect(open).toBeVisible();
  await expect(open).toHaveText("Open in VS Code");
  await expect(open).not.toHaveAttribute("tabindex");

  // the button: the project's window, and an intent that names the session
  await open.click();
  await expect(toast("Opening scratch 0 in VS Code")).toBeVisible();
  await waitFor(async () => codeRuns().length === 1);
  expect(codeRuns()[0]?.argv[0]).toMatch(/auth-sso\.code-workspace$/);
  expect(pendingIntents(fx)).toMatchObject([{ kind: "resume", sessionId: free(0), cwd: root }]);

  await expect(page.getByTestId("sessions-all")).toHaveText("Show all 10");
  await page.getByTestId("sessions-all").click();
  await expect(rows).toHaveCount(10);
  await expect(page.getByTestId("sessions-all")).toHaveCount(0);

  // a double-click anywhere on a row opens it, once
  await rows.nth(9).dblclick({ position: { x: 240, y: 18 } });
  await expect(toast("Opening scratch 9 in VS Code")).toBeVisible();
  await waitFor(async () => codeRuns().length === 2);
  expect(codeRuns()[1]?.argv[0]).toMatch(/auth-sso\.code-workspace$/);
  expect(pendingIntents(fx).map((i) => i.sessionId)).toContain(free(9));
  await page.waitForTimeout(500);
  expect(codeRuns()).toHaveLength(2);

  // a session that claims a card leaves the group for its card's row: the record changed, so the
  // screen asked again
  asAgent(fx, root, { sessionId: free(1), name: "scratch 1" })("card_claim", { card: "AUTH-4" });
  await expect(rows).toHaveCount(9, { timeout: 15_000 });
  expect(await shown()).not.toContain(free(1));
});

test("a project with no cards shows the start state in place of the groups", async () => {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "billing-export",
    prefix: "BILL",
    goal: "Invoice exports",
  });
  writeSession(fx, { cwd: root, sessionId: STORE, title: "invoice columns" });
  app = await launchApp(fx);
  const { page } = app;
  await sessionsIndexed(page, "billing-export", 1);
  await openCards(page);

  const start = page.getByTestId("start-state");
  await expect(start).toHaveAttribute("data-case", "ready");
  await expect(start).toContainText("No cards yet.");
  await expect(start).toContainText("Agents create cards as they work. Start one on the goal.");
  await expect(page.getByTestId("start-editor")).toHaveText("Start an agent in VS Code");
  await expect(page.getByTestId("start-background")).toHaveText("Start in the background");
  await expect(page.getByTestId("card-group")).toHaveCount(0);
  await expect(page.getByTestId("done-count")).toHaveCount(0);

  // the sessions the project already has are under it, with no Show all for one
  const group = page.getByTestId("sessions-group");
  await expect(group.getByTestId("session-row")).toHaveCount(1);
  await expect(group.getByTestId("session-row")).toContainText("invoice columns");
  await expect(group.getByTestId("session-open")).toHaveText("Open in VS Code");
  await expect(page.getByTestId("sessions-all")).toHaveCount(0);
  const [above, below] = await Promise.all([start.boundingBox(), group.boundingBox()]);
  expect((below?.y ?? 0) >= (above?.y ?? 0) + (above?.height ?? 0)).toBe(true);
});
