// screenshots of the real app for review. not golden diffs: they exist so the design gets looked at.
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  type Fixture,
  makeFixture,
  makePlainDir,
  makeRepo,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, stubDirectoryPicker, waitFor } from "./helpers/launchApp.ts";

const OUT = path.join(import.meta.dirname, "screenshots");
const H = 3_600_000;
const D = 24 * H;

let app: LaunchedApp;
let fx: Fixture;

test.afterEach(async () => {
  await app?.close();
});

async function shot(name: string): Promise<void> {
  await app.page.waitForTimeout(300);
  await app.page.screenshot({ path: path.join(OUT, `${name}.png`) });
  // the same frame in the other appearance, so both get looked at
  await app.page.emulateMedia({ colorScheme: "light" });
  await app.page.waitForTimeout(120);
  await app.page.screenshot({ path: path.join(OUT, "light", `${name}.png`) });
  await app.page.emulateMedia({ colorScheme: "dark" });
  await app.page.waitForTimeout(120);
}

function populate(fx: Fixture): void {
  const queue = makePlainDir(fx, "queue");
  const docs = makePlainDir(fx, "docs");
  const platform = makePlainDir(fx, "platform");
  const rows: Array<[string, string, string, number, string?]> = [
    [
      "Database CPU spike during the nightly job",
      "the primary is pinned at 95% cpu since 02:00, can you check which queries changed",
      platform,
      20_000,
    ],
    [
      "Webhook retries missing - trace the delivery chain",
      "walk the webhook delivery chain and find where the retry is lost",
      queue,
      42 * 60_000,
      "prod-debug",
    ],
    [
      "Rate limiter logic with backoff",
      "review the backoff handling in rate_limiter.py",
      queue,
      6 * H,
      "ENG-390",
    ],
    [
      "Timestamp handling in the importer",
      "what do we expect updated_at to look like for imported rows",
      queue,
      26 * H,
      "ENG-398-normalize-import",
    ],
    ["Onboarding copy changes", "soften the copy on the onboarding panel", docs, 2 * D, "main"],
    ["Revert pull request 4127", "revert 4127 and open a PR, keep the migration", platform, 4 * D],
    [
      "Postgres read replica setup",
      "set up the read replica and list the tables we need",
      queue,
      5 * D,
      "main",
    ],
    [
      "ENG-367 production readiness planning",
      "draft the production-readiness chores for the importer",
      platform,
      8 * D,
    ],
    [
      "Nightly job runtime metrics",
      "how long does the nightly job take per run",
      docs,
      9 * D,
      "main",
    ],
    [
      "auth_tokens.py review",
      "review auth_tokens.py before i open the PR",
      queue,
      16 * D,
      "ENG-335",
    ],
  ];
  for (const [i, [title, prompt, cwd, ageMs, branch]] of rows.entries()) {
    writeSession(fx, {
      cwd,
      sessionId: `${String(i).repeat(8)}-0000-4000-8000-00000000000${i}`,
      title,
      prompt,
      ageMs,
      ...(branch ? { branch } : {}),
    });
  }
}

test("the finder", async () => {
  fx = makeFixture({ withCompanion: true, withClaude: true });
  populate(fx);
  app = await launchApp(fx);
  await waitFor(async () => (await app.page.getByTestId("session-row").count()) >= 10);

  await shot("01-first-run");
  await app.page.getByTestId("search").fill("replica");
  await shot("02-search");
  await app.page.getByTestId("search").fill("");
  await app.page.keyboard.press("ArrowDown");
  await app.page.keyboard.press("Meta+k");
  await shot("03-action-menu");
  await app.page.keyboard.press("Escape");
});

test("combos, drift and the dialogs", async () => {
  fx = makeFixture({ withCompanion: true, withClaude: true });
  populate(fx);
  const api = makeRepo(fx, "api", { branches: ["release"] });
  const shared = makeRepo(fx, "shared");
  const logs = makePlainDir(fx, "logs");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [api, shared, logs]);

  await page.getByTestId("new-combo").click();
  await page.getByTestId("combo-name").fill("prod-debug");
  await page.getByTestId("combo-note").fill("incident triage");
  await page.getByTestId("add-folder").click();
  await page.getByTestId("folder-card").nth(0).getByTestId("mode-worktree").click();
  await page.getByTestId("folder-card").nth(1).getByTestId("mode-worktree").click();
  await page.getByTestId("folder-card").nth(1).getByTestId("branch-new").click();
  await shot("04-combo-dialog");
  await page.getByTestId("save-combo").click();
  await expect(page.getByTestId("folder-row")).toHaveCount(3);

  await waitFor(
    async () =>
      (await page.getByTestId("folder-row").filter({ hasText: "Creating" }).count()) === 0,
    30_000,
  );
  await shot("05-combo-ready");

  const root = path.join(fx.root, "prod-debug");
  writeSession(fx, {
    cwd: root,
    sessionId: "dddddddd-0000-4000-8000-00000000000d",
    title: "Trace the missing webhook",
    prompt: "the 02:00 delivery never got retried",
    ageMs: 30_000,
  });
  await waitFor(async () => (await page.getByTestId("row-combo").count()) > 0, 10_000);
  await shot("06-combo-sessions");

  // drift, as it really arrives: someone removed a worktree outside the app
  const { rmSync, mkdirSync, writeFileSync } = await import("node:fs");
  rmSync(path.join(root, "api"), { recursive: true, force: true });
  rmSync(path.join(root, "shared"), { recursive: true, force: true });
  mkdirSync(path.join(root, "shared"), { recursive: true });
  writeFileSync(path.join(root, "shared", "important.txt"), "not a worktree\n");
  await page.keyboard.press("Meta+r");
  await page
    .getByTestId("folder-row")
    .nth(1)
    .getByText("Something else is here")
    .waitFor({ timeout: 30_000 });
  await shot("07-drift");

  await page.getByTestId("folder-row").nth(0).getByTestId("folder-action").click();
  await waitFor(
    async () =>
      (await page.getByTestId("folder-row").filter({ hasText: "Creating" }).count()) === 0,
    30_000,
  );
  writeFileSync(path.join(root, "api", "work-in-progress.txt"), "half an hour of work\n");

  await page.getByTestId("combo-more").click();
  await page.getByRole("menuitem", { name: "Tear down worktrees" }).click();
  await page.getByTestId("teardown-run").click();
  await page.locator('[data-action="skipped-dirty"]').first().waitFor({ timeout: 30_000 });
  await shot("08-teardown");
  await page.getByTestId("force-remove").click();
  await shot("09-force-confirm");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.getByTestId("open-settings").click();
  await shot("10-settings");
});

test("the states people meet first", async () => {
  fx = makeFixture({ withCompanion: false });
  app = await launchApp(fx);
  await shot("11-no-sessions");

  await app.close();
  fx = makeFixture({ withCompanion: false });
  populate(fx);
  app = await launchApp(fx);
  await waitFor(async () => (await app.page.getByTestId("session-row").count()) >= 10);
  await shot("12-banner");
  await app.page.getByTestId("search").fill("nothing matches this");
  await shot("13-no-matches");
});
