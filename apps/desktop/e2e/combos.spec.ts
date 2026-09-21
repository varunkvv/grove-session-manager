import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  type Fixture,
  git,
  makeFixture,
  makePlainDir,
  makeRepo,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, stubDirectoryPicker, waitFor } from "./helpers/launchApp.ts";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

async function makeCombo(
  page: LaunchedApp["page"],
  name: string,
  folders: Array<{ mode?: "worktree"; branch?: "new" | "existing" }>,
): Promise<void> {
  await page.getByTestId("new-combo").click();
  await page.getByTestId("combo-name").fill(name);
  await page.getByTestId("add-folder").click();
  const cards = page.getByTestId("folder-card");
  await expect(cards).toHaveCount(folders.length);
  for (const [i, f] of folders.entries()) {
    if (f.mode !== "worktree") continue;
    await cards.nth(i).getByTestId("mode-worktree").click();
    if (f.branch === "new") await cards.nth(i).getByTestId("branch-new").click();
    if (f.branch === "existing") await cards.nth(i).getByTestId("branch-existing").click();
  }
  await page.getByTestId("save-combo").click();
  await expect(page.getByTestId("combo-dialog")).toHaveCount(0);
  // the new combo is selected, so its folders are the rows on screen. without this, "nothing
  // says Creating" is also true before the rows have rendered at all.
  await expect(page.getByTestId("folder-row")).toHaveCount(folders.length);
}

test("create a combo with worktrees and a reference, then open it", async () => {
  fx = makeFixture({ withCompanion: true, withClaude: true });
  const api = makeRepo(fx, "api", { branches: ["release"] });
  const shared = makeRepo(fx, "shared");
  const logs = makePlainDir(fx, "logs");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [api, shared, logs]);

  await makeCombo(page, "prod-debug", [
    { mode: "worktree" }, // detached by default
    { mode: "worktree", branch: "new" },
    {}, // not a repo: reference only
  ]);

  // the dialog closes at once and the folders fill in where they are
  const row = page.getByTestId("combo-row").filter({ hasText: "prod-debug" });
  await expect(row).toBeVisible();
  await waitFor(
    async () =>
      (await page.getByTestId("folder-row").filter({ hasText: "Creating" }).count()) === 0,
    30_000,
  );
  const folders = page.getByTestId("folder-row");
  await expect(folders).toHaveCount(3);
  await expect(folders.nth(0)).toHaveAttribute("data-state", "ok");
  await expect(folders.nth(1)).toHaveAttribute("data-state", "ok");
  await expect(folders.nth(2)).toHaveAttribute("data-state", "reference");
  await expect(page.getByTestId("state-dot")).toHaveAttribute("data-state", "ok");

  const root = path.join(fx.root, "prod-debug");
  expect(git(path.join(root, "api"), "branch", "--show-current")).toBe("");
  expect(git(path.join(root, "shared"), "branch", "--show-current")).toBe("prod-debug");
  // the reference is the person's own clone and is never touched
  expect(readdirSync(logs)).toEqual(["notes.txt"]);
  const claudeMd = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  expect(claudeMd).toContain("# prod-debug");
  // every session in the combo loads this, forks included: what a worktree is, and where things go
  expect(claudeMd).toContain("A working copy is a git worktree");
  expect(claudeMd).toContain("`plans/`");
  for (const dir of ["plans", "artifacts", "context"]) {
    expect(existsSync(path.join(root, dir)), dir).toBe(true);
  }
  // long work defaults to the background: a policy file says so, and the agent's frontmatter forces it
  expect(claudeMd).toContain("`.claude/long-work.md`");
  const agent = readFileSync(path.join(root, ".claude", "agents", "long-task.md"), "utf8");
  expect(agent).toContain("background: true");

  await page.getByTestId("open-combo").click();
  await waitFor(async () => readExecLog(fx).length > 0);
  const [launch] = readExecLog(fx);
  expect(launch?.argv).toEqual([path.join(root, "prod-debug.code-workspace")]);

  const ws = JSON.parse(readFileSync(path.join(root, "prod-debug.code-workspace"), "utf8"));
  // the combo root is workspaceFolders[0]: that is what makes it Claude's working directory
  expect(path.resolve(root, ws.folders[0].path)).toBe(root);
  expect(ws.folders.map((f: { path: string }) => path.resolve(root, f.path))).toEqual([root, logs]);
  const settings = JSON.parse(
    readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"),
  );
  expect(settings.permissions.additionalDirectories).toEqual([logs]);
  // every session in the combo reports whether it needs someone, into the app's events dir
  expect(JSON.stringify(settings.hooks.PermissionRequest)).toContain(
    path.join(fx.root, ".grove", "events"),
  );
});

