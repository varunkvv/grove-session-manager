import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type Fixture, makeFixture, makePlainDir, writeUsage } from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

const AUTH = "aaaaaaaa-0000-4000-8000-000000000001";
const BILLING = "bbbbbbbb-0000-4000-8000-000000000002";
const LOOSE = "cccccccc-0000-4000-8000-000000000003";
const M = 1_000_000;

let fx: Fixture;
let app: LaunchedApp;
let billingFile: string;

test.afterEach(async () => {
  await app?.close();
});

/**
 * two projects and a folder in neither, with usage on known days. opus 5.5 is $20 a million
 * output tokens and haiku 4.5 $1 a million input, so:
 *   today        auth-sso   1M out, 30 min   $20     and its subagent, haiku 1M in, 10 min   $1
 *   3 days ago   auth-sso   0.5M out, 20 min $10
 *   10 days ago  billing    2M out, 45 min   $40
 *   100 days ago no project 5M out, 15 min   $100
 */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const auth = writeProject(fx, { name: "auth-sso" });
  const billing = writeProject(fx, { name: "billing" });
  writeUsage(fx, {
    cwd: auth.root,
    sessionId: AUTH,
    title: "idp config",
    days: [
      { back: 0, output: M, minutes: 30 },
      { back: 3, output: M / 2, minutes: 20 },
    ],
  });
  writeUsage(fx, {
    cwd: auth.root,
    sessionId: AUTH,
    agent: "a1",
    days: [{ back: 0, model: "claude-haiku-4-5-20251001", input: M, minutes: 10 }],
  });
  billingFile = writeUsage(fx, {
    cwd: billing.root,
    sessionId: BILLING,
    title: "csv columns",
    days: [{ back: 10, output: 2 * M, minutes: 45 }],
  });
  writeUsage(fx, {
    cwd: makePlainDir(fx, "dotfiles"),
    sessionId: LOOSE,
    title: "zsh startup",
    days: [{ back: 100, output: 5 * M, minutes: 15 }],
  });
  return fx;
}

const tile = (page: Page, metric: string) =>
  page.getByTestId(`tile-${metric}`).getByTestId("tile-value");
const range = (page: Page, r: string) => page.getByTestId(`range-${r}`).click();
const bars = (page: Page) => page.getByTestId("usage-bar");
/** the names of a list under the chart, in its order */
const rows = async (page: Page, list: string) =>
  (await page.getByTestId(list).getByTestId("usage-row").allInnerTexts()).map(
    (t) => t.split("\n")[0],
  );

test("Usage: the sidebar opens it, and each range has its totals, its bars and its lists", async () => {
  app = await launchApp(seed());
  const { page } = app;

  // one item under All sessions, with no number on it: nothing of this shows anywhere else
  const nav = page.getByTestId("nav-usage");
  await expect(nav.getByTestId("count")).toHaveCount(0);
  await nav.click();
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "usage");
  await expect(nav).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-inbox")).not.toHaveAttribute("aria-current");

  // the week it opens on, once every transcript is counted
  await expect(tile(page, "cost")).toHaveText("$31", { timeout: 20_000 });
  await expect(page.getByTestId("usage-counting")).toHaveCount(0);
  await expect(tile(page, "time")).toHaveText("1h");
  await expect(tile(page, "tokens")).toHaveText("2.5M");
  await expect(page.getByTestId("range-1W")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("tile-cost")).toHaveAttribute("aria-checked", "true");
  await expect(bars(page)).toHaveCount(7);
  // today's bar is the agent's session and its subagent: $21
  await expect(bars(page).last()).toHaveAttribute("data-total", "21");
  expect(await rows(page, "by-project")).toEqual(["auth-sso"]);
  expect(await rows(page, "by-model")).toEqual(["opus 5.5", "haiku 4.5"]);
  // the session and its subagent worked the same five minutes
  await expect(page.getByTestId("extra-sessions")).toHaveText("1");
  await expect(page.getByTestId("extra-subagents")).toHaveText("1");
  await expect(page.getByTestId("extra-peak")).toHaveText("2");
  await expect(page.getByTestId("extra-longest")).toHaveText("30m");
  // $31 against the $40 of ten days ago
  const note = page.getByTestId("tile-cost").getByTestId("tile-note");
  await expect(note).toHaveText("-22% vs the week before");

  await range(page, "1M");
  await expect(tile(page, "cost")).toHaveText("$71");
  await expect(tile(page, "time")).toHaveText("1h 45m");
  await expect(tile(page, "tokens")).toHaveText("4.5M");
  await expect(bars(page)).toHaveCount(30);
  expect(await rows(page, "by-project")).toEqual(["billing", "auth-sso"]);
  // nothing in the thirty days before these: no change line, not a percentage of nothing
  await expect(note).toHaveText("");

  await range(page, "1Y");
  await expect(tile(page, "cost")).toHaveText("$171");
  await expect(tile(page, "time")).toHaveText("2h");
  await expect(tile(page, "tokens")).toHaveText("9.5M");
  await expect(bars(page)).toHaveCount(52);
  // the folder in no project is one row, and one grey part of its bar
  expect(await rows(page, "by-project")).toEqual(["No project", "billing", "auth-sso"]);
  await expect(page.locator('[data-testid="usage-bar"] [data-slice="none"]')).toHaveCount(52);
});

