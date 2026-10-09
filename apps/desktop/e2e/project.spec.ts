import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
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
import { interrupted, writeProject } from "./helpers/project.ts";

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/** a project's screen, from the sidebar */
const show = (page: Page, id: string) =>
  page.locator(`[data-testid="project-item"][data-id="${id}"]`).click();
const project = async (page: Page, id: string) =>
  (await api(page).bootstrap()).projects.find((p) => p.id === id);
const folderStates = async (page: Page, id: string) =>
  (await project(page, id))?.folders.map((f) => f.state);
const combos = (): Array<{
  name: string;
  root: string;
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

test("the first project: working copies, a reference, and nothing of the record", async () => {
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
  await expect(form).toContainText("The folder comes from the name.");
  await expect(page.getByTestId("repos-empty")).toHaveText("Add at least one repo.");

  const rows = await fillNew(page, "Prod debug", 3);
  await expect(form).toContainText(`Folder ${fx.root}/prod-debug`);
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
  // the new project's screen: no sessions yet, and how to start one
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "sessions");
  await expect(page.getByTestId("project-name")).toHaveText("Prod debug");
  await expect(page.getByTestId("project-name")).toHaveAttribute(
    "title",
    "Prod debug: Find why webhooks go missing",
  );
  await expect(page.getByTestId("sessions-empty")).toBeVisible();
  // it is in the sidebar, and marked
  await expect(page.locator('[data-testid="project-item"][data-id="prod-debug"]')).toHaveAttribute(
    "aria-current",
    "page",
  );

  const root = path.join(fx.root, "prod-debug");
  await expect
    .poll(() => folderStates(page, "prod-debug"), { timeout: 30_000 })
    .toEqual(["ok", "ok", "reference"]);
  expect(combos()).toMatchObject([
    { name: "Prod debug", root, note: "Find why webhooks go missing" },
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

  // it says where sessions leave word for each other, and names no tool
  expect(claudeMd).toContain("The files in `context/` are the only\nmemory you have in common.");
  expect(claudeMd).not.toContain("record");
  // what grove writes into it: the status hooks, and no server, rules or runtime for a record
  const settings = JSON.parse(
    readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"),
  );
  expect(Object.keys(settings.hooks)).toContain("PermissionRequest");
  expect(JSON.stringify(settings)).not.toMatch(/grove-record|mcp__grove/);
  expect(settings.enabledMcpjsonServers).toBeUndefined();
  for (const gone of [".mcp.json", ".claude/rules", ".claude/grove-project.json", "cards"]) {
    expect(existsSync(path.join(root, gone)), gone).toBe(false);
  }
  expect(existsSync(path.join(fx.root, ".grove", "bin"))).toBe(false);

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

test("the + beside Projects is the form, a taken name is refused, and Escape keeps a filled form", async () => {
  fx = makeFixture({ withCompanion: true });
  writeProject(fx, { name: "data-objects", goal: "One schema for every object" });
  const pipelines = makeRepo(fx, "pipelines");

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [pipelines]);

  await page.getByTestId("new-project").click();
  const form = page.getByTestId("project-form");
  await expect(form).toHaveAttribute("data-mode", "new");
  await expect(page.getByTestId("form-cancel")).toBeVisible();
  // nothing typed: Escape goes back
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);

  await fillNew(page, "billing", 1);
  await expect(form).toContainText(`Folder ${fx.root}/billing`);
  await expect(page.getByTestId("form-submit")).toBeEnabled();
  // a stray Escape does not throw the form away
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-name")).toHaveValue("billing");

  // another project's name, however it is cased
  await page.getByTestId("project-name").fill("Data-Objects");
  await expect(form).toContainText('"data-objects" already uses that name.');
  await expect(page.getByTestId("form-submit")).toBeDisabled();

  await page.getByTestId("project-name").fill("data-objects-test");
  await submit(page);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "sessions");
  await expect(page.getByTestId("project-name")).toHaveText("data-objects-test");
  expect(combos().map((c) => c.name)).toEqual(["data-objects", "data-objects-test"]);
  // a project made by 0.11 has no card prefix
  expect(readFileSync(path.join(fx.root, "combos.json"), "utf8")).not.toContain("prefix");
});

test("Edit project: repos that were in it are fixed, and an edited goal is saved", async () => {
  fx = makeFixture({ withCompanion: true });
  const apiRepo = makeRepo(fx, "api");
  const docs = makePlainDir(fx, "docs");
  const { root } = writeProject(fx, {
    name: "auth-sso",
    goal: "SSO for the dashboard",
    folders: [
      { path: apiRepo, mode: "worktree", branch: { kind: "detach" } },
      { path: docs, mode: "reference" },
    ],
  });

  app = await launchApp(fx);
  const { page } = app;
  await show(page, "auth-sso");
  await page.getByTestId("edit-project").click();

  const form = page.getByTestId("project-form");
  await expect(form).toHaveAttribute("data-mode", "edit");
  await expect(form.getByRole("heading", { level: 1 })).toHaveText("Edit auth-sso");
  await expect(form).toContainText(`The folder stays at ${root}. Only the name changes.`);
  await expect(page.getByTestId("project-goal")).toHaveValue("SSO for the dashboard");

  // repos that were in the project are fixed: remove and add again to change one
  const rows = page.getByTestId("repo-row");
  await expect(rows).toHaveCount(2);
  for (const i of [0, 1]) await expect(rows.nth(i)).toHaveAttribute("data-locked", "true");
  await expect(rows.nth(0).getByTestId("mode-worktree")).toBeDisabled();
  await expect(rows.nth(0).getByTestId("mode-reference")).toBeDisabled();
  await expect(rows.nth(0).getByTestId("branch-toggle")).toHaveCount(0);
  await expect(form).toContainText("To change how a repo is included, remove it and add it again.");
  // nothing grove could not write: nothing said
  await expect(page.getByTestId("sync-problem")).toHaveCount(0);
  const save = page.getByTestId("form-submit");
  await expect(save).toHaveText("Save");
  await expect(save).toBeDisabled();

  await page.getByTestId("project-goal").fill("SSO for the dashboard, okta first");
  // a form with changes is not thrown away by Escape
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  // Enter in a field is the button
  await expect(save).toBeEnabled();
  await page.getByTestId("project-goal").press("Enter");
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "sessions");
  await expect(page.getByTestId("project-name")).toHaveAttribute(
    "title",
    "auth-sso: SSO for the dashboard, okta first",
  );
  expect(combos()[0]).toMatchObject({
    name: "auth-sso",
    root,
    note: "SSO for the dashboard, okta first",
  });

  // nothing changed this time: Escape leaves
  await page.getByTestId("edit-project").click();
  await expect(form).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
});

