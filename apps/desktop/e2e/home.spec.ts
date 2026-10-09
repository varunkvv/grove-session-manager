import { expect, type Page, test } from "@playwright/test";
import {
  type Fixture,
  hookEvent,
  makeFixture,
  makePlainDir,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, step } from "./helpers/launchApp.ts";
import { liveSession, writeProject } from "./helpers/project.ts";

const sid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const SID = {
  turn: sid(1),
  failed: sid(2),
  working: sid(3),
  today: sid(4),
  /** in no project */
  loose: sid(5),
};
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** three quiet sessions of the days before, `sid(10)` on: a day, two and three days back */
const AGES = [26 * HOUR, 50 * HOUR, 74 * HOUR];
/** 120 sessions of the weeks before that, `sid(OLD)` on, newest first */
const OLD = 100;

/** midnight, this many days back, by the calendar */
const midnight = (back: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
};
/** the group a session that last moved this long ago is in, worked out as the app does */
const day = (ageMs: number) => {
  const back = [0, 1, 2, 3].findIndex((n) => Date.now() - ageMs >= midnight(n));
  return ["today", "yesterday", "day-2", "day-3"][back] ?? "older";
};

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/**
 * two projects and a folder outside them: two sessions that need him, one working, two of today
 * (one of them in no project), three of the days before, and 120 older than that
 */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const auth = writeProject(fx, { name: "auth-sso" }).root;
  const billing = writeProject(fx, { name: "billing-export" }).root;
  writeSession(fx, { cwd: auth, sessionId: SID.turn, title: "idp config" });
  hookEvent(fx, SID.turn, "Stop", { last_assistant_message: "A dev tenant, or the prod one?" });
  writeSession(fx, { cwd: billing, sessionId: SID.failed, title: "export job" });
  hookEvent(fx, SID.failed, "StopFailure", { message: "API Error: 529 Overloaded" });
  writeSession(fx, {
    cwd: auth,
    sessionId: SID.working,
    title: "login page",
    lastPrompt: "wire the login form to the new endpoint",
  });
  liveSession(fx, {
    sessionId: SID.working,
    kind: "interactive",
    entrypoint: "cli",
    status: "busy",
  });
  // its turn started twelve minutes ago
  hookEvent(fx, SID.working, "UserPromptSubmit", {}, 12 * MIN + 5_000);
  writeSession(fx, { cwd: billing, sessionId: SID.today, title: "csv columns", ageMs: 5 * MIN });
  writeSession(fx, {
    cwd: makePlainDir(fx, "scratch"),
    sessionId: SID.loose,
    title: "notes",
    ageMs: 10 * MIN,
  });
  AGES.forEach((ageMs, i) => {
    writeSession(fx, { cwd: auth, sessionId: sid(10 + i), title: `the day before ${i}`, ageMs });
  });
  for (let i = 0; i < 120; i++) {
    writeSession(fx, {
      cwd: i % 2 ? auth : billing,
      sessionId: sid(OLD + i),
      title: `old ${i}`,
      ageMs: (5 + i) * DAY,
    });
  }
  return fx;
}

const needs = (page: Page) => page.getByTestId("inbox-row");
const rows = (page: Page) => page.getByTestId("session-row");
const row = (page: Page, id: string) =>
  page.locator(`[data-testid="session-row"][data-id="${id}"]`);
const group = (page: Page, key: string) =>
  page.locator(`[data-testid="session-group"][data-group="${key}"]`);
const older = (page: Page) => page.getByTestId("older-toggle");
const inOlder = (page: Page) => group(page, "older").getByTestId("session-row");
const panel = (page: Page) => page.getByTestId("session-panel");
const active = (page: Page) => page.locator('[role="option"][data-active]');
/** the sessions of the days before that are in Older by now: it depends on the hour */
const AGED = AGES.filter((a) => day(a) === "older").length;

/** every session indexed: the ones that need him come with the page, the rest a moment later */
async function ready(page: Page): Promise<void> {
  await expect(needs(page)).toHaveCount(2, { timeout: 15_000 });
  await expect(older(page)).toHaveText(`Older${120 + AGED}`, { timeout: 20_000 });
}

