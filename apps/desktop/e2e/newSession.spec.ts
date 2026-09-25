import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { longWorkPromptLine, longWorkSessionPolicy } from "@grove/core";
import { expect, type Page, test } from "@playwright/test";
import {
  FAKE_SHORT_ID,
  type FakeClaude,
  fakeClaudeCalls,
  setUntrusted,
  writeFakeClaude,
} from "./helpers/fakeClaude.ts";
import {
  type Fixture,
  type FixtureOptions,
  makeFixture,
  makePlainDir,
  readExecLog,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";

const OUT = path.join(import.meta.dirname, "screenshots");

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/** the frame in both appearances, so both get looked at */
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, "light", `${name}.png`) });
  await page.emulateMedia({ colorScheme: "dark" });
}

/** one combo with its root on disk, and the app up with a fake claude */
async function start(o: FixtureOptions = { withCompanion: true }): Promise<{
  root: string;
  fake: FakeClaude;
  page: Page;
}> {
  fx = makeFixture(o);
  const root = path.join(fx.root, "ops");
  mkdirSync(root, { recursive: true });
  const logs = makePlainDir(fx, "logs");
  writeFileSync(
    path.join(fx.root, "combos.json"),
    JSON.stringify({
      combos: [{ name: "ops", root, folders: [{ path: logs, mode: "reference" }] }],
    }),
  );
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), []);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  return { root, fake, page: app.page };
}

/** the .command Terminal was handed last */
function lastScript(): string {
  const open = readExecLog(fx)
    .filter((l) => l.bin === "open")
    .pop();
  return readFileSync(open?.argv[0] as string, "utf8");
}

/** what the app left for the editor's window, and nothing else */
function pendingIntents(): Array<Record<string, unknown>> {
  const dir = path.join(fx.root, ".grove", "pending");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((n) => JSON.parse(readFileSync(path.join(dir, n), "utf8")));
}

/** single quotes around every argument, the way the .command writes them */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