test("a project that has no repos can still be given a goal", async () => {
  fx = makeFixture({ withCompanion: true });
  writeProject(fx, { name: "notes" });

  app = await launchApp(fx);
  const { page } = app;
  await show(page, "notes");
  await page.getByTestId("edit-project").click();
  await expect(page.getByTestId("repos-empty")).toHaveText("This project has no repos.");
  const save = page.getByTestId("form-submit");
  await expect(save).toBeDisabled();

  await page.getByTestId("project-goal").fill("keep the notes in one place");
  await expect(save).toBeEnabled();
  await submit(page);
  expect(combos()[0]).toMatchObject({ note: "keep the notes in one place", folders: [] });
});

// the root check must leave the project's own entry out, or a rename "overlaps" with itself
test("a rename keeps the folder and the id", async () => {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "auth-sso",
    goal: "SSO for the dashboard",
    folders: [{ path: makePlainDir(fx, "docs"), mode: "reference" }],
  });
  writeProject(fx, { name: "billing-export" });

  app = await launchApp(fx);
  const { page } = app;
  await show(page, "auth-sso");
  await page.getByTestId("edit-project").click();
  const form = page.getByTestId("project-form");

  // another project's name is refused while it is typed
  await page.getByTestId("project-name").fill("Billing-Export");
  await expect(form).toContainText('"billing-export" already uses that name.');
  await expect(page.getByTestId("form-submit")).toBeDisabled();

  await page.getByTestId("project-name").fill("Auth SSO");
  await page.getByTestId("form-submit").click();
  await expect(page.getByTestId("project-name")).toHaveText("Auth SSO");
  await expect(page.locator('[data-testid="project-item"][data-id="auth-sso"]')).toHaveText(
    "Auth SSO",
  );
  await expect.poll(() => combos()[0]?.name).toBe("Auth SSO");
  expect(combos()[0]).toMatchObject({ name: "Auth SSO", root });
  expect((await api(page).bootstrap()).projects.map((p) => p.id)).toEqual([
    "auth-sso",
    "billing-export",
  ]);
});

// what 0.10 wrote into a project, captured from 0.10's own code (see recordCleanup.test.ts in core)
const RECORD_0_10 = path.join(
  import.meta.dirname,
  "../../../packages/core/test/fixtures/record-0.10",
);

