import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readProject } from "@grove/record";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type Fixture,
  git,
  makeFixture,
  makePlainDir,
  makeRepo,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import {
  api,
  type LaunchedApp,
  launchApp,
  stubDirectoryPicker,
  waitFor,
} from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

const project = async (page: Page, id: string) =>
  (await api(page).bootstrap()).projects.find((p) => p.id === id);
const folderStates = async (page: Page, id: string) =>
  (await project(page, id))?.folders.map((f) => f.state);
const combos = (): Array<{
  name: string;
  root: string;
  prefix?: string;
  note?: string;
  folders: Array<{ path: string; mode: string }>;
}> => JSON.parse(readFileSync(path.join(fx.root, "combos.json"), "utf8")).combos;

/** the New project form with its name and the picker's folders in. on a first run the window is the form already */
async function fillNew(page: Page, name: string, repos: number): Promise<Locator> {
  if ((await page.getByTestId("project-form").count()) === 0) await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("project-form")).toHaveAttribute("data-mode", "new");
  await page.getByTestId("project-name").fill(name);
  await page.getByTestId("add-folder").click();
  const rows = page.getByTestId("repo-row");
  await expect(rows).toHaveCount(repos);
  // main has looked at every one: each has its access control in place of the spinner
  await expect(rows.getByRole("radiogroup")).toHaveCount(repos);
  return rows;
}

async function submit(page: Page): Promise<void> {
  await page.getByTestId("form-submit").click();
  await expect(page.getByTestId("project-form")).toHaveCount(0);
}

test("the first project: working copies, a reference, the prefix and the record's files", async () => {
  fx = makeFixture({ withCompanion: true, withClaude: true });
  const apiRepo = makeRepo(fx, "api", { branches: ["release"] });
  const shared = makeRepo(fx, "shared");
  const logs = makePlainDir(fx, "logs");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [apiRepo, shared, logs]);

  // no project yet: the window is the form, with nothing to cancel back to
  const form = page.getByTestId("project-form");
  await expect(form).toHaveAttribute("data-mode", "new");
  await expect(page.getByTestId("form-cancel")).toHaveCount(0);
  await expect(page.getByTestId("form-submit")).toBeDisabled();
  await expect(form).toContainText("The folder and card prefix come from the name.");
  await expect(page.getByTestId("repos-empty")).toHaveText("Add at least one repo.");

  const rows = await fillNew(page, "Prod debug", 3);
  await expect(form).toContainText(`Folder ${fx.root}/prod-debug · cards will be PROD-1, PROD-2…`);
  await expect(page.getByTestId("project-prefix")).toHaveCount(0);
  await page.getByTestId("project-goal").fill("Find why webhooks go missing");

  // a repo is a working copy unless it cannot be one
  await expect(rows.nth(0)).toHaveAttribute("data-mode", "worktree");
  await expect(rows.nth(1)).toHaveAttribute("data-mode", "worktree");
  await expect(rows.nth(2)).toHaveAttribute("data-mode", "reference");
  await expect(rows.nth(2).getByTestId("mode-worktree")).toBeDisabled();
  await expect(rows.nth(2).getByTestId("branch-toggle")).toHaveCount(0);
  await expect(rows.nth(2).getByTestId("repo-note")).toHaveText(
    "Not a git repository, so it can only be a reference.",
  );

  // detached unless the disclosure says otherwise. a new branch is named after the project
  await expect(rows.nth(1).getByTestId("branch-new")).toHaveCount(0);
  await rows.nth(1).getByTestId("branch-toggle").click();
  await expect(rows.nth(1).getByTestId("branch-detach")).toBeChecked();
  await rows.nth(1).getByTestId("branch-new").click();
  await expect(rows.nth(1).getByTestId("new-branch-name")).toHaveValue("prod-debug");

  await expect(page.getByTestId("form-submit")).toHaveText("Create project");
  await submit(page);
  // the new project's start state
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "cards");
  await expect(page.getByTestId("project-switcher")).toContainText("Prod debug");
  await expect(page.getByTestId("goal")).toHaveText("Find why webhooks go missing");
  await expect(page.getByTestId("start-state")).toBeVisible();

  const root = path.join(fx.root, "prod-debug");
  await expect
    .poll(() => folderStates(page, "prod-debug"), { timeout: 30_000 })
    .toEqual(["ok", "ok", "reference"]);
  expect(combos()).toMatchObject([
    { name: "Prod debug", root, prefix: "PROD", note: "Find why webhooks go missing" },
  ]);
  expect(git(path.join(root, "api"), "branch", "--show-current")).toBe("");
  expect(git(path.join(root, "shared"), "branch", "--show-current")).toBe("prod-debug");
  // the reference is the person's own clone and is never touched
  expect(readdirSync(logs)).toEqual(["notes.txt"]);
  const claudeMd = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  expect(claudeMd).toContain("# Prod debug");
  expect(claudeMd).toContain("A working copy is a git worktree");
  for (const dir of ["plans", "artifacts", "context"]) {
    expect(existsSync(path.join(root, dir)), dir).toBe(true);
  }

  // what grove writes for the record, and the self-check through the real launcher
  await waitFor(async () => (await project(page, "prod-debug"))?.server.state === "ok", 30_000);
  const mcp = JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8"));
  expect(mcp.mcpServers.grove.command).toBe(path.join(fx.root, ".grove", "bin", "record"));
  const settings = JSON.parse(
    readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"),
  );
  expect(settings.enabledMcpjsonServers).toContain("grove");
  expect(settings.permissions.allow).toContain("mcp__grove");
  expect(readFileSync(path.join(root, ".claude", "rules", "grove-record.md"), "utf8")).toContain(
    "PROD-",
  );
  expect(readProject(root)).toMatchObject({
    name: "Prod debug",
    prefix: "PROD",
    goal: "Find why webhooks go missing",
  });

  // opening it: the root first, then the reference, which Claude may read
  await page.keyboard.press("Meta+o");
  await waitFor(async () => readExecLog(fx).length > 0);
  expect(readExecLog(fx)[0]?.argv).toEqual([path.join(root, "prod-debug.code-workspace")]);
  const ws = JSON.parse(readFileSync(path.join(root, "prod-debug.code-workspace"), "utf8"));
  expect(ws.folders.map((f: { path: string }) => path.resolve(root, f.path))).toEqual([root, logs]);
  expect(
    JSON.parse(readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8")).permissions
      .additionalDirectories,
  ).toEqual([logs]);
});

