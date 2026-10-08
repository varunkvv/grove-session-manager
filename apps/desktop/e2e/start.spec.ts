import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
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
  pendingIntents,
  readExecLog,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

// what the person types in the dialog. it reaches claude as typed, with nothing added
const ASK = "export invoices as csv, one file per customer";

/** a project nobody has worked in yet, on its screen, with a fake claude and the fake `code` */
async function start(o: FixtureOptions & { goal?: string } = {}): Promise<{
  root: string;
  fake: FakeClaude;
  page: Page;
}> {
  fx = makeFixture({ withCompanion: true, ...o });
  // no goal: a session starts from what is asked of it, not from its project
  const { root } = writeProject(fx, { name: "billing-export", goal: o.goal });
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), []);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  await app.page.locator('[data-testid="project-item"][data-id="billing-export"]').click();
  await expect(app.page.getByTestId("sessions-empty")).toBeVisible();
  return { root, fake, page: app.page };
}

/** New session in the top bar, with this typed into its dialog */
async function ask(page: Page, text: string) {
  await page.getByTestId("new-session").click();
  const dialog = page.getByTestId("start-dialog");
  await expect(dialog).toHaveAttribute("aria-label", "New session in billing-export");
  await expect(dialog.getByTestId("start-prompt")).toBeFocused();
  await dialog.getByTestId("start-prompt").fill(text);
  return dialog;
}

/** the .command Terminal was handed last */
function lastScript(): string {
  const open = readExecLog(fx)
    .filter((l) => l.bin === "open")
    .pop();
  return readFileSync(open?.argv[0] as string, "utf8");
}

/** single quotes around every argument, the way the .command writes them */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** the calls that start something: the app also asks the supervisor what it runs */
const started = (fake: FakeClaude) =>
  fakeClaudeCalls(fake).filter((c) => c.argv[0] !== "agents" && c.argv[0] !== "-p");

test("New session asks what it should do: Enter leaves it in the panel, the background runs claude with it", async () => {
  const { root, fake, page } = await start();
  const empty = page.getByTestId("sessions-empty");
  await expect(empty).toHaveAttribute("data-case", "ready");
  await expect(empty).toContainText("No sessions yet.");
  await expect(empty.getByTestId("empty-new-session")).toHaveText("New session");

  await empty.getByTestId("empty-new-session").click();
  const dialog = page.getByTestId("start-dialog");
  await expect(dialog.getByTestId("start-editor")).toHaveText("Start in VS Code");
  // nothing typed: the background has nothing to start from, the editor a plain conversation
  await expect(dialog.getByTestId("start-background")).toBeDisabled();
  await dialog.getByTestId("start-prompt").fill(ASK);
  await expect(dialog.getByTestId("start-background")).toBeEnabled();
  await dialog.getByTestId("start-prompt").press("Enter");
  await expect(dialog).toBeHidden();
  const toast = page
    .getByTestId("toast")
    .filter({ hasText: "Opening billing-export in VS Code on a new conversation" });
  await expect(toast).toContainText(
    "The prompt is in the Claude panel. Send it to start the agent.",
  );
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "code"));
  expect(readExecLog(fx).find((l) => l.bin === "code")?.argv[0]).toMatch(
    /billing-export\.code-workspace$/,
  );
  const [intent, ...more] = pendingIntents(fx);
  expect(more).toEqual([]);
  expect(intent).toMatchObject({ kind: "new", cwd: root, source: "app", prompt: ASK });
  expect(intent).not.toHaveProperty("sessionId");
  // the editor starts the conversation itself: grove ran no claude for it
  expect(started(fake)).toEqual([]);

  // the same dialog from the top bar. the background start runs claude itself, in the project
  // root, with what was typed and nothing else
  await expect(page.getByTestId("new-session")).toHaveAttribute(
    "title",
    "Start a session in billing-export",
  );
  await (await ask(page, `  ${ASK}\n`)).getByTestId("start-background").click();
  await expect(
    page.getByTestId("toast").filter({ hasText: `started in background · ${FAKE_SHORT_ID}` }),
  ).toBeVisible();
  expect(started(fake)).toMatchObject([{ argv: ["--bg", "--", ASK], cwd: root }]);
});

