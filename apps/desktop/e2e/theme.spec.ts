import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { type Fixture, makeFixture, makePlainDir, writeSession } from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp } from "./helpers/launchApp.ts";

const CANVAS = { dark: "rgb(23, 24, 27)", light: "rgb(255, 255, 255)" };
/** rosé pine's base: dawn and main */
const ROSE_PINE = { dark: "rgb(25, 23, 36)", light: "rgb(250, 244, 237)" };

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

function setup(appearance?: "system" | "light" | "dark", palette?: "rose-pine"): Fixture {
  fx = makeFixture({ withCompanion: true });
  writeSession(fx, {
    cwd: makePlainDir(fx, "queue"),
    sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
    title: "One session",
  });
  if (appearance) {
    writeFileSync(
      path.join(fx.root, "settings.json"),
      JSON.stringify({ editor: "vscode", appearance, palette }),
    );
  }
  return fx;
}

/** the screen beside the sidebar. the main window's body is see-through, for the sidebar's glass */
const canvas = (app: LaunchedApp) =>
  app.page.getByTestId("screen").evaluate((e) => getComputedStyle(e).backgroundColor);

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

test("a palette has its own light and dark", async () => {
  app = await launchApp(setup("light", "rose-pine"));
  expect(await canvas(app)).toBe(ROSE_PINE.light);
  expect(await app.page.evaluate(() => document.documentElement.dataset.palette)).toBe("rose-pine");
  expect(await app.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(false);
  await app.close();

  app = await launchApp(setup("dark", "rose-pine"));
  expect(await canvas(app)).toBe(ROSE_PINE.dark);
  expect(await app.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(true);
});

test("the main window's sidebar and top bar are glass over a see-through body", async () => {
  app = await launchApp(setup("dark"));
  const bg = (id: string) =>
    app.page.getByTestId(id).evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await app.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  // the palette's chrome, partly see-through. solid with reduce transparency on, as on a CI runner
  const reduced = await app.page.evaluate(
    () => matchMedia("(prefers-reduced-transparency: reduce)").matches,
  );
  for (const id of ["sidebar", "top-bar"]) {
    expect(await bg(id)).toMatch(reduced ? /^rgb\(27, 28, 32\)$/ : / \/ 0\.8\)$|, 0\.8\)$/);
  }
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
  // the palette's Settings row comes with the palette. the key is the page's own
  await page.keyboard.press("Meta+,");
  await page.getByTestId("setting-appearance").selectOption("light");
  await page.getByTestId("save-settings").click();

  await expect.poll(() => canvas(app)).toBe(CANVAS.light);
  await app.close();

  app = await launchApp(fx);
  expect(await canvas(app)).toBe(CANVAS.light);

  // a theme too, though macOS's appearance did not move
  await app.page.keyboard.press("Meta+,");
  await app.page.getByTestId("setting-palette").selectOption("rose-pine");
  await app.page.getByTestId("save-settings").click();
  await expect.poll(() => canvas(app)).toBe(ROSE_PINE.light);
});