test("a prefix another project uses brings up the prefix field, and Escape keeps a filled form", async () => {
  fx = makeFixture({ withCompanion: true });
  writeProject(fx, { name: "data-objects", prefix: "DATA", goal: "One schema for every object" });
  const pipelines = makeRepo(fx, "pipelines");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [pipelines]);

  await page.getByTestId("project-switcher").click();
  await page.getByTestId("new-project").click();
  const form = page.getByTestId("project-form");
  await expect(form).toHaveAttribute("data-mode", "new");
  await expect(page.getByTestId("form-cancel")).toBeVisible();
  // nothing typed: Escape goes back
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);

  // no clash, no field
  await fillNew(page, "billing", 1);
  await expect(form).toContainText("cards will be BILL-1, BILL-2…");
  await expect(page.getByTestId("project-prefix")).toHaveCount(0);
  await expect(page.getByTestId("form-submit")).toBeEnabled();
  // a stray Escape does not throw the form away
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-name")).toHaveValue("billing");

  // DATA is taken: the field comes with the prefix in it, to edit
  await page.getByTestId("project-name").fill("data-objects-test");
  const prefix = page.getByTestId("project-prefix");
  await expect(prefix).toHaveValue("DATA");
  await expect(form).toContainText('"data-objects" already uses the prefix DATA.');
  await expect(page.getByTestId("form-submit")).toBeDisabled();

  // conclusion ids own D, F and V
  await prefix.fill("d");
  await expect(form).toContainText(
    "D is taken by conclusion ids (D-1, F-1, V-1). Pick another prefix.",
  );
  await expect(page.getByTestId("form-submit")).toBeDisabled();
  await prefix.fill("dat2");
  await expect(prefix).toHaveValue("DAT2");
  await expect(form).toContainText("Cards will be DAT2-1, DAT2-2…");

  await submit(page);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "cards");
  await expect(page.getByTestId("project-switcher")).toContainText("data-objects-test");
  expect(combos().map((c) => c.prefix)).toEqual(["DATA", "DAT2"]);
  const root = path.join(fx.root, "data-objects-test");
  await waitFor(async () => readProject(root)?.prefix === "DAT2", 30_000);
});

