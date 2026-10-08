// the built .app, not the out/ bundles. opt-in: `pnpm app:package` first.
import { existsSync } from "node:fs";
import path from "node:path";
import { _electron, expect, test } from "@playwright/test";
import { makeFixture } from "./helpers/fixture.ts";
import { writeProject } from "./helpers/project.ts";

const APP = path.join(import.meta.dirname, "../dist/mac-arm64/Grove.app");
const EXECUTABLE = path.join(APP, "Contents/MacOS/Grove");

test.skip(!existsSync(EXECUTABLE), "run `pnpm app:package` first");

test("the packaged app opens on its projects and carries the companion extension", async () => {
  const fx = makeFixture({ withCompanion: true });
  const { id } = writeProject(fx, { name: "toy", goal: "Ship the toy" });

  const app = await _electron.launch({
    executablePath: EXECUTABLE,
    env: {
      // the fixture's, so nothing a home-relative path names is the real one
      HOME: fx.dir,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GROVE_ROOT: fx.root,
      CLAUDE_CONFIG_DIR: fx.claudeDir,
      GROVE_EDITOR_BIN: fx.fakeCode,
      GROVE_OPEN_BIN: fx.fakeOpen,
      GROVE_EXTENSIONS_DIR: fx.extensionsDir,
      GROVE_FAKE_LOG: fx.execLog,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId("app-ready").waitFor({ timeout: 45_000 });
    await expect(page.locator(`[data-testid="project-item"][data-id="${id}"]`)).toHaveText("toy");
    await expect(page.getByTestId("inbox-empty")).toBeVisible();
    // it installs no runtime of its own next to the projects
    expect(existsSync(path.join(fx.root, ".grove", "bin"))).toBe(false);

    // extraResources sits outside the asar, and the app has to be able to find it from inside
    expect(existsSync(path.join(APP, "Contents/Resources/extension/grove-companion.vsix"))).toBe(
      true,
    );
    const status = await page.evaluate(() => window.grove.editorStatus(true));
    expect(status.bundledCompanionVersion).not.toBeNull();
    expect(status.companionState).toBe("ok");
  } finally {
    await app.close().catch(() => {});
  }
});
