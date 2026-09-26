import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FANOUT, writeFanOut } from "./helpers/agents.ts";
import { writeFakeClaude } from "./helpers/fakeClaude.ts";
import {
  type Fixture,
  hookEvent,
  makeFixture,
  makePlainDir,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";

const OUT = path.join(import.meta.dirname, "screenshots");
const SID = {
  perm: "aaaaaaaa-0000-4000-8000-0000000000a1",
  turn: "bbbbbbbb-0000-4000-8000-0000000000b2",
  held: "cccccccc-0000-4000-8000-0000000000c3",
  quiet: "dddddddd-0000-4000-8000-0000000000d4",
};

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

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

const QUESTION =
  "The old button is still on the last page behind the flag. Want me to remove it now, or keep it for one release and open a follow-up card to take it out after the next deploy?";

test("the inbox is what is waiting on you, what it waits for, and both ways out", async () => {
  fx = makeFixture({ withCompanion: true });
  const api = makePlainDir(fx, "api");
  const root = path.join(fx.root, "ops");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(fx.root, "combos.json"),
    JSON.stringify({ combos: [{ name: "ops", root, folders: [] }] }),
  );
  writeSession(fx, {
    cwd: api,
    sessionId: SID.perm,
    title: "Run the webhook tests",
    ageMs: 90_000,
  });
  writeSession(fx, {
    cwd: api,
    sessionId: SID.turn,
    title: "Move the export button",
    ageMs: 60_000,
  });
  writeSession(fx, { cwd: root, sessionId: SID.held, title: "Nightly tidy", ageMs: 30_000 });
  writeSession(fx, { cwd: api, sessionId: SID.quiet, title: "Nothing asked", ageMs: 20_000 });
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), [
    {
      pid: 99999,
      id: "d7b6bcc2",
      sessionId: SID.held,
      cwd: root,
      kind: "background",
      status: "waiting",
      state: "blocked",
      waitingFor: "permission prompt",
    },
  ]);
  // what the hooks said while the app was closed: one asks to run a command, one ended its turn
  // on a question, after a long answer the question is at the end of
  hookEvent(fx, SID.perm, "PermissionRequest", {
    tool_name: "Bash",
    tool_input: { command: `cd ${api} && pnpm test --filter webhooks` },
    cwd: api,
  });
  await new Promise((r) => setTimeout(r, 30));
  hookEvent(fx, SID.turn, "UserPromptSubmit", { prompt: "move it" });
  hookEvent(fx, SID.turn, "Stop", {
    last_assistant_message: `Moved the export button to the first page.\n\n- the report flow reads it from one place\n- the tests cover both pages\n\n${QUESTION}`,
  });
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  await waitFor(async () => (await page.getByTestId("session-row").count()) === 4);

  // the count is on the scope switch, in the accent, and cmd-4 goes there
  const scope = page.getByTestId("scope-inbox");
  await expect(scope.getByTestId("scope-count")).toHaveText("3");
  await page.keyboard.press("Meta+4");
  await expect(scope).toHaveAttribute("aria-checked", "true");
  const rows = page.getByTestId("inbox-row");
  await expect(rows).toHaveCount(3);
  const perm = rows.filter({ hasText: "Run the webhook tests" });
  const turn = rows.filter({ hasText: "Move the export button" });
  const held = rows.filter({ hasText: "Nightly tidy" });
  // what each one waits on: the command it wants to run, the question it ended on
  await expect(perm.getByTestId("inbox-ask")).toHaveText("Bashpnpm test --filter webhooks");
  await expect(turn.getByTestId("inbox-ask")).toHaveText(QUESTION);
  await expect(held.getByTestId("inbox-ask")).toHaveText(
    "Blocked in the background · permission prompt",
  );
  // and where to go to answer it: the editor, or Terminal for one the supervisor holds
  await expect(perm.getByTestId("inbox-open")).toHaveText("Open in VS Code");
  await expect(held.getByTestId("inbox-open")).toHaveText("Open in Terminal");
  await expect(perm.getByTestId("inbox-waited")).toHaveText(/^\d+s$/);
  await shot(page, "29-inbox");

  // seen: it leaves the inbox, as it leaves the pinned group
  await perm.click();
  await page.keyboard.press("Meta+d");
  await expect(rows).toHaveCount(2);
  await expect(scope.getByTestId("scope-count")).toHaveText("2");

  // a click reads it in the pane, at the end where the question is, and opens nothing
  await turn.click();
  const pane = page.getByTestId("inspector");
  await expect(pane.getByTestId("inspector-title")).toHaveText("Move the export button");
  await page.waitForTimeout(600);
  expect(readExecLog(fx)).toEqual([]);
  await expect(rows).toHaveCount(2);
  // the button goes to answer it - and going to it is looking at it
  await turn.getByTestId("inbox-open").click();
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "code"));
  await expect(rows).toHaveCount(1);
  // one the supervisor holds is answered where it runs: Terminal, attached
  await held.getByTestId("inbox-open").click();
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "open"));
  expect(readExecLog(fx).filter((l) => l.bin === "code")).toHaveLength(1);
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId("list-empty")).toHaveText("Nothing is waiting for you.");
  await expect(scope.getByTestId("scope-count")).toHaveCount(0);
  await shot(page, "29-inbox-empty");
});

