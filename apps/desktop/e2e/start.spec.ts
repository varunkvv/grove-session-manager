import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { api, type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { asAgent, writeProject } from "./helpers/project.ts";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

const GOAL = "Invoice exports as csv, one file per customer";
// written out, not imported from main: this is what the agent is told, to the byte
const PROMPT = `Call record_state first, then work toward this project's goal: ${GOAL}

Claim a card nobody holds with card_claim, or create one with card_create for work that has no card yet. Record what you decide or find with conclusion_record as you go.`;

/** an empty project on its Cards screen, with a fake claude and the fake `code` */
async function start(o: FixtureOptions & { goal?: string } = {}): Promise<{
  root: string;
  fake: FakeClaude;
  page: Page;
}> {
  fx = makeFixture({ withCompanion: true, ...o });
  const { root } = writeProject(fx, {
    name: "billing-export",
    prefix: "BILL",
    goal: "goal" in o ? o.goal : GOAL,
  });
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), []);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  await app.page.getByTestId("nav-cards").click();
  await expect(app.page.getByTestId("start-state")).toBeVisible();
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

test("Start an agent in VS Code leaves the goal prompt for the panel, then waits for a claim", async () => {
  const { root, fake, page } = await start();
  const state = page.getByTestId("start-state");
  await expect(state).toHaveAttribute("data-case", "ready");

  await page.getByTestId("start-editor").click();
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

  // the pair gives way to the waiting row and one quiet background start
  await expect(state).toHaveAttribute("data-case", "waiting");
  await expect(state).toContainText("Cards appear here as it creates them.");
  const rows = page.getByTestId("start-row");
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute("data-where", "editor");
  await expect(rows).toContainText("Waiting for it to claim a card");
  await expect(rows.getByTestId("runtime-chip")).toHaveText("VS Code");
  await expect(page.getByTestId("start-editor")).toHaveCount(0);
  await expect(page.getByTestId("start-background")).toHaveText("Start another in the background");

  // the background one runs claude itself, in the project root, with the same prompt
  await page.getByTestId("start-background").click();
  await expect(
    page.getByTestId("toast").filter({ hasText: `started in background · ${FAKE_SHORT_ID}` }),
  ).toBeVisible();
  expect(started(fake)).toMatchObject([{ argv: ["--bg", "--", PROMPT], cwd: root }]);
  await expect(rows).toHaveCount(2);
  await expect(rows.last()).toHaveAttribute("data-where", "background");
  await expect(rows.last().getByTestId("runtime-chip")).toHaveText("Background");
  await expect(state).toContainText("Cards appear here as they create them.");
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
  // refused, so nothing is waiting yet
  await expect(page.getByTestId("start-row")).toHaveCount(0);
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
  await expect(page.getByTestId("start-row")).toHaveAttribute("data-where", "background");
});

test("the waiting row leaves when the agent creates and claims a card", async () => {
  const { root, page } = await start();
  await page.getByTestId("start-background").click();
  await expect(page.getByTestId("start-row")).toHaveCount(1);
  expect((await api(page).bootstrap()).projects[0]?.starting).toMatchObject([
    { where: "background" },
  ]);

  const agent = asAgent(fx, root, {
    sessionId: "eeeeeeee-0000-4000-8000-00000000000e",
    name: "export job",
  });
  agent("card_create", { title: "Export job skeleton" });
  agent("card_claim", { card: "BILL-1" });

  const row = page.locator('[data-testid="card-row"][data-id="BILL-1"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute("data-status", "in_progress");
  await expect(page.getByTestId("start-state")).toHaveCount(0);
  // main dropped the start, not only the screen
  await expect.poll(async () => (await api(page).bootstrap()).projects[0]?.starting).toEqual([]);
});

test("no goal: Edit project in place of the start buttons", async () => {
  const { page } = await start({ goal: undefined });
  const state = page.getByTestId("start-state");
  await expect(state).toHaveAttribute("data-case", "goal");
  await expect(state).toContainText("Add a goal so agents know what to work toward.");
  await expect(page.getByTestId("goal")).toHaveCount(0);
  await expect(page.getByTestId("start-editor")).toHaveCount(0);
  await expect(page.getByTestId("start-background")).toHaveCount(0);
  await expect(page.getByTestId("start-edit")).toHaveText("Edit project");
  await page.getByTestId("start-edit").click();
  await expect(page.locator('[data-testid="screen"][data-view="edit-project"]')).toBeAttached();
});

test("a start that is known to fail is not offered: the folder is gone, or the record is unreachable", async () => {
  fx = makeFixture({ withCompanion: true });
  const gone = writeProject(fx, { name: "moved-away", prefix: "MOVE", goal: GOAL });
  rmSync(gone.root, { recursive: true });
  const broken = writeProject(fx, { name: "broken-config", prefix: "BRKN", goal: GOAL });
  // not JSON: the record server's self-check fails at its config stage
  writeFileSync(path.join(broken.root, ".mcp.json"), "{ half written");
  app = await launchApp(fx);
  const { page } = app;
  await page.getByTestId("nav-cards").click();

  const state = page.getByTestId("start-state");
  await expect(state).toHaveAttribute("data-case", "root");
  await expect(state).toContainText(`The project folder is missing: ${gone.root}`);
  await expect(state.getByRole("button")).toHaveCount(0);

  await page.getByTestId("project-switcher").click();
  await page.locator(`[data-testid="project-item"][data-id="${broken.id}"]`).click();
  await expect(state).toHaveAttribute("data-case", "server", { timeout: 20_000 });
  await expect(state).toContainText(
    "Agents cannot reach this project's record, so a new one could not work. Edit project says why.",
  );
  await expect(state.getByRole("button")).toHaveCount(0);
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
  // the person still has to paste and send it, so it waits like any other start
  await expect(page.getByTestId("start-row")).toHaveAttribute("data-where", "editor");
});
