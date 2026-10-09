import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type Fixture, hookEvent, makeFixture, writeSession } from "./helpers/fixture.ts";
import { groveTest, type LaunchedApp, launchApp } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

const ASKS = "aaaaaaaa-0000-4000-8000-000000000001";
const QUIET = "bbbbbbbb-0000-4000-8000-000000000002";
const CSV = "cccccccc-0000-4000-8000-000000000003";

let fx: Fixture;
let app: LaunchedApp;
let auth: { id: string; root: string };

test.afterEach(async () => {
  await app?.close();
});

/**
 * three projects as a 0.10 install left them, each with its card prefix. auth-sso has a session
 * that needs him and a quiet one, billing-export a quiet one, chat-features none
 */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  auth = writeProject(fx, {
    name: "auth-sso",
    goal: "SSO for the dashboard",
    prefix: "AUTH",
    // a key grove never read
    colour: "teal",
  });
  const billing = writeProject(fx, { name: "billing-export", prefix: "BILL" });
  writeProject(fx, { name: "chat-features", prefix: "CHAT" });
  writeSession(fx, { cwd: auth.root, sessionId: ASKS, title: "idp config" });
  writeSession(fx, { cwd: auth.root, sessionId: QUIET, title: "okta research", ageMs: 120_000 });
  writeSession(fx, { cwd: billing.root, sessionId: CSV, title: "csv columns", ageMs: 180_000 });
  hookEvent(fx, ASKS, "Stop", { last_assistant_message: "A dev tenant, or the prod one?" });
  return fx;
}

const combosFile = () => path.join(fx.root, "combos.json");
const combos = (): Array<Record<string, unknown>> =>
  JSON.parse(readFileSync(combosFile(), "utf8")).combos;
const item = (page: Page, id: string) =>
  page.locator(`[data-testid="project-item"][data-id="${id}"]`);
/** the projects the sidebar lists, in its order: the ones under Archived only while it is open */
const listed = (page: Page) =>
  page
    .getByTestId("project-item")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
const hue = (page: Page, id: string) =>
  item(page, id).getByTestId("project-mark").getAttribute("data-hue");
const toast = (page: Page, text: string) => page.getByTestId("toast").filter({ hasText: text });
/** the quiet rows of the list on screen, by title */
const quiet = (page: Page) => page.getByTestId("session-row");
const toggle = (page: Page) => page.getByTestId("archived-toggle");
const paletteItem = (page: Page, id: string) =>
  page.locator(`[data-testid="palette-item"][data-id="${id}"]`);

/** cmd-K, then the query. fill focuses the field itself, whatever window the machine is on */
async function ask(page: Page, query: string): Promise<void> {
  if (!(await page.getByTestId("palette").isVisible())) {
    await page.getByTestId("open-palette").click();
  }
  await page.getByTestId("palette-input").fill(query);
}

