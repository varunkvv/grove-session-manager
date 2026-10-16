import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stripJsonc } from "@grove/core";
import { expect, test } from "@playwright/test";
import {
  makeFixture,
  makePlainDir,
  pendingIntents,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

// a real zed settings.json: header comments, another agent, trailing commas
const ZED_SETTINGS = readFileSync(
  path.join(import.meta.dirname, "../test/fixtures/zed-settings.json"),
  "utf8",
);
const SID = "aaaaaaaa-0000-4000-8000-00000000000a";

let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

test("with zed as the editor, grove's agent goes into zed's settings and a session opens one window, root first", async () => {
  const fx = makeFixture();
  writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ editor: "zed" }));
  // GROVE_EXTENSIONS_DIR is the sandbox's: the real ~/.config/zed is never read or written
  const zedSettings = path.join(fx.extensionsDir, "settings.json");
  writeFileSync(zedSettings, ZED_SETTINGS);
  const docs = makePlainDir(fx, "docs");
  const { id, root } = writeProject(fx, {
    name: "zed-trial",
    folders: [{ path: docs, mode: "reference" }],
  });
  writeSession(fx, { cwd: root, sessionId: SID, title: "landing in zed" });

  app = await launchApp(fx);
  const { page } = app;

  // no agent registered yet: the banner offers it, in zed's words
  const banner = page.getByTestId("banner");
  await expect(banner).toHaveAttribute("data-reason", "companion-missing");
  await expect(banner).toContainText("Landing on a session needs the Grove agent in Zed.");
  await page.getByTestId("banner-action").click();
  // it says how landing works in zed. it is gone in 5s, so it is checked first
  await expect(
    page.getByTestId("toast").filter({ hasText: "Grove agent added to Zed" }),
  ).toBeVisible();
  await waitFor(async () => readFileSync(zedSettings, "utf8").includes('"grove-claude"'));
  const text = readFileSync(zedSettings, "utf8");
  expect(text.startsWith("// Zed settings")).toBe(true);
  expect(text).toContain('"claude-acp"');
  const entry = JSON.parse(stripJsonc(text)).agent_servers["grove-claude"];
  expect(entry).toMatchObject({ type: "custom", command: "node" });
  expect(entry.args[0]).toMatch(/grove-acp\.cjs$/);
  expect(existsSync(entry.args[0])).toBe(true);
  expect(entry.env.GROVE_ROOT).toBe(fx.root);
  await expect(banner).toHaveCount(0);

  // the session's window: zed's cli, one new window, the root first so the agent's cwd is it
  await page.locator(`[data-testid="project-item"][data-id="${id}"]`).click();
  await page.locator(`[data-testid="session-row"][data-id="${SID}"]`).dblclick();
  await waitFor(async () => readExecLog(fx).length > 0);
  const [launch] = readExecLog(fx);
  expect(launch?.argv).toEqual(["-n", root, docs]);
  expect(launch?.argv.some((a) => a.endsWith(".code-workspace"))).toBe(false);
  // still written: switching back to vs code keeps working
  expect(existsSync(path.join(root, `${path.basename(root)}.code-workspace`))).toBe(true);
  // what the proxy in zed takes on the first new thread there
  const intents = pendingIntents(fx);
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({ kind: "resume", sessionId: SID, cwd: root });
});