test("Edit project: repos that were in it are fixed, and an edited goal bumps the project file's rev", async () => {
  fx = makeFixture({ withCompanion: true });
  const apiRepo = makeRepo(fx, "api");
  const docs = makePlainDir(fx, "docs");
  const { root } = writeProject(fx, {
    name: "auth-sso",
    prefix: "AUTH",
    goal: "SSO for the dashboard",
    folders: [
      { path: apiRepo, mode: "worktree", branch: { kind: "detach" } },
      { path: docs, mode: "reference" },
    ],
  });

  app = await launchApp(fx);
  const { page } = app;
  await page.getByTestId("nav-cards").click();
  await page.getByTestId("edit-project").click();

  const form = page.getByTestId("project-form");
  await expect(form).toHaveAttribute("data-mode", "edit");
  await expect(form.getByRole("heading", { level: 1 })).toHaveText("Edit auth-sso");
  await expect(form).toContainText(
    `The folder stays at ${root}. Only the name changes, and cards keep the AUTH prefix.`,
  );
  await expect(page.getByTestId("project-prefix")).toHaveCount(0);
  await expect(page.getByTestId("project-goal")).toHaveValue("SSO for the dashboard");

  // repos that were in the project are fixed: remove and add again to change one
  const rows = page.getByTestId("repo-row");
  await expect(rows).toHaveCount(2);
  for (const i of [0, 1]) await expect(rows.nth(i)).toHaveAttribute("data-locked", "true");
  await expect(rows.nth(0).getByTestId("mode-worktree")).toBeDisabled();
  await expect(rows.nth(0).getByTestId("mode-reference")).toBeDisabled();
  await expect(rows.nth(0).getByTestId("branch-toggle")).toHaveCount(0);
  await expect(form).toContainText("To change how a repo is included, remove it and add it again.");
  // a working record says nothing
  await expect(page.getByTestId("record-check")).toHaveCount(0);
  const save = page.getByTestId("form-submit");
  await expect(save).toHaveText("Save");
  await expect(save).toBeDisabled();

  const before = readProject(root)?.rev ?? 0;
  await page.getByTestId("project-goal").fill("SSO for the dashboard, okta first");
  // a form with changes is not thrown away by Escape
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  // Enter in a field is the button
  await expect(save).toBeEnabled();
  await page.getByTestId("project-goal").press("Enter");
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "cards");
  await expect(page.getByTestId("goal")).toHaveText("SSO for the dashboard, okta first");
  await waitFor(async () => readProject(root)?.rev === before + 1, 30_000);
  expect(readProject(root)).toMatchObject({
    name: "auth-sso",
    prefix: "AUTH",
    goal: "SSO for the dashboard, okta first",
  });

  // nothing changed this time: Escape leaves
  await page.getByTestId("edit-project").click();
  await expect(form).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
});

test("a project that has no repos can still be given a goal", async () => {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, { name: "notes", prefix: "NOTE" });

  app = await launchApp(fx);
  const { page } = app;
  await page.getByTestId("nav-cards").click();
  await page.getByTestId("edit-project").click();
  await expect(page.getByTestId("repos-empty")).toHaveText("This project has no repos.");
  const save = page.getByTestId("form-submit");
  await expect(save).toBeDisabled();

  await page.getByTestId("project-goal").fill("keep the notes in one place");
  await expect(save).toBeEnabled();
  await submit(page);
  await waitFor(async () => readProject(root)?.goal === "keep the notes in one place", 30_000);
  expect(combos()[0]).toMatchObject({ note: "keep the notes in one place", folders: [] });
});