test("the home screen is every session: the ones that need him first, the working with what it was asked, then by day, and Older folded away", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
  await expect(page.getByRole("listbox")).toHaveAttribute("aria-label", "All sessions");

  // the groups, in order. empty ones are not there
  const days = ["today", ...AGES.map(day)].filter((d, i, all) => all.indexOf(d) === i);
  expect(
    await page
      .getByTestId("session-group")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group)),
  ).toEqual([...new Set(["needs", "working", ...days, "older"])]);

  // Needs you is the inbox's rows, as they were: two lines, what it asks, its project
  await expect(group(page, "needs")).toContainText("Needs you2");
  await expect(group(page, "needs").getByTestId("inbox-row")).toHaveCount(2);
  const turn = page.locator(`[data-testid="inbox-row"][data-id="${SID.turn}"]`);
  await expect(turn.getByTestId("inbox-summary")).toHaveText("A dev tenant, or the prod one?");
  await expect(turn.getByTestId("inbox-project")).toHaveText("auth-sso");
  // only they count in the sidebar: the working and the quiet ones are not his to answer
  await expect(page.getByTestId("nav-inbox").getByTestId("count")).toHaveText("2");

  // a working one: its state, what it was last asked on a second line, how long the turn has run
  const working = row(page, SID.working);
  await expect(group(page, "working").getByTestId("session-row")).toHaveCount(1);
  await expect(working).toContainText("login page");
  await expect(working.getByTestId("state")).toHaveText("Working");
  await expect(working.getByTestId("session-doing")).toHaveText(
    "wire the login form to the new endpoint",
  );
  await expect(working).toContainText(/for 1[23]m/);
  await expect(working.getByTestId("session-project")).toHaveText("auth-sso");
  await expect(working.getByTestId("runtime-chip")).toHaveText("Terminal");

  // a quiet one is one line: its project with its colour, where it runs, when
  const today = row(page, SID.today);
  await expect(today).toContainText("csv columns");
  await expect(today.getByTestId("session-project")).toHaveText("billing-export");
  await expect(today.getByTestId("state")).toHaveCount(0);
  await expect(today.getByTestId("session-doing")).toHaveCount(0);
  const hue = (id: string) =>
    page
      .locator(`[data-testid="project-item"][data-id="${id}"]`)
      .getByTestId("project-mark")
      .getAttribute("data-hue");
  expect(await today.getByTestId("project-mark").getAttribute("data-hue")).toBe(
    await hue("billing-export"),
  );
  // a session in no project: its folder's name, and no mark
  const loose = row(page, SID.loose);
  await expect(loose.getByTestId("session-project")).toHaveText("scratch");
  await expect(loose.getByTestId("project-mark")).toHaveCount(0);
  await expect(group(page, "today").getByTestId("session-row")).toHaveCount(2);

  // the days before today by name: yesterday, then the weekday
  for (const [i, ageMs] of AGES.entries()) {
    const d = day(ageMs);
    if (d === "older") continue;
    await expect(group(page, d).locator(`[data-id="${sid(10 + i)}"]`)).toHaveCount(1);
    const back = Number(d.slice(4));
    if (back) {
      const name = new Date(midnight(back)).toLocaleDateString("en-US", { weekday: "long" });
      await expect(group(page, d)).toContainText(name);
    } else await expect(group(page, d)).toContainText("Yesterday");
  }

  // Older says how many it holds, and draws none until its header is pressed
  await expect(older(page)).toHaveAttribute("aria-expanded", "false");
  await expect(inOlder(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1 + 2 + AGES.length - AGED);
  await older(page).click();
  await expect(older(page)).toHaveAttribute("aria-expanded", "true");
  // a page of it, newest first
  await expect(inOlder(page)).toHaveCount(50);
  await expect(inOlder(page).nth(AGED)).toHaveAttribute("data-id", sid(OLD));

  // the next page is drawn when the end of this one comes near, and so on to the last
  const scroller = page.getByTestId("inbox");
  const toEnd = () => scroller.evaluate((e) => e.scrollTo(0, e.scrollHeight));
  await toEnd();
  await expect(inOlder(page)).toHaveCount(100);
  await toEnd();
  await expect(inOlder(page)).toHaveCount(120 + AGED);
  await expect(inOlder(page).last()).toHaveAttribute("data-id", sid(OLD + 119));
  await expect(page.getByTestId("older-more")).toHaveCount(0);

  // closed from its header, and closed again whenever the screen comes up
  await older(page).scrollIntoViewIfNeeded();
  await older(page).click();
  await expect(inOlder(page)).toHaveCount(0);
  await older(page).click();
  await expect(inOlder(page)).toHaveCount(50);
  await page.locator('[data-testid="project-item"][data-id="auth-sso"]').click();
  await expect(page.getByTestId("project-name")).toHaveText("auth-sso");
  await page.getByTestId("nav-inbox").click();
  await expect(older(page)).toHaveAttribute("aria-expanded", "false");
  await expect(inOlder(page)).toHaveCount(0);
});