test("a project as 0.10 left it: the record is taken out at launch, and what was dismissed stays dismissed", async () => {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "auth-sso",
    goal: "SSO for the dashboard",
  });
  // the files 0.10 made and synced, with this machine's paths, and what an agent and the person left
  cpSync(RECORD_0_10, root, { recursive: true });
  for (const name of readdirSync(root, { recursive: true }).map(String)) {
    const file = path.join(root, name);
    if (!statSync(file).isFile()) continue;
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("/Users/you/claude-ws", fx.root));
  }
  mkdirSync(path.join(root, "cards", "AUTH-1"), { recursive: true });
  writeFileSync(path.join(root, "cards", "AUTH-1", "card.md"), "# Point staging at okta\n");
  const bin = path.join(fx.root, ".grove", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "record"), "#!/bin/sh\n");
  writeFileSync(path.join(bin, "record.cjs"), "// grove-record app=0.10.17\n");
  // two sessions stopped mid-turn. he dismissed the first under 0.10, which filed it under AUTH,
  // the card prefix the project file in the folder still names
  const [seen, fresh] = [
    "aaaaaaaa-0000-4000-8000-000000000001",
    "bbbbbbbb-0000-4000-8000-000000000002",
  ];
  const at = Date.now() - 60_000;
  writeSession(fx, { cwd: root, sessionId: seen as string, title: "dismissed last week" });
  writeSession(fx, { cwd: root, sessionId: fresh as string, title: "stopped just now" });
  interrupted(fx, { [seen as string]: at, [fresh as string]: at });
  const marks = path.join(fx.root, "reviewed.json");
  writeFileSync(
    marks,
    JSON.stringify({ [`AUTH/stopped:${seen}@${at}`]: { at: 5 }, "AUTH/conclusion:D-1": { at: 6 } }),
  );

  app = await launchApp(fx);
  const { page } = app;
  // the one he dismissed does not come back
  await expect(page.getByTestId("inbox-row")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("inbox-row")).toContainText("stopped just now");
  expect(JSON.parse(readFileSync(marks, "utf8"))).toEqual({
    [`auth-sso/stopped:${seen}@${at}`]: { at: 5 },
    "auth-sso/conclusion:D-1": { at: 6 },
  });

  // the server, the rules, the hook and the allow rules, the launcher and the bundle: gone
  const settings = () => readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8");
  await expect
    .poll(() => existsSync(path.join(root, ".mcp.json")), { timeout: 15_000 })
    .toBe(false);
  await expect.poll(() => /grove-record|mcp__grove|bin\/record/.test(settings())).toBe(false);
  expect(existsSync(path.join(root, ".claude", "rules"))).toBe(false);
  expect(existsSync(bin)).toBe(false);
  // the status hooks are where this inbox comes from: they stay, pointed at this app's events
  expect(JSON.parse(settings()).hooks.Stop[0].hooks[0].command).toContain(
    path.join(fx.root, ".grove", "events"),
  );
  // its stub and its agent say `context/` again, and name no tool that is gone
  for (const name of ["CLAUDE.md", ".claude/agents/long-task.md"]) {
    const text = readFileSync(path.join(root, name), "utf8");
    expect(text, name).toContain("context/");
    expect(text, name).not.toMatch(/record_state|conclusion_record|comment_add/);
  }
  // the person's own: the cards agents wrote, and the project file
  expect(readFileSync(path.join(root, "cards", "AUTH-1", "card.md"), "utf8")).toBe(
    "# Point staging at okta\n",
  );
  expect(
    JSON.parse(readFileSync(path.join(root, ".claude", "grove-project.json"), "utf8")),
  ).toEqual({ v: 1, name: "auth-sso", prefix: "AUTH", goal: "SSO for the dashboard", rev: 1 });
  // nothing is wrong with a project that was cleaned
  await show(page, "auth-sso");
  await expect(page.getByTestId("banner")).toHaveCount(0);

  // again, on a refresh: not one file is written
  const files = () =>
    readdirSync(root, { recursive: true })
      .map(String)
      .sort()
      .map((n) => [n, statSync(path.join(root, n)).mtimeMs]);
  const before = [files(), statSync(marks).mtimeMs];
  await page.keyboard.press("Meta+r");
  await page.waitForTimeout(1_500);
  expect([files(), statSync(marks).mtimeMs]).toEqual(before);
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

