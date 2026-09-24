import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  FAKE_SHORT_ID,
  type FakeClaude,
  fakeClaudeCalls,
  setUntrusted,
  writeFakeClaude,
} from "./helpers/fakeClaude.ts";
import {
  type Fixture,
  makeFixture,
  makePlainDir,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";

const SID = {
  held: "aaaaaaaa-0000-4000-8000-000000000001",
  free: "bbbbbbbb-0000-4000-8000-000000000002",
  panel: "cccccccc-0000-4000-8000-000000000003",
};

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/** a combo written the way a person could write it, with its root on disk */
function writeCombo(name: string): string {
  const root = path.join(fx.root, name);
  mkdirSync(root, { recursive: true });
  const logs = makePlainDir(fx, "logs");
  writeFileSync(
    path.join(fx.root, "combos.json"),
    JSON.stringify({ combos: [{ name, root, folders: [{ path: logs, mode: "reference" }] }] }),
  );
  return root;
}

/** the .command Terminal was handed last */
function lastScript(): string {
  const open = readExecLog(fx)
    .filter((l) => l.bin === "open")
    .pop();
  return readFileSync(open?.argv[0] as string, "utf8");
}

const dispatches = (fake: FakeClaude) =>
  fakeClaudeCalls(fake).filter((c) => c.argv.includes("--bg"));

test("a session Claude Code runs in the background is opened where it runs, never landed on", async () => {
  fx = makeFixture({ withCompanion: true });
  const root = writeCombo("ops");
  writeSession(fx, { cwd: root, sessionId: SID.held, title: "Held by the supervisor" });
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), [
    {
      pid: 99999,
      id: "d7b6bcc2",
      sessionId: SID.held,
      cwd: root,
      kind: "background",
      status: "busy",
      state: "working",
    },
  ]);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;

  const row = page.getByTestId("session-row").filter({ hasText: "Held by the supervisor" });
  const marker = row.getByTestId("row-background");
  await expect(marker).toHaveText("Background");
  await expect(marker).toHaveAttribute("data-held", "true");
  await expect(marker).toHaveAttribute("title", "Background session d7b6bcc2 · working");

  // a combo-root row opens its combo on a click. this one would be refused there: the offers instead
  await row.click();
  await expect(page.getByTestId("session-menu")).toBeVisible();
  await expect(page.getByTestId("action-attach")).toBeEnabled();
  for (const land of ["combo-land", "folder-land", "terminal", "continue-bg"]) {
    await expect(page.getByTestId(`action-${land}`), land).toHaveCount(0);
  }
  await page.getByTestId("action-attach").click();
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "open"));
  expect(lastScript()).toMatch(/\nexec '.*fake-claude' attach 'd7b6bcc2'\n$/);
  expect(readExecLog(fx).some((l) => l.bin === "code")).toBe(false);

  // stopping a session at work asks first, then stops it (never rm) and lands like any other
  await row.click();
  await page.getByTestId("action-stop-land").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-run").click();
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "code"));
  const argv = fakeClaudeCalls(fake).map((c) => c.argv);
  expect(argv).toContainEqual(["stop", "d7b6bcc2"]);
  expect(argv.flat()).not.toContain("rm");
  expect(readExecLog(fx).find((l) => l.bin === "code")?.argv[0]).toMatch(/ops\.code-workspace$/);
  await expect(marker).not.toHaveAttribute("data-held", "true");
  await expect(marker).toHaveAttribute("data-state", "stopped");
});

test("continue in background sends the prompt it was given, from the session's own folder", async () => {
  fx = makeFixture({ withCompanion: true });
  const queue = makePlainDir(fx, "queue");
  writeSession(fx, { cwd: queue, sessionId: SID.free, title: "Closed mid-turn", ageMs: 60_000 });
  // an answer with nothing in the background: interactive sessions only
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), [
    { pid: 1, kind: "interactive", sessionId: SID.panel, status: "idle", cwd: "/elsewhere" },
  ]);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;

  const row = page.getByTestId("session-row").filter({ hasText: "Closed mid-turn" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("row-background")).toHaveCount(0);

  // a folder the CLI never trusted: the dispatch is refused, and Terminal is the way through
  setUntrusted(fake, true);
  await row.click();
  await page.getByTestId("action-continue-bg").click();
  const dialog = page.getByTestId("background-dialog");
  const prompt = dialog.getByTestId("bg-prompt");
  await expect(prompt).toHaveValue("continue where you left off");
  await expect(prompt).toBeFocused();
  // empty is never sent
  await prompt.fill("   ");
  await expect(dialog.getByTestId("bg-run")).toBeDisabled();
  const typed = `pick up the "retry" test - it's flaky; $(nope)`;
  await prompt.fill(typed);
  await dialog.getByTestId("bg-run").click();
  await expect(dialog.getByTestId("bg-error")).toHaveAttribute("data-code", "not-trusted");
  await dialog.getByTestId("bg-terminal").click();
  await expect(dialog).toHaveCount(0);
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "open"));
  const script = lastScript();
  expect(script).toContain(`cd '${queue}' || exit 1\n`);
  expect(script).toContain(
    `'--resume' '${SID.free}' '--bg' '--' 'pick up the "retry" test - it'\\''s flaky; $(nope)'\n`,
  );

  // trusted now: straight to the supervisor, with the prompt as typed and a PATH that has claude's
  setUntrusted(fake, false);
  await row.click();
  await page.getByTestId("action-continue-bg").click();
  await prompt.fill(typed);
  await dialog.getByTestId("bg-run").click();
  await expect(
    page.getByTestId("toast").filter({ hasText: "continuing in background" }),
  ).toHaveText(new RegExp(`continuing in background · ${FAKE_SHORT_ID}`));
  const sent = dispatches(fake);
  expect(sent.map((c) => c.argv)).toEqual([
    ["--resume", SID.free, "--bg", "--", typed],
    ["--resume", SID.free, "--bg", "--", typed],
  ]);
  expect(sent[1]?.cwd).toBe(queue);
  expect(sent[1]?.path.split(":")).toContain(path.join(os.homedir(), ".local", "bin"));

  // the supervisor has it now: the row says so, and offers attach
  await expect(row.getByTestId("row-background")).toHaveAttribute("data-held", "true");
  await row.click();
  await expect(page.getByTestId("action-attach")).toBeEnabled();
  await expect(page.getByTestId("action-continue-bg")).toHaveCount(0);
});

test("a new background session starts in the combo folder, named, with the prompt typed", async () => {
  fx = makeFixture({ withCompanion: true });
  const root = writeCombo("ops");
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), []);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;

  await page.getByTestId("combo-row").filter({ hasText: "ops" }).click();
  await page.getByTestId("combo-more").click();
  await page.getByRole("menuitem", { name: "New background session…" }).click();
  const dialog = page.getByTestId("background-dialog");
  await expect(dialog).toBeVisible();
  // nothing typed, nothing to send
  await expect(dialog.getByTestId("bg-run")).toBeDisabled();
  await dialog.getByTestId("bg-name").fill("nightly tidy");
  await dialog.getByTestId("bg-prompt").fill("tidy the logs folder");
  await dialog.getByTestId("bg-run").click();
  await expect(
    page.getByTestId("toast").filter({ hasText: "started in background" }),
  ).toBeVisible();
  const [call] = dispatches(fake);
  expect(call?.argv).toEqual(["--bg", "--name=nightly tidy", "--", "tidy the logs folder"]);
  expect(call?.cwd).toBe(root);
});