// main refuses every rename today: `problemsWithDraft` hands `validateComboRoot` the project's own
// entry under its old name, so the draft "overlaps" with itself (main/services/combos.ts). the
// form shows that as a problem. passes once main leaves the project out of `others`
test("a rename keeps the folder, the id and the prefix", async () => {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "auth-sso",
    prefix: "AUTH",
    goal: "SSO for the dashboard",
    folders: [{ path: makePlainDir(fx, "docs"), mode: "reference" }],
  });
  writeProject(fx, { name: "billing-export", prefix: "BILL" });

  app = await launchApp(fx);
  const { page } = app;
  await page.getByTestId("nav-cards").click();
  await page.getByTestId("edit-project").click();
  const form = page.getByTestId("project-form");

  // another project's name is refused while it is typed
  await page.getByTestId("project-name").fill("Billing-Export");
  await expect(form).toContainText('"billing-export" already uses that name.');
  await expect(page.getByTestId("form-submit")).toBeDisabled();

  await page.getByTestId("project-name").fill("Auth SSO");
  await page.getByTestId("form-submit").click();
  await expect(page.getByTestId("cards-header")).toContainText("Auth SSO");
  await expect(page.getByTestId("project-switcher")).toContainText("Auth SSO");
  await waitFor(async () => readProject(root)?.name === "Auth SSO", 30_000);
  expect(combos()[0]).toMatchObject({ name: "Auth SSO", root, prefix: "AUTH" });
  expect((await api(page).bootstrap()).projects.map((p) => p.id)).toEqual([
    "auth-sso",
    "billing-export",
  ]);
});

test("the self-check is ok, and Cmd-R puts a deleted record.cjs back", async () => {
  fx = makeFixture({ withCompanion: true });
  writeProject(fx, { name: "auth-sso", prefix: "AUTH", goal: "SSO for the dashboard" });

  app = await launchApp(fx);
  const { page } = app;
  const server = async () => (await project(page, "auth-sso"))?.server;
  await waitFor(async () => (await server())?.state === "ok", 30_000);
  const first = await server();
  if (first?.state !== "ok") throw new Error("the first check did not pass");

  const bundle = path.join(fx.root, ".grove", "bin", "record.cjs");
  rmSync(bundle);
  await page.keyboard.press("Meta+r");
  await waitFor(async () => {
    const s = await server();
    return s?.state === "ok" && s.checkedAt > first.checkedAt;
  }, 30_000);
  expect(existsSync(bundle)).toBe(true);
  await expect(page.locator('[data-testid="banner"][data-reason="record"]')).toHaveCount(0);
});

test("an invalid .mcp.json is a config problem on Edit project, until it is fixed and checked again", async () => {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "auth-sso",
    prefix: "AUTH",
    goal: "SSO for the dashboard",
  });

  app = await launchApp(fx);
  const { page } = app;
  await waitFor(async () => (await project(page, "auth-sso"))?.server.state === "ok", 30_000);

  const file = path.join(root, ".mcp.json");
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "{ not json");
  await page.keyboard.press("Meta+r");

  const banner = page.locator('[data-testid="banner"][data-reason="record"]');
  await expect(banner).toContainText("Agents in auth-sso cannot reach the record.", {
    timeout: 30_000,
  });
  await page.getByTestId("banner-action").click();
  const check = page.getByTestId("record-check");
  await expect(check).toHaveAttribute("data-state", "failed");
  await expect(check).toContainText("Agents in this project cannot reach the record.");
  await expect(check).toContainText(
    `${file} is not valid JSON, so the grove server was not added.`,
  );
  await expect(check).toContainText("Fix it, then press ⌘R to check again.");
  // the sync's warning is the failure's own message: said once
  await expect(check).not.toContainText("Grove could not update this project's files.");
  expect((await project(page, "auth-sso"))?.server).toMatchObject({
    state: "failed",
    stage: "config",
  });

  writeFileSync(file, good);
  await page.keyboard.press("Meta+r");
  await expect(check).toHaveCount(0, { timeout: 30_000 });
  await expect(banner).toHaveCount(0);
  expect((await project(page, "auth-sso"))?.server.state).toBe("ok");
});