test("drift is a note on Edit project, and a repair fixes what it can", async () => {
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

test("Delete project is for the disk: no checkbox, a working copy with changes blocks it, then the folder goes to the trash. Archive instead keeps everything", async () => {
  fx = makeFixture({ withCompanion: true });
  const apiRepo = makeRepo(fx, "api");
  const shared = makeRepo(fx, "shared");
  const notes = writeProject(fx, { name: "notes", goal: "Keep the notes in one place" });

  app = await launchApp(fx);
  const { page } = app;
  await stubDirectoryPicker(app.app, [apiRepo, shared]);
  await fillNew(page, "prod-debug", 2);
  await submit(page);
  await expect
    .poll(() => folderStates(page, "prod-debug"), { timeout: 30_000 })
    .toEqual(["ok", "ok"]);
  const root = path.join(fx.root, "prod-debug");
  const dirty = path.join(root, "api", "work-in-progress.txt");
  writeFileSync(dirty, "half an hour of work\n");
  // a test root never uses the real Trash: a deleted project's folder is moved here
  const trash = path.join(fx.root, ".grove", "trash");

  // from the foot of its form, where he looked for it
  await page.getByTestId("edit-project").click();
  await page.getByTestId("form-delete").click();
  const dialog = page.getByTestId("delete-dialog");
  await expect(dialog).toHaveAttribute("aria-label", "Delete prod-debug?");
  // nothing to tick: delete always takes the folder
  await expect(dialog.locator("input")).toHaveCount(0);
  await expect(dialog).toContainText(
    "Delete is for getting disk space back. The clean working copies are removed and the project folder, with its CLAUDE.md, plans and notes, goes to the Trash. Original clones and past sessions are not touched.",
  );
  // and which folder that is
  await expect(page.getByTestId("delete-folder")).toHaveAttribute("title", root);
  await expect(page.getByTestId("archive-hint")).toHaveText(
    "Archiving puts the project away and keeps everything.",
  );
  await expect(page.getByTestId("archive-instead")).toBeVisible();

  // the working copy with work in it is never forced: nothing is deleted, and it says which one
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("delete-blocked")).toContainText(
    "api - kept - it has uncommitted changes",
    { timeout: 30_000 },
  );
  expect(readFileSync(dirty, "utf8")).toBe("half an hour of work\n");
  expect(combos().map((c) => c.name)).toEqual(["notes", "prod-debug"]);
  expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(true);
  expect(existsSync(trash)).toBe(false);

  // the work is dealt with: the same button deletes
  rmSync(dirty);
  await page.getByTestId("delete-confirm").click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("toast").filter({ hasText: "Deleted prod-debug" })).toBeVisible();
  expect(combos().map((c) => c.name)).toEqual(["notes"]);
  // the folder is gone from the projects, whole, and is in the trash with what he wrote in it
  expect(existsSync(root)).toBe(false);
  const [gone, ...more] = readdirSync(trash);
  expect(more).toEqual([]);
  expect(gone).toMatch(/^prod-debug-\d+$/);
  expect(existsSync(path.join(trash, gone as string, "CLAUDE.md"))).toBe(true);
  for (const copy of ["api", "shared"]) {
    expect(existsSync(path.join(trash, gone as string, copy)), copy).toBe(false);
  }
  // the original clones are exactly as they were
  for (const repo of [apiRepo, shared]) {
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  }
  // its screen went with it: the project that is left
  await expect(page.getByTestId("project-name")).toHaveText("notes");
  await expect(page.locator('[data-testid="project-item"][data-id="prod-debug"]')).toHaveCount(0);

  // Archive instead, from the same dialog: put away, with everything kept
  await page.getByTestId("open-palette").click();
  await page.getByTestId("palette-input").fill("delete");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveAttribute("aria-label", "Delete notes?");
  await page.getByTestId("archive-instead").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("toast").filter({ hasText: "Archived notes" })).toBeVisible();
  expect(combos()).toMatchObject([{ name: "notes", root: notes.root, archived: true }]);
  expect(existsSync(notes.root)).toBe(true);
  expect(readdirSync(trash)).toEqual([gone]);
  // every project is archived now. that is still a project: All sessions, not the first-run form
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
  await expect(page.getByTestId("project-form")).toHaveCount(0);
  await expect(page.getByTestId("archived-toggle")).toHaveText(/^Archived\s*1$/);
  // on an archived project the dialog has nothing to offer instead
  await page.getByTestId("archived-toggle").click();
  await show(page, "notes");
  await page.getByTestId("edit-project").click();
  await expect(page.getByTestId("form-archive")).toHaveText("Unarchive");
  await page.getByTestId("form-delete").click();
  await expect(dialog).toContainText("Delete is for getting disk space back.");
  await expect(page.getByTestId("archive-instead")).toHaveCount(0);
  await expect(page.getByTestId("archive-hint")).toHaveCount(0);
});

test("repos people keep using are one click away, and two with one name say where they are", async () => {
  fx = makeFixture({ withCompanion: true });
  writeProject(fx, { name: "scratch" });
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