test("the keyboard walks the rows that are drawn: never into a closed Older, and through an open one a page at a time", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  const press = async (...keys: string[]) => {
    for (const k of keys) await page.keyboard.press(k);
  };
  /** the last row drawn outside Older */
  const lastDrawn = await rows(page).last().getAttribute("data-id");

  // closed: the end of the list is the last row of the days, not a row nobody sees
  await step(async () => {
    await press("Meta+ArrowDown");
    await expect(active(page)).toHaveAttribute("data-id", lastDrawn as string, { timeout: 2_000 });
  });
  await step(async () => {
    await press("Meta+ArrowDown", "ArrowDown");
    await expect(active(page)).toHaveAttribute("data-id", lastDrawn as string, { timeout: 2_000 });
  });

  // open: the end is the fiftieth of Older, and an arrow past it draws the next fifty and lands there
  await older(page).click();
  await expect(inOlder(page)).toHaveCount(50);
  const at = (n: number) => sid(OLD + n - AGED);
  await step(async () => {
    await press("Meta+ArrowDown");
    await expect(active(page)).toHaveAttribute("data-id", at(49), { timeout: 2_000 });
  });
  await step(async () => {
    if ((await inOlder(page).count()) === 50) await press("Meta+ArrowDown", "ArrowDown");
    await expect(inOlder(page)).toHaveCount(100, { timeout: 2_000 });
    await expect(active(page)).toHaveAttribute("data-id", at(50), { timeout: 2_000 });
  });
  await expect(active(page)).toBeInViewport();

  // Enter opens it in the panel, and the panel follows the arrows through Older
  await step(async () => {
    await press("Enter");
    await expect(panel(page)).toHaveAttribute("data-id", at(50), { timeout: 2_000 });
  });
  await step(async () => {
    if ((await panel(page).getAttribute("data-id")) === at(50)) await press("ArrowDown");
    await expect(panel(page)).toHaveAttribute("data-id", at(51), { timeout: 2_000 });
  });
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText(`old ${51 - AGED}`);

  // closing Older takes the panel with it: nothing is open on a row nobody sees
  await older(page).scrollIntoViewIfNeeded();
  await older(page).click();
  await expect(inOlder(page)).toHaveCount(0);
  await expect(page.getByTestId("panel")).toHaveCount(0);
});

test("with no session anywhere the home screen says so, and nothing about what needs him", async () => {
  fx = makeFixture({ withCompanion: true });
  writeProject(fx, { name: "auth-sso" });
  app = await launchApp(fx);
  const { page } = app;
  await expect(page.getByTestId("inbox-empty")).toContainText("No sessions yet.");
  await expect(page.getByTestId("inbox-empty")).toContainText(
    "Sessions from every project show here, and the ones started outside one.",
  );
  await expect(page.getByTestId("session-group")).toHaveCount(0);
});