test("a tile picks what the bars measure, and a bar says its split when pointed at or reached by the keyboard", async () => {
  app = await launchApp(seed());
  const { page } = app;
  // cmd-3, beside cmd-1 and cmd-2
  await expect(page.getByTestId("nav-inbox")).toHaveAttribute("aria-current", "page");
  await expect(async () => {
    await page.keyboard.press("Meta+3");
    await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "usage", {
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(tile(page, "cost")).toHaveText("$31", { timeout: 20_000 });
  const chart = page.getByTestId("usage-chart");
  await expect(chart).toHaveAttribute("data-metric", "cost");

  await page.getByTestId("tile-time").click();
  await expect(page.getByTestId("tile-time")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("tile-cost")).toHaveAttribute("aria-checked", "false");
  await expect(chart).toHaveAttribute("data-metric", "time");
  // 30 minutes of the session and 10 of its subagent
  await expect(bars(page).last()).toHaveAttribute("data-total", String(40 * 60_000));
  // the tiles keep their own numbers whichever is picked
  await expect(tile(page, "cost")).toHaveText("$31");

  await page.getByTestId("tile-tokens").click();
  await expect(chart).toHaveAttribute("data-metric", "tokens");
  await expect(bars(page).last()).toHaveAttribute("data-total", String(2 * M));

  // pointed at: the period, the total and the split
  await page.getByTestId("tile-cost").click();
  await bars(page).last().hover();
  const tip = page.getByTestId("bar-tip");
  await expect(tip).toContainText("$21");
  await expect(tip).toContainText("auth-sso");
  await expect(page.getByTestId("usage-plot")).toHaveAttribute("data-hot", "true");
  await page.mouse.move(10, 300);
  await expect(tip).toHaveCount(0);

  // the keyboard: one stop, on today's bar, and the arrows walk back
  await page.getByTestId("usage-plot").focus();
  await expect(tip).toContainText("$21");
  await page.keyboard.press("ArrowLeft");
  await expect(tip).toContainText("No usage");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(tip).toContainText("$10");
  await page.keyboard.press("End");
  await expect(tip).toContainText("$21");

  // a range with nothing in it says so
  await app.close();
  const quiet = makeFixture({ withCompanion: true });
  writeUsage(quiet, {
    cwd: writeProject(quiet, { name: "auth-sso" }).root,
    sessionId: AUTH,
    days: [{ back: 20, output: M, minutes: 5 }],
  });
  app = await launchApp(quiet);
  await app.page.getByTestId("nav-usage").click();
  await expect(app.page.getByTestId("usage-empty")).toHaveText("No usage in this range", {
    timeout: 20_000,
  });
  await expect(app.page.getByTestId("usage-chart")).toHaveCount(0);
  await range(app.page, "1M");
  await expect(tile(app.page, "cost")).toHaveText("$20", { timeout: 20_000 });
  await expect(bars(app.page)).toHaveCount(30);
});

test("a deleted transcript's numbers are still there after a rescan, and after a restart", async () => {
  app = await launchApp(seed());
  let { page } = app;
  await page.getByTestId("nav-usage").click();
  await range(page, "1M");
  await expect(tile(page, "cost")).toHaveText("$71", { timeout: 20_000 });

  // what Claude Code does to a transcript after thirty days
  unlinkSync(billingFile);
  expect((await page.evaluate(() => window.grove.refresh())).ok).toBe(true);
  // the session has left the lists
  await expect
    .poll(() => page.evaluate(async () => (await window.grove.listSessions("billing")).length))
    .toBe(0);
  // and its days are kept, in its project
  const retired = path.join(fx.root, ".grove", "usage-retired.json");
  await expect.poll(() => existsSync(retired), { timeout: 15_000 }).toBe(true);
  expect(Object.keys(JSON.parse(readFileSync(retired, "utf8")).retired)).toEqual([billingFile]);
  await page.getByTestId("nav-inbox").click();
  await page.getByTestId("nav-usage").click();
  await range(page, "1M");
  await expect(tile(page, "cost")).toHaveText("$71");
  await expect(tile(page, "time")).toHaveText("1h 45m");
  expect(await rows(page, "by-project")).toEqual(["billing", "auth-sso"]);

  await app.close();
  app = await launchApp(fx);
  page = app.page;
  await page.getByTestId("nav-usage").click();
  await range(page, "1M");
  await expect(tile(page, "cost")).toHaveText("$71", { timeout: 20_000 });
  expect(await rows(page, "by-project")).toEqual(["billing", "auth-sso"]);
});
