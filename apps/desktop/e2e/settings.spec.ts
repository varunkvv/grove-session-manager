import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { weightsFileName } from "@grove/core";
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

test("decisioning: the switch downloads its model with progress, and Delete takes it off the disk at once", async () => {
  // a stand-in for the model's server, slow enough to watch: a test root never reaches the real one
  const body = Buffer.alloc(2_000_000, 7);
  const sha = createHash("sha256").update(body).digest("hex");
  const server = createServer(async (req, res) => {
    const from = Number(/bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0);
    res.writeHead(
      from ? 206 : 200,
      from ? { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` } : {},
    );
    for (let at = from; at < body.length; at += 100_000) {
      res.write(body.subarray(at, at + 100_000));
      // ~4s in all: long enough to be caught downloading after Save and a reopened dialog
      await new Promise((r) => setTimeout(r, 200));
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.gguf`;
  try {
    const fx = makeFixture({ withCompanion: true });
    app = await launchApp(fx, {
      GROVE_MODEL_URL: url,
      GROVE_MODEL_SHA256: sha,
      GROVE_MODEL_SIZE: String(body.length),
    });
    const { page } = app;
    const row = page.getByTestId("decisioning-model");
    await page.keyboard.press("Meta+,");
    const sw = page.getByTestId("setting-judgment-day-odds");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    // off, with nothing on disk: no row
    await expect(row).toHaveCount(0);
    await sw.click();
    await expect(row).toContainText("downloads when you save");
    await page.getByTestId("save-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();

    // it downloads by itself, and the row says how far it got while the dialog is open
    await expect(async () => {
      await page.keyboard.press("Meta+,");
      await expect(page.getByTestId("settings-dialog")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(row).toHaveAttribute("data-state", "downloading", { timeout: 10_000 });
    await expect(page.getByTestId("decisioning-progress")).toBeVisible();
    await expect(row).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    await expect(page.getByTestId("decisioning-size")).toHaveText("2 MB on this Mac");
    // named by its hash, not the file name upstream
    const weights = path.join(fx.root, ".grove", "models", weightsFileName(sha));
    expect(readFileSync(weights).equals(body)).toBe(true);

    // Delete acts now, not on Save
    await page.getByTestId("decisioning-delete").click();
    await expect(row).toHaveAttribute("data-state", "missing");
    expect(existsSync(weights)).toBe(false);
    await expect(page.getByTestId("decisioning-download")).toBeVisible();
    await page.getByTestId("save-settings").click();
    expect(
      JSON.parse(readFileSync(path.join(fx.root, "settings.json"), "utf8")).judgmentDayOdds,
    ).toBe(true);
  } finally {
    server.close();
  }
});