test("nothing typed: a plain new conversation in the editor, with no prompt", async () => {
  const { root, fake, page } = await start();
  await (await ask(page, "")).getByTestId("start-editor").click();
  const toast = page
    .getByTestId("toast")
    .filter({ hasText: "Opening billing-export in VS Code on a new conversation" });
  await expect(toast).toBeVisible();
  await expect(toast).not.toContainText("The prompt is in the Claude panel");
  await waitFor(async () => pendingIntents(fx).length === 1);
  const [intent] = pendingIntents(fx);
  expect(intent).toMatchObject({ kind: "new", cwd: root, source: "app" });
  expect(intent).not.toHaveProperty("prompt");
  expect(started(fake)).toEqual([]);
});

test("a background start in a folder the CLI has not trusted goes through Terminal once", async () => {
  const { root, fake, page } = await start();
  setUntrusted(fake, true);

  await (await ask(page, ASK)).getByTestId("start-background").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toHaveAttribute("aria-label", "Start it in Terminal?");
  await expect(dialog).toContainText(
    "Claude Code has not been allowed to work in billing-export yet. Grove runs the same command in Terminal, where you answer its trust prompt once.",
  );
  await expect(dialog.getByTestId("confirm-run")).toHaveText("Start in Terminal");
  await dialog.getByTestId("confirm-run").click();

  await expect(
    page.getByTestId("toast").filter({
      hasText: "Opened in Terminal. Accept the trust prompt there, and it goes to the background.",
    }),
  ).toBeVisible();
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "open"));
  const script = lastScript();
  expect(script).toContain(`cd '${root}' || exit 1\n`);
  expect(script).toMatch(/\nexec '.*fake-claude' /);
  expect(script.endsWith(` ${["--bg", "--", ASK].map(q).join(" ")}\n`)).toBe(true);
  // grove asked once and was refused. Terminal runs the second one
  expect(started(fake).map((c) => c.argv)).toEqual([["--bg", "--", ASK]]);
});

test("a start that is known to fail is not offered: the folder is gone", async () => {
  fx = makeFixture({ withCompanion: true });
  const gone = writeProject(fx, { name: "moved-away" });
  rmSync(gone.root, { recursive: true });
  app = await launchApp(fx);
  const { page } = app;
  await page.locator(`[data-testid="project-item"][data-id="${gone.id}"]`).click();

  const empty = page.getByTestId("sessions-empty");
  await expect(empty).toHaveAttribute("data-case", "root");
  await expect(empty).toContainText(`The project folder is missing: ${gone.root}`);
  await expect(empty.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("new-session")).toBeDisabled();
  await expect(page.getByTestId("new-session")).toHaveAttribute(
    "title",
    `The project folder is missing: ${gone.root}`,
  );
  // and the sync did not make the folder again
  await page.keyboard.press("Meta+r");
  await page.waitForTimeout(500);
  expect(existsSync(gone.root)).toBe(false);
});

test("an older companion cannot start a conversation: the project opens, the prompt waits on the clipboard", async () => {
  const { page } = await start({ companionVersion: "0.2.0" });
  // the real clipboard: put back what the person had on it
  const had = await app.app.evaluate(({ clipboard }) => clipboard.readText());
  await (await ask(page, ASK)).getByTestId("start-editor").click();
  const toast = page.getByTestId("toast").filter({ hasText: "Prompt copied" });
  await expect(toast).toContainText("older than 0.3.0");
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "code"));
  expect(readExecLog(fx).find((l) => l.bin === "code")?.argv[0]).toMatch(
    /billing-export\.code-workspace$/,
  );
  // never an intent it would ignore, and never a link that lands in whatever window has focus
  expect(pendingIntents(fx)).toEqual([]);
  const copied = await app.app.evaluate(({ clipboard }) => clipboard.readText());
  await app.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), had);
  expect(copied).toBe(ASK);
});
