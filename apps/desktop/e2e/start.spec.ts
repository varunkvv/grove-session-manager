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

const GOAL = "Invoice exports as csv, one file per customer";
// written out, not imported from main: this is what the agent is told, to the byte
const PROMPT = `Work toward this project's goal: ${GOAL}

Read context/ first: it holds what other sessions here decided and learned. Write what you decide or learn there as you go.`;

/** a project nobody has worked in yet, on its screen, with a fake claude and the fake `code` */
async function start(o: FixtureOptions & { goal?: string } = {}): Promise<{
  root: string;
  fake: FakeClaude;
  page: Page;
}> {
  fx = makeFixture({ withCompanion: true, ...o });
  const { root } = writeProject(fx, {
    name: "billing-export",
    goal: "goal" in o ? o.goal : GOAL,
  });
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), []);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  await app.page.locator('[data-testid="project-item"][data-id="billing-export"]').click();
  await expect(app.page.getByTestId("sessions-empty")).toBeVisible();
  return { root, fake, page: app.page };
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
const started = (fake: FakeClaude) => fakeClaudeCalls(fake).filter((c) => c.argv[0] !== "agents");

test("Start an agent in VS Code leaves the goal prompt for the panel, and one in the background runs claude", async () => {
  const { root, fake, page } = await start();
  const empty = page.getByTestId("sessions-empty");
  await expect(empty).toHaveAttribute("data-case", "ready");
  await expect(empty).toContainText("No sessions yet.");
  await expect(empty.getByTestId("empty-start-editor")).toHaveText("Start an agent in VS Code");
  await expect(empty.getByTestId("empty-start-background")).toHaveText("Start in the background");

  await empty.getByTestId("empty-start-editor").click();
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
  expect(intent).toMatchObject({ kind: "new", cwd: root, source: "app", prompt: PROMPT });
  expect(intent).not.toHaveProperty("sessionId");
  // the editor starts the conversation itself: grove ran no claude for it
  expect(started(fake)).toEqual([]);

  // the same two starts are in the top bar, for a project that has sessions already. the
  // background one runs claude itself, in the project root, with the same prompt
  await expect(page.getByTestId("start-editor")).toHaveAttribute(
    "title",
    "Start an agent in VS Code",
  );
  await page.getByTestId("start-background").click();
  await expect(
    page.getByTestId("toast").filter({ hasText: `started in background · ${FAKE_SHORT_ID}` }),
  ).toBeVisible();
  expect(started(fake)).toMatchObject([{ argv: ["--bg", "--", PROMPT], cwd: root }]);
});

test("a background start in a folder the CLI has not trusted goes through Terminal once", async () => {
  const { root, fake, page } = await start();
  setUntrusted(fake, true);

  await page.getByTestId("start-background").click();
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
  expect(script.endsWith(` ${["--bg", "--", PROMPT].map(q).join(" ")}\n`)).toBe(true);
  // grove asked once and was refused. Terminal runs the second one
  expect(started(fake).map((c) => c.argv)).toEqual([["--bg", "--", PROMPT]]);
});

test("no goal: Edit project in place of the start buttons", async () => {
  const { page } = await start({ goal: undefined });
  const empty = page.getByTestId("sessions-empty");
  await expect(empty).toHaveAttribute("data-case", "goal");
  await expect(empty).toContainText("Add a goal so agents know what to work toward.");
  await expect(empty.getByTestId("empty-start-editor")).toHaveCount(0);
  await expect(empty.getByTestId("empty-start-background")).toHaveCount(0);
  // the top bar's are there for every project, and say why they would not work
  for (const id of ["start-editor", "start-background"]) {
    await expect(page.getByTestId(id)).toBeDisabled();
    await expect(page.getByTestId(id)).toHaveAttribute(
      "title",
      "Add a goal so agents know what to work toward.",
    );
  }
  await expect(empty.getByTestId("empty-edit")).toHaveText("Edit project");
  await empty.getByTestId("empty-edit").click();
  await expect(page.locator('[data-testid="screen"][data-view="edit-project"]')).toBeAttached();
});

test("a start that is known to fail is not offered: the folder is gone", async () => {
  fx = makeFixture({ withCompanion: true });
  const gone = writeProject(fx, { name: "moved-away", goal: GOAL });
  rmSync(gone.root, { recursive: true });
  app = await launchApp(fx);
  const { page } = app;
  await page.locator(`[data-testid="project-item"][data-id="${gone.id}"]`).click();

  const empty = page.getByTestId("sessions-empty");
  await expect(empty).toHaveAttribute("data-case", "root");
  await expect(empty).toContainText(`The project folder is missing: ${gone.root}`);
  await expect(empty.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("start-editor")).toBeDisabled();
  // and the sync did not make the folder again
  await page.keyboard.press("Meta+r");
  await page.waitForTimeout(500);
  expect(existsSync(gone.root)).toBe(false);
});

test("an older companion cannot start a conversation: the project opens, the prompt waits on the clipboard", async () => {
  const { page } = await start({ companionVersion: "0.2.0" });
  // the real clipboard: put back what the person had on it
  const had = await app.app.evaluate(({ clipboard }) => clipboard.readText());
  await page.getByTestId("start-editor").click();
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
  expect(copied).toBe(PROMPT);
});