test("cmd-T opens the editor on a new conversation, the long-work override on its prompt", async () => {
  const { root, fake, page } = await start();

  await page.getByTestId("combo-row").filter({ hasText: "ops" }).click();
  await page.keyboard.press("Meta+t");
  const dialog = page.getByTestId("new-session-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-label", "New session in ops");
  await expect(dialog.getByTestId("ns-prompt")).toBeFocused();
  // the editor is where it starts, and nothing of the CLI's is offered for it
  await expect(dialog.getByTestId("ns-run")).toHaveText("Open in VS Code");
  await expect(dialog.getByTestId("ns-panel-note")).toBeVisible();
  for (const id of ["ns-model", "ns-mode", "ns-effort", "ns-name"]) {
    await expect(dialog.getByTestId(id), id).toHaveCount(0);
  }
  await expect(dialog.getByTestId("ns-long-work")).toHaveValue("combo");
  await expect(dialog.getByTestId("ns-long-work").locator("option").first()).toHaveText(
    "Combo default (in the background)",
  );
  await dialog.getByTestId("ns-long-work").selectOption("foreground");
  await dialog.getByTestId("ns-prompt").fill("look at why the retry test is flaky");
  await shot(page, "30-new-session-editor");

  // a second cmd-T inside the dialog keeps what was typed
  await page.keyboard.press("Meta+t");
  await expect(dialog.getByTestId("ns-prompt")).toHaveValue("look at why the retry test is flaky");

  await page.keyboard.press("Meta+Enter");
  await expect(
    page.getByTestId("toast").filter({ hasText: "Opening ops in VS Code on a new conversation" }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "code"));
  expect(readExecLog(fx).find((l) => l.bin === "code")?.argv[0]).toMatch(/ops\.code-workspace$/);
  const [intent, ...more] = pendingIntents();
  expect(more).toEqual([]);
  expect(intent).toMatchObject({
    kind: "new",
    cwd: root,
    source: "app",
    prompt: `${longWorkPromptLine("foreground")}\n\nlook at why the retry test is flaky`,
  });
  expect(intent).not.toHaveProperty("sessionId");
  // the editor starts the conversation itself: grove ran no claude for it
  expect(fakeClaudeCalls(fake).filter((c) => c.argv[0] !== "agents")).toEqual([]);

  // the second time, the choices are the last ones
  await page.keyboard.press("Meta+t");
  await expect(dialog.getByTestId("ns-long-work")).toHaveValue("foreground");
  await expect(dialog.getByTestId("ns-where-editor")).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("ns-prompt")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // no combo selected: nowhere to start it
  await page
    .getByTestId("combo-row")
    .filter({ hasText: "ops" })
    .locator("[data-rail-item]")
    .click();
  await expect(page.getByTestId("combo-row").filter({ hasText: "ops" })).not.toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.keyboard.press("Meta+t");
  await expect(page.getByTestId("toast").filter({ hasText: "Pick a combo first" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test("Terminal runs claude in the combo root with the flags picked, the prompt as its first message", async () => {
  const { root, fake, page } = await start();
  await page.getByTestId("combo-row").filter({ hasText: "ops" }).click();
  await page.getByTestId("combo-more").click();
  await expect(page.getByRole("menuitem").first()).toHaveText(/^New session…/);
  await expect(page.getByRole("menuitem", { name: /^New session…/ })).toContainText("⌘T");
  await shot(page, "33-combo-menu");
  await page.getByRole("menuitem", { name: /^New session…/ }).click();
  const dialog = page.getByTestId("new-session-dialog");
  await dialog.getByTestId("ns-where-terminal").click();
  await expect(dialog.getByTestId("ns-run")).toHaveText("Open in Terminal");
  await expect(dialog.getByTestId("ns-panel-note")).toHaveCount(0);
  await dialog.getByTestId("ns-model").selectOption("haiku");
  await dialog.getByTestId("ns-mode").selectOption("plan");
  await dialog.getByTestId("ns-effort").selectOption("low");
  await dialog.getByTestId("ns-long-work").selectOption("foreground");
  await dialog.getByTestId("ns-name").fill("-flaky retry");
  const typed = `pick up the "retry" test - it's flaky; $(nope)`;
  await dialog.getByTestId("ns-prompt").fill(typed);
  await shot(page, "31-new-session-terminal");
  await dialog.getByTestId("ns-run").click();
  await expect(
    page.getByTestId("toast").filter({ hasText: "Opened a new session in Terminal, in ops" }),
  ).toBeVisible();

  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "open"));
  const script = lastScript();
  expect(script).toContain(`cd '${root}' || exit 1\n`);
  const args = [
    "--model",
    "haiku",
    "--permission-mode",
    "plan",
    "--effort",
    "low",
    `--append-system-prompt=${longWorkSessionPolicy("foreground")}`,
    "--name=-flaky retry",
    "--",
    typed,
  ];
  expect(script).toMatch(/\nexec '.*fake-claude' /);
  expect(script.endsWith(` ${args.map(q).join(" ")}\n`)).toBe(true);
  // Terminal runs it, grove does not
  expect(fakeClaudeCalls(fake).filter((c) => c.argv[0] !== "agents")).toEqual([]);

  // no prompt: an interactive claude with its flags and nothing after them
  await page.keyboard.press("Meta+t");
  await expect(dialog.getByTestId("ns-where-terminal")).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("ns-model")).toHaveValue("haiku");
  await dialog.getByTestId("ns-long-work").selectOption("combo");
  await dialog.getByTestId("ns-model").selectOption("");
  await dialog.getByTestId("ns-mode").selectOption("");
  await dialog.getByTestId("ns-effort").selectOption("");
  const before = readExecLog(fx).filter((l) => l.bin === "open").length;
  await dialog.getByTestId("ns-run").click();
  await waitFor(async () => readExecLog(fx).filter((l) => l.bin === "open").length > before);
  expect(lastScript()).toMatch(/\nexec '.*fake-claude'\n$/);
});

test("background sends the flags before `--`, and an untrusted folder goes through Terminal once", async () => {
  const { root, fake, page } = await start();
  await page.getByTestId("combo-row").filter({ hasText: "ops" }).click();
  await page.keyboard.press("Meta+t");
  const dialog = page.getByTestId("new-session-dialog");
  await dialog.getByTestId("ns-where-background").click();
  await expect(dialog.getByTestId("ns-run")).toHaveText("Start in background");
  // nothing typed, nothing to start
  await expect(dialog.getByTestId("ns-run")).toBeDisabled();
  await dialog.getByTestId("ns-model").selectOption("sonnet");
  await dialog.getByTestId("ns-effort").selectOption("high");
  await dialog.getByTestId("ns-long-work").selectOption("background");
  await dialog.getByTestId("ns-name").fill("nightly tidy");
  await dialog.getByTestId("ns-prompt").fill("tidy the logs folder");
  await shot(page, "32-new-session-background");

  setUntrusted(fake, true);
  await dialog.getByTestId("ns-run").click();
  await expect(dialog.getByTestId("ns-error")).toHaveAttribute("data-code", "not-trusted");
  await dialog.getByTestId("ns-terminal").click();
  await expect(dialog).toHaveCount(0);
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "open"));
  const args = [
    "--bg",
    "--model",
    "sonnet",
    "--effort",
    "high",
    `--append-system-prompt=${longWorkSessionPolicy("background")}`,
    "--name=nightly tidy",
    "--",
    "tidy the logs folder",
  ];
  expect(lastScript()).toContain(`cd '${root}' || exit 1\n`);
  expect(lastScript().endsWith(` ${args.map(q).join(" ")}\n`)).toBe(true);

  // trusted now: straight to the supervisor, from the combo root, with every choice remembered
  setUntrusted(fake, false);
  await page.keyboard.press("Meta+t");
  await expect(dialog.getByTestId("ns-where-background")).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("ns-model")).toHaveValue("sonnet");
  await expect(dialog.getByTestId("ns-long-work")).toHaveValue("background");
  await dialog.getByTestId("ns-name").fill("nightly tidy");
  await dialog.getByTestId("ns-prompt").fill("tidy the logs folder");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByTestId("toast").filter({ hasText: "started in background" })).toHaveText(
    new RegExp(`started in background · ${FAKE_SHORT_ID}`),
  );
  const sent = fakeClaudeCalls(fake).filter((c) => c.argv.includes("--bg"));
  expect(sent.map((c) => c.argv)).toEqual([args, args]);
  expect(sent[1]?.cwd).toBe(root);
});

test("an older companion cannot start a conversation: the combo opens, the prompt waits on the clipboard", async () => {
  const { page } = await start({ withCompanion: true, companionVersion: "0.2.0" });
  await page.getByTestId("combo-row").filter({ hasText: "ops" }).click();
  await page.keyboard.press("Meta+t");
  const dialog = page.getByTestId("new-session-dialog");
  await dialog.getByTestId("ns-long-work").selectOption("foreground");
  await dialog.getByTestId("ns-prompt").fill("look at the logs");
  await dialog.getByTestId("ns-run").click();
  const toast = page.getByTestId("toast").filter({ hasText: "Prompt copied" });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("older than 0.3.0");
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "code"));
  expect(readExecLog(fx).find((l) => l.bin === "code")?.argv[0]).toMatch(/ops\.code-workspace$/);
  // never an intent it would ignore, and never a link that lands in whatever window has focus
  expect(pendingIntents()).toEqual([]);
  expect(await app.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    `${longWorkPromptLine("foreground")}\n\nlook at the logs`,
  );
});