test("a second project that wants the same branch is told, and the rest of it still builds", async () => {
  fx = makeFixture({ withCompanion: true });
  const apiRepo = makeRepo(fx, "api");
  const shared = makeRepo(fx, "shared");

  app = await launchApp(fx);
  const { page } = app;

  await stubDirectoryPicker(app.app, [apiRepo]);
  let rows = await fillNew(page, "first", 1);
  await rows.nth(0).getByTestId("branch-toggle").click();
  await rows.nth(0).getByTestId("branch-new").click();
  await submit(page);
  await expect.poll(() => folderStates(page, "first"), { timeout: 30_000 }).toEqual(["ok"]);

  // "first" on api is taken. shared is free, and has to be built anyway
  await stubDirectoryPicker(app.app, [apiRepo, shared]);
  rows = await fillNew(page, "second", 2);
  for (const i of [0, 1]) {
    await rows.nth(i).getByTestId("branch-toggle").click();
    await rows.nth(i).getByTestId("branch-new").click();
    await rows.nth(i).getByTestId("new-branch-name").fill("first");
  }
  // the form says so before anything is created
  await expect(rows.nth(0)).toContainText("That branch is checked out at");
  await submit(page);

  const toast = page
    .getByTestId("toast")
    .filter({ hasText: 'branch "first" is already checked out' });
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText("The rest of the project was created");

  await expect
    .poll(async () => (await folderStates(page, "second"))?.[1], { timeout: 30_000 })
    .toBe("ok");
  expect(git(path.join(fx.root, "second", "shared"), "branch", "--show-current")).toBe("first");
  // the original clone is untouched by any of it
  expect(git(apiRepo, "status", "--porcelain")).toBe("");
});

test("drift and a shadowing server are notes on Edit project, and a repair fixes what it can", async () => {
  fx = makeFixture({ withCompanion: true });
  const apiRepo = makeRepo(fx, "api");
  const shared = makeRepo(fx, "shared");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [apiRepo, shared]);
  await fillNew(page, "prod-debug", 2);
  await submit(page);
  await expect
    .poll(() => folderStates(page, "prod-debug"), { timeout: 30_000 })
    .toEqual(["ok", "ok"]);

  // someone removes a worktree behind git's back, and drops a folder where another one belongs
  const root = path.join(fx.root, "prod-debug");
  rmSync(path.join(root, "api"), { recursive: true, force: true });
  rmSync(path.join(root, "shared"), { recursive: true, force: true });
  mkdirSync(path.join(root, "shared"), { recursive: true });
  writeFileSync(path.join(root, "shared", "important.txt"), "not a worktree\n");

  await page.keyboard.press("Meta+r");
  await page.getByTestId("edit-project").click();
  const rows = page.getByTestId("repo-row");
  await expect(rows.nth(0).getByTestId("repo-note")).toHaveText(
    "Folder was deleted. Git still lists this working copy, but the directory is gone. Repair working copies (⌘K) recreates it.",
    { timeout: 30_000 },
  );
  await expect(rows.nth(1).getByTestId("repo-note")).toHaveText(
    "Something else is here. This folder is not a working copy of the original repo and was left untouched. Move or rename it, then repair working copies (⌘K).",
  );

  // the call the palette's Repair working copies makes: the stale one comes back, the foreign
  // one is left alone, file and all
  await page.evaluate(() => window.grove.repairProject("prod-debug"));
  await expect(rows.nth(0).getByTestId("repo-note")).toHaveCount(0, { timeout: 30_000 });
  await expect(rows.nth(1).getByTestId("repo-note")).toContainText("Something else is here.");
  expect(readFileSync(path.join(root, "shared", "important.txt"), "utf8")).toBe("not a worktree\n");

  // a working copy whose own .mcp.json declares a grove server
  writeFileSync(
    path.join(root, "api", ".mcp.json"),
    JSON.stringify({ mcpServers: { grove: { command: "/usr/bin/true" } } }),
  );
  await page.keyboard.press("Meta+r");
  await expect(rows.nth(0).getByTestId("repo-note")).toHaveText(
    "Its .mcp.json also declares a server called grove. Sessions started inside it may use that one instead of the project's.",
    { timeout: 30_000 },
  );
});

