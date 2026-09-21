import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { type Fixture, makeFixture, makePlainDir, writeSession } from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp } from "./helpers/launchApp.ts";

const CANVAS = { dark: "rgb(31, 30, 29)", light: "rgb(250, 249, 245)" };

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

function setup(appearance?: "system" | "light" | "dark"): Fixture {
  fx = makeFixture({ withCompanion: true });
  writeSession(fx, {
    cwd: makePlainDir(fx, "queue"),
    sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
    title: "One session",
  });
  if (appearance) {
    writeFileSync(
      path.join(fx.root, "settings.json"),
      JSON.stringify({ editor: "vscode", appearance }),
    );
  }
  return fx;
}

const canvas = (app: LaunchedApp) =>
  app.page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("the appearance setting pins the window to light or dark", async () => {
  app = await launchApp(setup("light"));
  expect(await canvas(app)).toBe(CANVAS.light);
  // what the page paints and what electron paints behind it have to agree, or a resize flashes
  expect(await app.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(false);
  await app.close();

  app = await launchApp(setup("dark"));
  expect(await canvas(app)).toBe(CANVAS.dark);
  expect(await app.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(true);
});

test("by default it follows the system, and switches with it", async () => {
  app = await launchApp(setup());
  const { page } = app;
  expect(await app.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
  // nothing pinned, so the page is left to the media query
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();

  // macOS switching at sunset reaches the page as exactly this
  for (const [scheme, expected] of [
    ["light", CANVAS.light],
    ["dark", CANVAS.dark],
    ["light", CANVAS.light],
  ] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect.poll(() => canvas(app)).toBe(expected);
  }
});

test("changing the setting takes effect without a restart, and is remembered", async () => {
  app = await launchApp(setup());
  const { page } = app;
  await page.getByTestId("open-settings").click();
  await page.getByTestId("setting-appearance").selectOption("light");
  await page.getByTestId("save-settings").click();

  await expect.poll(() => canvas(app)).toBe(CANVAS.light);
  await app.close();

  app = await launchApp(fx);
  expect(await canvas(app)).toBe(CANVAS.light);
});