test("a second combo that wants the same branch is told, and the rest of it still builds", async () => {
  fx = makeFixture({ withCompanion: true });
  const api = makeRepo(fx, "api");
  const shared = makeRepo(fx, "shared");

  app = await launchApp(fx);
  const { page } = app;

  await stubDirectoryPicker(app.app, [api]);
  await makeCombo(page, "first", [{ mode: "worktree", branch: "new" }]);
  await waitFor(
    async () =>
      (await page.getByTestId("folder-row").filter({ hasText: "Creating" }).count()) === 0,
    30_000,
  );

  // "first" on api is taken. shared is free, and has to be built anyway.
  await stubDirectoryPicker(app.app, [api, shared]);
  await page.getByTestId("new-combo").click();
  await page.getByTestId("combo-name").fill("second");
  await page.getByTestId("add-folder").click();
  for (const i of [0, 1]) {
    const card = page.getByTestId("folder-card").nth(i);
    await card.getByTestId("mode-worktree").click();
    await card.getByTestId("branch-new").click();
    await card.getByTestId("new-branch-name").fill("first");
  }
  await page.getByTestId("save-combo").click();

  const toast = page
    .getByTestId("toast")
    .filter({ hasText: 'branch "first" is already checked out' });
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText("The rest of the combo was created");

  await page.getByTestId("combo-row").filter({ hasText: "second" }).click();
  await waitFor(
    async () =>
      (await page.getByTestId("folder-row").filter({ hasText: "Creating" }).count()) === 0,
    30_000,
  );
  expect(existsSync(path.join(fx.root, "second", "shared"))).toBe(true);
  expect(git(path.join(fx.root, "second", "shared"), "branch", "--show-current")).toBe("first");
  // the original clone is untouched by any of it
  expect(git(api, "status", "--porcelain")).toBe("");
});

test("drift is a normal state: a deleted worktree, and a folder that is in the way", async () => {
  fx = makeFixture({ withCompanion: true });
  const api = makeRepo(fx, "api");
  const shared = makeRepo(fx, "shared");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [api, shared]);
  await makeCombo(page, "prod-debug", [{ mode: "worktree" }, { mode: "worktree" }]);
  await waitFor(
    async () =>
      (await page.getByTestId("folder-row").filter({ hasText: "Creating" }).count()) === 0,
    30_000,
  );

  // someone removes a worktree behind git's back, and drops a folder where another one belongs
  const root = path.join(fx.root, "prod-debug");
  rmSync(path.join(root, "api"), { recursive: true, force: true });
  rmSync(path.join(root, "shared"), { recursive: true, force: true });
  mkdirSync(path.join(root, "shared"), { recursive: true });
  writeFileSync(path.join(root, "shared", "important.txt"), "not a worktree\n");

  await page.keyboard.press("Meta+r");
  const rows = page.getByTestId("folder-row");
  await expect(rows.nth(0)).toHaveAttribute("data-state", "stale", { timeout: 30_000 });
  await expect(rows.nth(0)).toContainText("Folder was deleted");
  await expect(rows.nth(1)).toHaveAttribute("data-state", "foreign");
  await expect(rows.nth(1)).toContainText("Something else is here");
  await expect(page.getByTestId("state-dot")).toHaveAttribute("data-state", "drift");

  // the stale one repairs; the foreign one is left alone, file and all
  await rows.nth(0).getByTestId("folder-action").click();
  await expect(rows.nth(0)).toHaveAttribute("data-state", "ok", { timeout: 30_000 });
  await expect(rows.nth(1)).toHaveAttribute("data-state", "foreign");
  expect(readFileSync(path.join(root, "shared", "important.txt"), "utf8")).toBe("not a worktree\n");
});

