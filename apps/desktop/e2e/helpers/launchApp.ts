import os from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import type { Bootstrap } from "../../src/shared/ipc.ts";
import type { Fixture } from "./fixture.ts";

const MAIN = path.join(import.meta.dirname, "../../out/main/index.cjs");

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  close(): Promise<void>;
}

export async function launchApp(
  fx: Fixture,
  extraEnv: Record<string, string> = {},
): Promise<LaunchedApp> {
  // a terminal inside VS Code exports ELECTRON_RUN_AS_NODE=1, which would make the app boot as
  // plain node and never open a window
  const app = await _electron.launch({
    args: [MAIN],
    env: {
      HOME: os.homedir(),
      TMPDIR: os.tmpdir(),
      // what an app launched from Finder really gets. anything that relies on a shell PATH
      // (git, the editor, claude) has to resolve an absolute path of its own.
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GROVE_ROOT: fx.root,
      CLAUDE_CONFIG_DIR: fx.claudeDir,
      GROVE_EDITOR_BIN: fx.fakeCode,
      GROVE_OPEN_BIN: fx.fakeOpen,
      GROVE_EXTENSIONS_DIR: fx.extensionsDir,
      GROVE_FAKE_LOG: fx.execLog,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...extraEnv,
    },
  });
  app.process().stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) process.stderr.write(`[main] ${text}\n`);
  });
  const page = await app.firstWindow();
  if (process.env.GROVE_E2E_DEBUG) {
    page.on("console", (m) => process.stderr.write(`[page ${m.type()}] ${m.text()}\n`));
    page.on("pageerror", (e) => process.stderr.write(`[page error] ${e.message}\n`));
  }
  await page.getByTestId("app-ready").waitFor({ timeout: 30_000 });
  return {
    app,
    page,
    close: async () => {
      await app.close().catch(() => {});
    },
  };
}

/** talks to main over the same bridge the UI uses */
export function api(page: Page) {
  return {
    bootstrap: () => page.evaluate(() => window.grove.bootstrap()) as Promise<Bootstrap>,
    call: <T>(fn: (grove: Window["grove"]) => Promise<T>) =>
      page.evaluate(fn as never, undefined as never) as Promise<T>,
  };
}

/** the native directory picker cannot be driven, so the test says what it returns */
export async function stubDirectoryPicker(
  app: ElectronApplication,
  paths: string[],
): Promise<void> {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, paths);
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
  everyMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the app to catch up");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