test("removing working copies on Edit project takes the clean one down and keeps the one with changes", async () => {
  fx = makeFixture({ withCompanion: true });
  const apiRepo = makeRepo(fx, "api");
  const shared = makeRepo(fx, "shared");
  const logs = makePlainDir(fx, "logs");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [apiRepo, shared, logs]);
  await fillNew(page, "prod-debug", 3);
  await submit(page);
  await expect
    .poll(() => folderStates(page, "prod-debug"), { timeout: 30_000 })
    .toEqual(["ok", "ok", "reference"]);

  const root = path.join(fx.root, "prod-debug");
  const dirty = path.join(root, "api", "work-in-progress.txt");
  writeFileSync(dirty, "half an hour of work\n");

  await page.getByTestId("edit-project").click();
  const rows = page.getByTestId("repo-row");
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId("remove-warning")).toHaveCount(0);
  await rows.nth(1).getByTestId("repo-remove").click();
  await rows.nth(0).getByTestId("repo-remove").click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("remove-warning")).toHaveText(
    "Removing a working copy removes its worktree from the project folder. One with uncommitted changes stays.",
  );
  await page.getByTestId("form-submit").click();

  // the removal never forces: the one with work in it stays in the project, and says why
  const toast = page.getByTestId("toast").filter({ hasText: "api: kept in the project" });
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText("It has uncommitted changes");
  expect(readFileSync(dirty, "utf8")).toBe("half an hour of work\n");
  expect(existsSync(path.join(root, "shared"))).toBe(false);
  expect(
    combos()[0]
      ?.folders.map((f) => path.basename(f.path))
      .sort(),
  ).toEqual(["api", "logs"]);
  // whatever happened to the worktrees, the original clones are exactly as they were
  for (const repo of [apiRepo, shared]) {
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "branch", "--show-current")).toBe("main");
  }
});

test("repos people keep using are one click away, and two with one name say where they are", async () => {
  fx = makeFixture({ withCompanion: true });
  writeProject(fx, { name: "scratch", prefix: "SCRA" });
  const mine = makeRepo(fx, "mine/api");
  const theirs = makeRepo(fx, "theirs/api");
  const web = makeRepo(fx, "web");
  mkdirSync(path.join(mine, "services", "billing"), { recursive: true });
  // a session started in a subfolder still counts toward its repo
  const sessions = [path.join(mine, "services", "billing"), mine, theirs, web];
  for (const [i, cwd] of sessions.entries()) {
    writeSession(fx, {
      cwd,
      sessionId: `aaaaaaaa-0000-4000-8000-00000000000${i}`,
      title: path.basename(cwd),
      ageMs: (i + 1) * 60_000,
    });
  }

  app = await launchApp(fx);
  const { page } = app;
  // the form asks once, when it opens: wait until main has read the sessions
  await waitFor(
    async () => (await page.evaluate(() => window.grove.frequentFolders())).length === 3,
  );
  await page.keyboard.press("Meta+n");
  const chips = page.getByTestId("repo-suggestion");
  await expect(chips).toHaveText(["mine/api", "theirs/api", "web"]);

  await chips.first().click();
  const rows = page.getByTestId("repo-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(mine);
  await expect(rows.first()).toHaveAttribute("data-mode", "worktree");
  // an added folder leaves the strip, and the one left needs no parent to tell it apart
  await expect(chips).toHaveText(["api", "web"]);
  // the same folder from the picker is not added twice
  await stubDirectoryPicker(app.app, [mine]);
  await page.getByTestId("add-folder").click();
  await expect(rows).toHaveCount(1);
});