test("teardown keeps uncommitted work unless it is discarded on purpose", async () => {
  fx = makeFixture({ withCompanion: true });
  const api = makeRepo(fx, "api");
  const shared = makeRepo(fx, "shared");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [api, shared]);
  await makeCombo(page, "prod-debug", [{ mode: "worktree" }, { mode: "worktree" }]);
  await waitFor(
    async () =>
      (await page.getByTestId("folder-row").filter({ hasText: "Creating" }).count()) === 0,
    30_000,
  );

  const root = path.join(fx.root, "prod-debug");
  const dirty = path.join(root, "api", "work-in-progress.txt");
  writeFileSync(dirty, "half an hour of work\n");

  await page.getByTestId("combo-more").click();
  await page.getByRole("menuitem", { name: "Tear down worktrees" }).click();
  await page.getByTestId("teardown-run").click();

  // data-action only appears once the run has answered, so these never match the pending labels
  const items = page.getByTestId("teardown-item");
  await expect(items.filter({ has: page.locator('[data-action="skipped-dirty"]') })).toHaveCount(0);
  await expect(page.locator('[data-action="removed"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('[data-action="skipped-dirty"]')).toHaveCount(1);
  expect(readFileSync(dirty, "utf8")).toBe("half an hour of work\n");
  expect(existsSync(path.join(root, "shared"))).toBe(false);

  // force is its own decision, per folder, behind a second confirm
  await page.getByTestId("force-remove").click();
  await expect(page.getByTestId("force-dialog")).toBeVisible();
  await page.getByTestId("force-confirm").click();
  await expect(page.locator('[data-action="removed"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(items).toHaveCount(2);
  expect(existsSync(dirty)).toBe(false);

  // whatever happened to the worktrees, the original clones are exactly as they were
  for (const repo of [api, shared]) {
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "branch", "--show-current")).toBe("main");
  }
});

test("a session started inside a combo is labelled by the combo, not by a path", async () => {
  fx = makeFixture({ withCompanion: true });
  const api = makeRepo(fx, "api");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [api]);
  await makeCombo(page, "prod-debug", [{ mode: "worktree" }]);
  await waitFor(
    async () =>
      (await page.getByTestId("folder-row").filter({ hasText: "Creating" }).count()) === 0,
    30_000,
  );

  // this is what Claude Code writes when someone starts a session in the combo folder
  const root = path.join(fx.root, "prod-debug");
  writeSession(fx, {
    cwd: root,
    sessionId: "dddddddd-0000-4000-8000-000000000004",
    title: "Trace the missing webhook",
    ageMs: 5_000,
  });
  await waitFor(async () => (await page.getByTestId("row-combo").count()) === 1, 10_000);
  await expect(page.getByTestId("row-combo").first()).toHaveText("prod-debug");

  // Enter on a session that lives at the combo root opens the combo and lands on it
  await page.getByTestId("search").click();
  await page.keyboard.press("Enter");
  await waitFor(async () => readExecLog(fx).some((l) => l.argv[0]?.endsWith(".code-workspace")));
  const pending = path.join(fx.root, ".grove", "pending");
  const intent = JSON.parse(
    readFileSync(path.join(pending, readdirSync(pending)[0] as string), "utf8"),
  );
  expect(intent).toMatchObject({ sessionId: "dddddddd-0000-4000-8000-000000000004", cwd: root });
});

test("where long work runs is a switch, and flipping it rewrites what a running session reads", async () => {
  fx = makeFixture({ withCompanion: true });
  const api = makeRepo(fx, "api");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [api]);
  await makeCombo(page, "prod-debug", [{ mode: "worktree" }]);
  await waitFor(
    async () =>
      (await page.getByTestId("folder-row").filter({ hasText: "Creating" }).count()) === 0,
    30_000,
  );

  const root = path.join(fx.root, "prod-debug");
  const policy = () => readFileSync(path.join(root, ".claude", "long-work.md"), "utf8");
  const saved = () =>
    JSON.parse(readFileSync(path.join(fx.root, "combos.json"), "utf8")).combos[0].longWork;

  // on by default, and already on disk before the combo was ever opened
  const toggle = page.getByTestId("long-work-switch");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(policy()).toContain("to the `long-task`");
  // CLAUDE.md only points at the policy. it is read once per session, so it could not carry a switch.
  expect(readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain("`.claude/long-work.md`");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect.poll(policy).toContain("Do not hand it to the `long-task` agent");
  expect(saved()).toBe("foreground");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect.poll(policy).toContain("to the `long-task`");
  expect(saved()).toBe("background");
});

test("folders people keep using are one click away in the combo dialog", async () => {
  fx = makeFixture({ withCompanion: true });
  const api = makeRepo(fx, "api");
  const web = makeRepo(fx, "web");
  mkdirSync(path.join(api, "services", "billing"), { recursive: true });
  // a session started in a subfolder still counts toward its repo
  writeSession(fx, {
    cwd: path.join(api, "services", "billing"),
    sessionId: "aaaaaaaa-0000-4000-8000-00000000000a",
    title: "billing",
    ageMs: 60_000,
  });
  writeSession(fx, {
    cwd: api,
    sessionId: "aaaaaaaa-0000-4000-8000-00000000000b",
    title: "api",
    ageMs: 120_000,
  });
  writeSession(fx, {
    cwd: web,
    sessionId: "aaaaaaaa-0000-4000-8000-00000000000c",
    title: "web",
    ageMs: 3_600_000,
  });

  app = await launchApp(fx);
  const { page } = app;
  await waitFor(async () => (await page.getByTestId("session-row").count()) === 3);
  await page.getByTestId("new-combo").click();
  const chips = page.getByTestId("frequent-folder");
  await expect(chips).toHaveText(["api", "web"]);

  await chips.first().click();
  await expect(page.getByTestId("folder-card")).toHaveCount(1);
  await page.screenshot({ path: path.join(import.meta.dirname, "screenshots", "16-frequent.png") });
  await expect(page.getByTestId("folder-card")).toContainText("api");
  // an added folder leaves the strip
  await expect(chips).toHaveText(["web"]);
});
