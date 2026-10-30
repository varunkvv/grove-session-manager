import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { makeFixture } from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp } from "./helpers/launchApp.ts";

let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

test("tracking sessions outside projects puts the status hooks in Claude Code's settings, and turning it off takes them out", async () => {
  const fx = makeFixture({ withCompanion: true });
  // the fixture's config dir, never ~/.claude. somebody's own settings come through both writes
  const file = path.join(fx.claudeDir, "settings.json");
  const own = { model: "opus", permissions: { allow: ["Bash(ls)"] } };
  writeFileSync(file, JSON.stringify(own));
  const read = () => JSON.parse(readFileSync(file, "utf8"));

  app = await launchApp(fx);
  const { page } = app;
  const track = page.getByTestId("setting-track-all");
  const flip = async (from: boolean) => {
    await page.keyboard.press("Meta+,");
    await expect(track).toHaveAttribute("aria-checked", String(from));
    await track.click();
    await page.getByTestId("save-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
  };

  await flip(false);
  await expect.poll(() => JSON.stringify(read().hooks ?? {})).toContain("grove-status");
  expect({ ...read(), hooks: undefined }).toEqual({ ...own, hooks: undefined });

  await flip(true);
  await expect.poll(read).toEqual(own);
});

test("Text size sits beside Appearance and Theme, and the hint under the three stays two lines", async () => {
  app = await launchApp(makeFixture({ withCompanion: true }));
  const { app: electron, page } = app;
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 800),
  );
  await page.keyboard.press("Meta+,");
  const select = page.getByTestId("setting-text-size");
  await expect(select).toHaveValue("100");
  expect(await select.locator("option").allTextContents()).toEqual([
    "90%",
    "100% (default)",
    "110%",
    "120%",
    "135%",
    "150%",
  ]);
  // one row with the other two
  const top = async (id: string) => (await page.getByTestId(id).boundingBox())?.y;
  expect(await top("setting-text-size")).toBe(await top("setting-appearance"));
  // their one hint stays two lines at the default size, so the dialog is no taller than it was
  const hint = page
    .getByTestId("setting-text-size")
    .locator("xpath=ancestor::div[contains(@class,'grid')]/following-sibling::span");
  expect((await hint.boundingBox())?.height).toBeLessThanOrEqual(36);
});