/** what a notification click runs in main. a test root has no notifications to click. */
async function reveal(sessionId: string): Promise<void> {
  await app.app.evaluate(
    (_electron, sid) =>
      (globalThis as unknown as { groveTest: { reveal(s: string): unknown } }).groveTest.reveal(
        sid,
      ),
    sessionId,
  );
}

test("a notification click lands in grove, on that session, where the question is", async () => {
  fx = makeFixture({ withCompanion: true });
  const cwd = makePlainDir(fx, "platform");
  writeFanOut(fx, cwd);
  writeSession(fx, {
    cwd,
    sessionId: SID.turn,
    title: "Move the export button",
    prompt: "move the export button to the first page",
    reply: QUESTION,
    ageMs: 120_000,
  });
  writeSession(fx, { cwd, sessionId: SID.quiet, title: "Nothing asked", ageMs: 20_000 });
  hookEvent(fx, SID.turn, "UserPromptSubmit", { prompt: "move it" });
  hookEvent(fx, SID.turn, "Stop", { last_assistant_message: QUESTION });
  app = await launchApp(fx);
  const { page } = app;
  await waitFor(async () => (await page.getByTestId("session-row").count()) === 3);

  // somewhere else entirely: another scope, a query typed, the window minimised
  await page.keyboard.press("Meta+3");
  await page.getByTestId("search").fill("replica");
  await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
  await reveal(SID.turn);
  expect(
    await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
  ).toBe(false);
  await expect(page.getByTestId("scope-inbox")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("search")).toHaveValue("");
  const row = page.getByTestId("inbox-row").filter({ hasText: "Move the export button" });
  await expect(row).toHaveAttribute("data-active", "true");
  const pane = page.getByTestId("inspector");
  await expect(pane).toHaveAttribute("data-view", "conversation");
  await expect(pane.getByTestId("inspector-title")).toHaveText("Move the export button");
  // at the end: the answer the turn stopped on is in sight
  await expect(pane.getByTestId("answer").last()).toBeInViewport();
  // looking is not answering
  await expect(row).toHaveCount(1);
  await shot(page, "30-notification-landing");

  // a subagent asking for permission lands on that agent
  hookEvent(fx, FANOUT.session, "UserPromptSubmit", { prompt: "go" });
  hookEvent(fx, FANOUT.session, "PermissionRequest", {
    tool_name: "Bash",
    tool_input: { command: "psql replica -f replay.sql" },
    agent_id: FANOUT.replay,
  });
  const asking = page.getByTestId("inbox-row").filter({ hasText: "Database CPU spike" });
  await expect(asking.getByTestId("inbox-ask")).toContainText("psql replica -f replay.sql");
  await reveal(FANOUT.session);
  await expect(pane.getByTestId("agent-title")).toHaveText("Reproduce the spike against a replica");
  await expect(asking).toHaveAttribute("data-active", "true");

  // no longer waiting by the time of the click: every session instead
  await reveal(SID.quiet);
  await expect(page.getByTestId("scope-all")).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByTestId("session-row").filter({ hasText: "Nothing asked" }),
  ).toHaveAttribute("data-active", "true");
  await expect(pane.getByTestId("inspector-title")).toHaveText("Nothing asked");
});
