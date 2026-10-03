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
