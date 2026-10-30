// the built .app, not the out/ bundles. opt-in: `pnpm app:package` first.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { _electron, expect, type Page, test } from "@playwright/test";
import { writeFakeClaude } from "./helpers/fakeClaude.ts";
import { makeFixture, writeSession } from "./helpers/fixture.ts";
import { waitFor } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

const APP = path.join(import.meta.dirname, "../dist/mac-arm64/Grove.app");
const EXECUTABLE = path.join(APP, "Contents/MacOS/Grove");

test.skip(!existsSync(EXECUTABLE), "run `pnpm app:package` first");

test("the packaged app opens on its projects and carries the companion extension and the zed agent", async () => {
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
    // zed runs the proxy by its path, so it sits outside the asar too
    expect(existsSync(path.join(APP, "Contents/Resources/acp-proxy/grove-acp.cjs"))).toBe(true);
    const status = await page.evaluate(() => window.grove.editorStatus(true));
    expect(status.bundledCompanionVersion).not.toBeNull();
    expect(status.companionState).toBe("ok");
  } finally {
    await app.close().catch(() => {});
  }
});

test("the packaged app runs grove chat's claude: the sdk is bundled, and spawns the one it is given", async () => {
  const fx = makeFixture({ withCompanion: true });
  writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ chat: true }));
  const { root } = writeProject(fx, { name: "toy" });
  const sid = "dddddddd-0000-4000-8000-000000000001";
  // the highlighter's worker and mermaid are lazy chunks: they have to load out of the asar too
  writeSession(fx, {
    cwd: root,
    sessionId: sid,
    title: "packaged chat",
    reply: "```ts\nconst packaged = true;\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```",
  });
  const fake = writeFakeClaude(fx.dir);

  const app = await _electron.launch({
    executablePath: EXECUTABLE,
    env: {
      HOME: fx.dir,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GROVE_ROOT: fx.root,
      CLAUDE_CONFIG_DIR: fx.claudeDir,
      GROVE_EDITOR_BIN: fx.fakeCode,
      GROVE_OPEN_BIN: fx.fakeOpen,
      GROVE_EXTENSIONS_DIR: fx.extensionsDir,
      GROVE_FAKE_LOG: fx.execLog,
      GROVE_CLAUDE_BIN: fake.bin,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId("app-ready").waitFor({ timeout: 45_000 });
    let key: string | undefined;
    await waitFor(async () => {
      const hits = await page.evaluate(() => window.grove.listSessions(null));
      key = hits.find((h) => h.sessionId === "dddddddd-0000-4000-8000-000000000001")?.key;
      return !!key;
    });
    expect(await page.evaluate((k) => window.grove.openChat(k), key as string)).toEqual({
      ok: true,
    });
    let chat: Page | undefined;
    await waitFor(async () => {
      for (const p of app.windows()) {
        if (p.url().includes("#/chat") && (await p.locator(`[data-id="${sid}"]`).count())) {
          chat = p;
          return true;
        }
      }
      return false;
    }, 20_000);
    const c = chat as Page;
    await expect
      .poll(() => c.locator('code[data-lang="ts"] span[style]').count())
      .toBeGreaterThan(0);
    await expect(c.getByTestId("diagram")).toHaveCount(1, { timeout: 20_000 });
    const composer = c.getByTestId("composer");
    await composer.fill("Reply with exactly: hello from the spike");
    await composer.press("Enter");
    await expect((chat as Page).getByTestId("panel-text")).toContainText("hello from the spike", {
      timeout: 20_000,
    });
  } finally {
    await app.close().catch(() => {});
  }
});