test("archive from cmd-K: the project goes under Archived, its quiet sessions leave All sessions, and Unarchive brings all of it back", async () => {
  app = await launchApp(seed());
  const { page } = app;
  const g = groveTest(app.app);

  // the home screen: one that needs him, and the two quiet ones under their day
  await expect(page.getByTestId("inbox-row")).toHaveCount(1, { timeout: 15_000 });
  await expect(quiet(page)).toHaveText([/okta research/, /csv columns/]);
  expect(await listed(page)).toEqual(["auth-sso", "billing-export", "chat-features"]);
  await expect(toggle(page)).toHaveCount(0);
  const colours = [await hue(page, "auth-sso"), await hue(page, "billing-export")];
  const before = combos();
  // every file of the project and when it was last written, once the launch has synced its hooks
  const files = () =>
    readdirSync(auth.root, { recursive: true })
      .map(String)
      .sort()
      .map((n) => [n, statSync(path.join(auth.root, n)).mtimeMs]);
  await expect
    .poll(() => existsSync(path.join(auth.root, ".claude", "settings.local.json")))
    .toBe(true);
  const onDisk = files();

  await item(page, "auth-sso").click();
  await expect(quiet(page)).toHaveCount(2);
  await ask(page, "archive");
  // the word is the command's: Enter runs it
  await expect(paletteItem(page, "archive-project")).toHaveText("Archive project");
  await expect(paletteItem(page, "archive-project")).toHaveAttribute("data-active", "true");
  await page.keyboard.press("Enter");

  // it says so, and the screen is All sessions: the project's row has left the list
  await expect(toast(page, "Archived auth-sso")).toBeVisible();
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
  await expect.poll(() => listed(page)).toEqual(["billing-export", "chat-features"]);
  // Archived is closed, with how many it holds, and it still says one of its sessions needs him
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page)).toHaveText(/^Archived\s*1\s*1$/);
  await expect(toggle(page).getByTestId("count")).toHaveText("1");

  // its quiet session is off the home screen. the one that needs him is not, and still counts
  await expect(quiet(page)).toHaveText([/csv columns/]);
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await expect(page.getByTestId("inbox-row")).toContainText("idp config");
  await expect(page.getByTestId("nav-inbox").getByTestId("count")).toHaveText("1");
  expect(await g.trayTitle()).toBe("1");

  // one key in combos.json. every other key, and every other project, is as it was
  expect(combos()).toEqual([{ ...before[0], archived: true }, before[1], before[2]]);
  expect(combos()[0]).toMatchObject({ prefix: "AUTH", colour: "teal" });
  // nothing on disk moved: not one file of the project was written, and nothing went to a trash
  expect(files()).toEqual(onDisk);
  expect(existsSync(path.join(fx.root, ".grove", "trash"))).toBe(false);

  // the keys step through the projects that are not archived
  await page.keyboard.press("Alt+ArrowDown");
  await expect(item(page, "billing-export")).toHaveAttribute("aria-current", "page");
  // cmd-K lists it only once something is typed, in a section of its own
  await ask(page, "");
  await expect(paletteItem(page, "project:billing-export")).toBeVisible();
  await expect(paletteItem(page, "project:auth-sso")).toHaveCount(0);
  await page.getByTestId("palette-input").fill("auth");
  await expect(
    page.getByRole("group", { name: "Archived" }).locator('[data-id="project:auth-sso"]'),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // opened, it lists the project with its count, and no colour has moved
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page).getByTestId("count")).toHaveCount(0);
  await expect.poll(() => listed(page)).toEqual(["billing-export", "chat-features", "auth-sso"]);
  await expect(item(page, "auth-sso").getByTestId("count")).toHaveText("1");
  expect([await hue(page, "auth-sso"), await hue(page, "billing-export")]).toEqual(colours);

  // its screen is its sessions, all of them. the top bar says what it is and how to bring it back
  await item(page, "auth-sso").click();
  await expect(page.getByTestId("project-name")).toHaveText("auth-sso");
  await expect(page.getByTestId("project-archived")).toHaveText("Archived");
  await expect(page.locator('[data-testid="session-row"]')).toHaveCount(2);
  await expect(page.getByTestId("new-session")).toHaveCount(0);
  await expect(page.getByTestId("open-project")).toBeVisible();
  await expect(page.getByTestId("edit-project")).toBeVisible();
  // the top bar is what the window is dragged by, and playwright's clicks never meet that: nothing
  // here that takes a click may be a drag region, Unarchive and the Archived group least of all
  const dragged = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, input")]
      .filter((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region") === "drag")
      .map((e) => e.dataset.testid ?? e.textContent),
  );
  expect(dragged).toEqual([]);
  await ask(page, "unarchive");
  await expect(paletteItem(page, "archive-project")).toHaveText("Unarchive project");
  await page.keyboard.press("Escape");

  await page.getByTestId("unarchive").click();
  await expect(toast(page, "Unarchived auth-sso")).toBeVisible();
  // it stays on the project, which is back in its place in the list
  await expect(page.getByTestId("project-name")).toHaveText("auth-sso");
  await expect(page.getByTestId("project-archived")).toHaveCount(0);
  await expect(page.getByTestId("new-session")).toBeVisible();
  await expect.poll(() => listed(page)).toEqual(["auth-sso", "billing-export", "chat-features"]);
  await expect(toggle(page)).toHaveCount(0);
  // the file is what it was: the key is gone, not false
  expect(combos()).toEqual(before);
  await page.keyboard.press("Meta+1");
  await expect(quiet(page)).toHaveText([/okta research/, /csv columns/]);

  // main refuses anything that is not a boolean, and a project it does not have
  const refused = await page.evaluate(async () => [
    await window.grove.setArchived("auth-sso", "yes" as never),
    await window.grove.setArchived("no-such-project", true),
  ]);
  expect(refused).toMatchObject([
    { ok: false, error: { code: "invalid" } },
    { ok: false, error: { code: "no-project" } },
  ]);
  expect(combos()).toEqual(before);
});

test("archive from the Edit project form, and a hand edit of combos.json is followed", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await expect(page.getByTestId("inbox-row")).toHaveCount(1, { timeout: 15_000 });

  await item(page, "billing-export").click();
  await page.getByTestId("edit-project").click();
  const archive = page.getByTestId("form-archive");
  await expect(archive).toHaveText("Archive");
  await expect(page.getByTestId("form-delete")).toHaveText("Delete…");
  await archive.click();
  await expect(toast(page, "Archived billing-export")).toBeVisible();
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
  await expect.poll(() => listed(page)).toEqual(["auth-sso", "chat-features"]);
  // nothing in it needs him: the group says how many it holds and no more
  await expect(toggle(page)).toHaveText(/^Archived\s*1$/);
  await expect(quiet(page)).toHaveText([/okta research/]);
  expect(combos()[1]).toMatchObject({ name: "billing-export", prefix: "BILL", archived: true });

  // going to it opens Archived by itself, and its form brings it back without leaving
  await page.keyboard.press("Meta+2");
  await expect(page.getByTestId("project-name")).toHaveText("billing-export");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(item(page, "billing-export")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("edit-project").click();
  await expect(archive).toHaveText("Unarchive");
  await archive.click();
  await expect(archive).toHaveText("Archive");
  await expect(page.getByTestId("project-form")).toHaveAttribute("data-mode", "edit");
  await expect.poll(() => listed(page)).toEqual(["auth-sso", "billing-export", "chat-features"]);
  expect("archived" in (combos()[1] ?? {})).toBe(false);

  // the file is hand-editable: a project archived there is put away here. the app takes a write
  // within a second and a half of its own for its own, so the hand waits that out
  await page.waitForTimeout(1_600);
  const file = JSON.parse(readFileSync(combosFile(), "utf8"));
  file.combos[2].archived = true;
  writeFileSync(combosFile(), JSON.stringify(file, null, 2));
  await expect(toggle(page)).toHaveText(/^Archived\s*1$/, { timeout: 15_000 });
  expect(await listed(page)).toEqual(["auth-sso", "billing-export"]);
  expect(readdirSync(fx.root)).toContain("chat-features");
});
