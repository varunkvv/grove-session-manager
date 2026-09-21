import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  type Fixture,
  makeFixture,
  makePlainDir,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { api, type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";

const SID = {
  a: "aaaaaaaa-0000-4000-8000-000000000001",
  b: "bbbbbbbb-0000-4000-8000-000000000002",
  c: "cccccccc-0000-4000-8000-000000000003",
  fresh: "ffffffff-0000-4000-8000-000000000009",
};

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

test("first run with no combos, and the finder over real transcripts", async () => {
  fx = makeFixture({ withCompanion: true, withClaude: true });
  const queue = makePlainDir(fx, "queue");
  const docs = makePlainDir(fx, "docs");
  writeSession(fx, {
    cwd: queue,
    sessionId: SID.a,
    title: "Rate limiter logic with backoff",
    prompt: "review the backoff handling in rate_limiter.py",
    branch: "ENG-390",
    ageMs: 20_000,
  });
  writeSession(fx, {
    cwd: docs,
    sessionId: SID.b,
    title: "Onboarding copy changes",
    prompt: "soften the copy on the onboarding panel",
    ageMs: 2 * 24 * 3_600_000,
  });
  writeSession(fx, {
    cwd: queue,
    sessionId: SID.c,
    prompt: "<command-name>/mcp</command-name>",
    ageMs: 5 * 24 * 3_600_000,
  });

  app = await launchApp(fx);
  const { page } = app;

  // the empty state explains the model in one sentence and offers exactly one button
  await expect(page.getByTestId("rail-empty")).toContainText("No combos yet");
  await expect(page.getByTestId("empty-new-combo")).toBeVisible();
  // with no combos the scope toggle would be meaningless
  await expect(page.getByTestId("scope-all")).toHaveCount(0);

  await waitFor(async () => (await page.getByTestId("session-row").count()) === 3);
  const rows = page.getByTestId("session-row");
  await expect(rows.first()).toContainText("Rate limiter logic with backoff");
  await expect(rows.first()).toContainText("now");
  await expect(rows.first()).toContainText("ENG-390");
  await expect(rows.nth(1)).toContainText("2d ago");
  // a session that is only a slash command still appears, titled by the command
  await expect(rows.nth(2)).toContainText("/mcp");
  // search is focused on open
  await expect(page.getByTestId("search")).toBeFocused();

  // searching reaches the prompt, not just the title, and says why a row matched
  await page.getByTestId("search").fill("backoff handling");
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("result-count")).toHaveText("1 session");
  await expect(rows.first().locator("mark").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(3);

  // arrows move the active row while the cursor stays in the search field
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("search")).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute("data-active", "true");
});

test("acting on a session that belongs to no combo", async () => {
  fx = makeFixture({ withCompanion: true });
  const queue = makePlainDir(fx, "queue");
  writeSession(fx, { cwd: queue, sessionId: SID.a, title: "Rate limiter", ageMs: 60_000 });
  const gone = path.join(fx.dir, "src", "deleted-repo");
  writeSession(fx, {
    cwd: gone,
    sessionId: SID.b,
    title: "From a folder that is gone",
    ageMs: 120_000,
  });

  app = await launchApp(fx);
  const { page } = app;
  await waitFor(async () => (await page.getByTestId("session-row").count()) === 2);

  // Enter on a non-combo session offers the ways in rather than guessing
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("session-menu")).toBeVisible();
  await expect(page.getByTestId("action-folder-land")).toBeEnabled();
  await page.getByTestId("action-folder-land").click();

  await waitFor(async () => readExecLog(fx).length > 0);
  const [launch] = readExecLog(fx);
  expect(launch?.bin).toBe("code");
  expect(launch?.argv).toEqual([queue]);

  // the intent is what lets the companion land on the session once the window is up
  const pending = path.join(fx.root, ".grove", "pending");
  const intents = readdirSync(pending);
  expect(intents).toHaveLength(1);
  const intent = JSON.parse(readFileSync(path.join(pending, intents[0] as string), "utf8"));
  expect(intent).toMatchObject({ version: 1, sessionId: SID.a, cwd: queue });

  // a session whose folder no longer exists cannot be opened there, but the command still works
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("action-folder-land")).toBeDisabled();
  await page.getByTestId("action-copy-command").click();
  // the folder is gone, so there is no `cd`. the claude path is absolute where one was found:
  // Terminal runs a .command file without the person's shell setup.
  const clipboard = await app.app.evaluate(({ clipboard: c }) => c.readText());
  expect(clipboard).toMatch(new RegExp(`^(claude|'?/.*/claude'?) --resume ${SID.b}$`));
});

