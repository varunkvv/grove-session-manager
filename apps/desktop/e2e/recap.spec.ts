import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  type FakeClaude,
  fakeClaudeCalls,
  recapSays,
  setFakeRecaps,
  writeFakeClaude,
} from "./helpers/fakeClaude.ts";
import { type Fixture, hookEvent, makeFixture, writeSession } from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp } from "./helpers/launchApp.ts";
import { liveSession, writeProject } from "./helpers/project.ts";

const SID = {
  /** its turn ends while grove is open */
  turn: "aaaaaaaa-0000-4000-8000-000000000001",
  /** waits on a permission prompt */
  permission: "bbbbbbbb-0000-4000-8000-000000000002",
  /** needs nothing */
  quiet: "cccccccc-0000-4000-8000-000000000003",
};

const QUESTION = "Create a dev tenant, or point staging at the prod tenant with its own app?";
const REPLY = `Staging has no okta tenant.\n\n${QUESTION}`;
// a model wrote it from an agent's output: markup in it is its text, never an element or a link
const NEEDS = 'Pick the tenant <b id="evil">now</b>, see [the doc](https://evil.example/x)';
const TURN = recapSays(
  "Point staging at okta",
  "Found that staging has no tenant of its own.",
  "Waiting on which tenant to use.",
  NEEDS,
);

let fx: Fixture;
let fake: FakeClaude;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/** one project, a session about to finish its turn, one on a permission prompt and a quiet one */
function seed(): void {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, { name: "auth-sso", goal: "SSO for the dashboard" });
  writeSession(fx, {
    cwd: root,
    sessionId: SID.turn,
    title: "idp config",
    prompt: "point staging at okta",
    reply: REPLY,
  });
  liveSession(fx, { sessionId: SID.turn, kind: "interactive", entrypoint: "claude-vscode" });
  writeSession(fx, {
    cwd: root,
    sessionId: SID.permission,
    title: "login page",
    prompt: "build the login page",
    reply: "Running the suite.",
  });
  liveSession(fx, { sessionId: SID.permission, kind: "interactive", entrypoint: "claude-vscode" });
  writeSession(fx, {
    cwd: root,
    sessionId: SID.quiet,
    title: "okta research",
    prompt: "how does okta price SCIM",
    reply: "Per seat, on the workforce plans only.",
    ageMs: 3 * 3_600_000,
  });
  hookEvent(fx, SID.permission, "PermissionRequest", {
    tool_name: "Bash",
    tool_input: { command: "pnpm test --filter login" },
  });
  fake = writeFakeClaude(path.join(fx.dir, "bin"));
}

const row = (page: Page, id: string) => page.locator(`[data-testid="inbox-row"][data-id="${id}"]`);
const panel = (page: Page) => page.getByTestId("session-panel");
const recapCalls = () => fakeClaudeCalls(fake).filter((c) => c.argv[0] === "-p");
const lines = (page: Page) =>
  Promise.all(
    ["goal", "done", "state", "needs"].map((k) =>
      panel(page).getByTestId(`recap-${k}`).innerText(),
    ),
  );

test("a session that starts needing him gets a recap: its row says what it needs, its panel the four lines", async () => {
  seed();
  setFakeRecaps(fake, [{ when: "title: idp config", say: TURN }]);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  await expect(row(page, SID.permission)).toBeVisible({ timeout: 15_000 });
  // a permission row keeps the tool and what it would act on, and nothing was asked for it
  await expect(row(page, SID.permission).getByTestId("inbox-summary")).toHaveText(
    "Bash pnpm test --filter login",
  );
  expect(recapCalls()).toHaveLength(0);

  // its turn ends: the row comes in with the end of its last message, then with what it needs
  hookEvent(fx, SID.turn, "Stop", { last_assistant_message: REPLY });
  const summary = row(page, SID.turn).getByTestId("inbox-summary");
  await expect(summary).toHaveText(NEEDS, { timeout: 15_000 });
  await expect(page.locator("#evil")).toHaveCount(0);

  // the call: the documented flags, a digest on stdin, a temp dir that is nobody's project
  const [call] = recapCalls();
  expect(recapCalls()).toHaveLength(1);
  expect(call?.argv).toEqual([
    "-p",
    "--model",
    "claude-haiku-4-5-20251001",
    "--no-session-persistence",
    "--restricted",
    "--strict-mcp-config",
    "--permission-prompts",
    "none",
    "--tools",
    "",
  ]);
  expect(call?.cwd.startsWith(fx.dir)).toBe(false);
  expect(call?.cwd.startsWith(os.tmpdir()) || call?.cwd.startsWith("/private")).toBe(true);
  expect(call?.input).toContain("  - point staging at okta");
  expect(call?.input).toContain(QUESTION);
  expect(call?.input).toContain("right now: its turn is over");

  // the panel has it at once: it came with the row
  await row(page, SID.turn).click();
  await expect(panel(page).getByTestId("recap")).toBeVisible();
  expect(await lines(page)).toEqual([
    "Point staging at okta",
    "Found that staging has no tenant of its own.",
    "Waiting on which tenant to use.",
    NEEDS,
  ]);
  await expect(panel(page).getByTestId("recap").locator("a, b")).toHaveCount(0);
  await expect(panel(page).getByTestId("recap-when")).toContainText("Written");
  // under it, what CHAT-2 built: the last prompt and the last message in full
  await expect(panel(page).getByTestId("panel-prompt")).toHaveText("point staging at okta");
  await expect(panel(page).getByTestId("panel-text")).toContainText(QUESTION);
  // opening the panel asked for nothing: the conversation has not moved
  expect(recapCalls()).toHaveLength(1);
  const kept = JSON.parse(readFileSync(path.join(fx.root, ".grove", "recaps.v1.json"), "utf8"));
  expect(Object.keys(kept)).toHaveLength(1);

  // Write again asks once more, whatever is kept
  setFakeRecaps(fake, [
    { when: "title: idp config", say: TURN.replace(NEEDS, "Say which tenant.") },
  ]);
  await panel(page).getByTestId("recap-again").click();
  await expect(panel(page).getByTestId("recap-needs")).toHaveText("Say which tenant.");
  await expect(summary).toHaveText("Say which tenant.");
  expect(recapCalls()).toHaveLength(2);
});