test("a new session appears on its own, and a deleted one leaves quietly", async () => {
  fx = makeFixture({ withCompanion: true });
  const queue = makePlainDir(fx, "queue");
  writeSession(fx, { cwd: queue, sessionId: SID.a, title: "Already here", ageMs: 60_000 });

  app = await launchApp(fx);
  const { page } = app;
  await waitFor(async () => (await page.getByTestId("session-row").count()) === 1);

  const file = writeSession(fx, {
    cwd: queue,
    sessionId: SID.fresh,
    title: "Started just now",
    ageMs: 0,
  });
  await waitFor(async () => (await page.getByTestId("session-row").count()) === 2, 8000);
  await expect(page.getByTestId("session-row").first()).toContainText("Started just now");

  // subagent transcripts and tool results churn constantly and are never sessions
  const noise = path.join(path.dirname(file), SID.fresh, "subagents");
  writeSession(
    { ...fx, projectsDir: noise },
    { cwd: queue, sessionId: SID.c, title: "subagent noise" },
  );
  await page.waitForTimeout(2000);
  await expect(page.getByTestId("session-row")).toHaveCount(2);

  rmSync(file);
  await waitFor(async () => (await page.getByTestId("session-row").count()) === 1, 15_000);
});

test("the companion banner offers to install the extension", async () => {
  fx = makeFixture({ withCompanion: false });
  writeSession(fx, { cwd: makePlainDir(fx, "queue"), sessionId: SID.a, title: "One session" });

  app = await launchApp(fx);
  const { page } = app;
  const banner = page.getByTestId("banner");
  await expect(banner).toContainText("Grove extension");
  await page.getByTestId("banner-action").click();

  await waitFor(async () => readExecLog(fx).some((l) => l.argv.includes("--install-extension")));
  const install = readExecLog(fx).find((l) => l.argv.includes("--install-extension"));
  expect(install?.bin).toBe("code");
  expect(install?.argv.at(-1)).toBe("--force");
  expect(install?.argv[1]).toMatch(/\.vsix$/);
});

test("nothing the app launches relies on a shell PATH, and the page raises no CSP violations", async () => {
  fx = makeFixture({ withCompanion: true });
  const queue = makePlainDir(fx, "queue");
  writeSession(fx, { cwd: queue, sessionId: SID.a, title: "One session" });

  const violations: string[] = [];
  app = await launchApp(fx);
  app.page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) violations.push(m.text());
  });
  const { page } = app;
  await waitFor(async () => (await page.getByTestId("session-row").count()) === 1);

  await page.keyboard.press("Enter");
  await page.getByTestId("action-terminal").click();
  await waitFor(async () => readExecLog(fx).some((l) => l.bin === "open"));

  for (const line of readExecLog(fx)) {
    for (const arg of line.argv) {
      if (arg.startsWith("-")) continue;
      expect(path.isAbsolute(arg), `${line.bin} got a relative path: ${arg}`).toBe(true);
    }
  }
  const script = readExecLog(fx).find((l) => l.bin === "open")?.argv[0] as string;
  expect(existsSync(script)).toBe(true);
  const body = readFileSync(script, "utf8");
  expect(body).toContain(`--resume ${SID.a}`);
  expect(body).toContain(`cd '${queue}'`);

  expect(
    await api(page)
      .bootstrap()
      .then((b) => b.env.appRoot),
  ).toBe(fx.root);
  expect(violations).toEqual([]);
});