test("a recap is written when a panel opens on a session without one, and the panel says so meanwhile", async () => {
  seed();
  setFakeRecaps(fake, [
    {
      when: "title: login page",
      say: recapSays(
        "Build the login page",
        "Wrote the page.",
        "Waiting to run the suite.",
        "Allow the test run.",
      ),
      afterMs: 1500,
    },
    { when: "title: okta research", say: "I could not tell what this session is about." },
  ]);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  await row(page, SID.permission).click({ timeout: 15_000 });
  // what CHAT-2 built is there while it is written
  await expect(panel(page).getByTestId("recap-writing")).toHaveText("Writing a recap…");
  await expect(panel(page).getByTestId("panel-text")).toHaveText("Running the suite.");
  await expect(panel(page).getByTestId("recap-needs")).toHaveText("Allow the test run.");
  await expect(panel(page).getByTestId("recap-writing")).toHaveCount(0);
  // the digest said what grove knows: which tool it waits on
  expect(recapCalls()[0]?.input).toContain(
    "right now: it is waiting for the person to allow a tool call: Bash pnpm test --filter login",
  );
  // its row still says the tool: that is exact, and he has to answer it now
  await expect(row(page, SID.permission).getByTestId("inbox-summary")).toHaveText(
    "Bash pnpm test --filter login",
  );

  // an answer that is not the four lines is no recap, and is never shown
  await page.locator('[data-testid="project-item"][data-id="auth-sso"]').click();
  await page.locator(`[data-testid="session-row"][data-id="${SID.quiet}"]`).click();
  await expect(panel(page).getByTestId("panel-text")).toHaveText(
    "Per seat, on the workforce plans only.",
  );
  await expect.poll(() => recapCalls().length).toBe(2);
  await expect(panel(page).getByTestId("recap-writing")).toHaveCount(0);
  await expect(panel(page).getByTestId("recap")).toHaveCount(0);
  await expect(panel(page)).not.toContainText("could not tell");
});

test("with recaps switched off nothing is asked, and the panel is the last prompt and the last message", async () => {
  seed();
  setFakeRecaps(fake, [{ when: "title: idp config", say: TURN }]);
  hookEvent(fx, SID.turn, "Stop", { last_assistant_message: REPLY });
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  const summary = row(page, SID.turn).getByTestId("inbox-summary");
  await expect(summary).toHaveText(NEEDS, { timeout: 15_000 });

  await page.keyboard.press("Meta+,");
  const recaps = page.getByTestId("setting-recaps");
  await expect(recaps).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("settings-dialog")).toContainText(
    "It uses your Claude login and the haiku model.",
  );
  await recaps.click();
  await page.getByTestId("save-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeHidden();

  // the row is what it was before recaps: the end of its last message
  await expect(summary).toHaveText(QUESTION);
  await row(page, SID.turn).click();
  await expect(panel(page).getByTestId("panel-prompt")).toHaveText("point staging at okta");
  await expect(panel(page).getByTestId("panel-text")).toContainText(QUESTION);
  await expect(panel(page).getByTestId("recap")).toHaveCount(0);
  await expect(panel(page).getByTestId("recap-writing")).toHaveCount(0);
  await row(page, SID.permission).click();
  await expect(panel(page).getByTestId("panel-text")).toHaveText("Running the suite.");
  expect(recapCalls()).toHaveLength(1);
  expect(JSON.parse(readFileSync(path.join(fx.root, "settings.json"), "utf8")).recaps).toBe(false);

  // a root with no claude named never runs one: the real claude is not a test's to call
  await app.close();
  app = await launchApp(fx);
  await expect(row(app.page, SID.turn).getByTestId("inbox-summary")).toHaveText(QUESTION, {
    timeout: 15_000,
  });
  expect(recapCalls()).toHaveLength(1);
  expect(existsSync(path.join(fx.root, ".grove", "recaps.v1.json"))).toBe(true);
});
