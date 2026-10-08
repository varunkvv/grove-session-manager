import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type Fixture,
  hookEvent,
  makeFixture,
  makePlainDir,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { groveTest, type LaunchedApp, launchApp, step } from "./helpers/launchApp.ts";
import { interrupted, liveSession, writeProject } from "./helpers/project.ts";

const SID = {
  /** its turn ended on a question. in the editor */
  turn: "aaaaaaaa-0000-4000-8000-000000000001",
  /** waits on a permission prompt. held by the supervisor, which has not said which session it is */
  permission: "bbbbbbbb-0000-4000-8000-000000000002",
  /** its process went away mid-turn while grove was closed */
  stopped: "cccccccc-0000-4000-8000-000000000003",
  /** in the other project, stopped on an api error */
  failed: "dddddddd-0000-4000-8000-000000000004",
  /** in the project, and needs nothing */
  quiet: "eeeeeeee-0000-4000-8000-000000000005",
  /** in no project */
  loose: "ffffffff-0000-4000-8000-000000000006",
};

const QUESTION = "Create a dev tenant, or point staging at the prod tenant with its own app?";
// what an agent wrote is untrusted: the tag must come out as the text it is
const REPLY = `Staging has no okta tenant.\n\n- one app per **environment**\n- no wildcard <b id="evil">hosts</b>\n\n${QUESTION}`;

let fx: Fixture;
let app: LaunchedApp;
let root: string;

test.afterEach(async () => {
  await app?.close();
});

/**
 * two projects and a row of every kind: Your turn, Needs permission and Stopped in auth-sso,
 * Failed in billing-export. the events were written while grove was closed
 */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  root = writeProject(fx, { name: "auth-sso", goal: "SSO for the dashboard" }).root;
  const billing = writeProject(fx, { name: "billing-export" }).root;

  writeSession(fx, {
    cwd: root,
    sessionId: SID.turn,
    title: "idp config",
    branch: "feat/okta-staging",
    prompt: "point staging at okta",
    reply: REPLY,
  });
  liveSession(fx, { sessionId: SID.turn, kind: "interactive", entrypoint: "claude-vscode" });
  writeSession(fx, { cwd: root, sessionId: SID.permission, title: "login page" });
  liveSession(fx, { sessionId: SID.permission, kind: "bg" });
  writeSession(fx, {
    cwd: root,
    sessionId: SID.stopped,
    title: "callback handler",
    lastPrompt: "Wire the callback route",
  });
  interrupted(fx, { [SID.stopped]: Date.now() - 60_000 });
  writeSession(fx, { cwd: root, sessionId: SID.quiet, title: "chat-features-35" });
  writeSession(fx, { cwd: billing, sessionId: SID.failed, title: "export job" });
  writeSession(fx, { cwd: makePlainDir(fx, "scratch"), sessionId: SID.loose, title: "notes" });

  hookEvent(fx, SID.turn, "Stop", { last_assistant_message: REPLY });
  hookEvent(fx, SID.permission, "PermissionRequest", {
    tool_name: "Bash",
    tool_input: { command: "pnpm test --filter login" },
  });
  hookEvent(fx, SID.failed, "StopFailure", { message: "API Error: 529 Overloaded" });
  return fx;
}

const rows = (page: Page) => page.getByTestId("inbox-row");
const row = (page: Page, kind: string) =>
  page.locator(`[data-testid="inbox-row"][data-kind="${kind}"]`);
/** the row in the panel */
const openRow = (page: Page) => page.locator('[data-testid="inbox-row"][data-open]');
const panel = (page: Page) => page.getByTestId("session-panel");
/** every time the editor was run */
const code = () => readExecLog(fx).filter((l) => l.bin === "code");
const kinds = (page: Page) =>
  rows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind));
const count = (item: Locator) => item.getByTestId("count");
const projectItem = (page: Page, id: string) =>
  page.locator(`[data-testid="project-item"][data-id="${id}"]`);

/** the statuses are read after the page is up */
async function ready(page: Page, n = 4): Promise<void> {
  await expect(rows(page)).toHaveCount(n, { timeout: 15_000 });
}

/**
 * a row's buttons only show under the mouse. this is a real window, and the real pointer takes the
 * hover away when another window opens over it: hover again until what follows holds
 */
async function under(target: Locator, then: () => Promise<unknown>): Promise<void> {
  await expect(async () => {
    await target.hover({ timeout: 2_000 });
    await then();
  }).toPass({ timeout: 30_000 });
}

const dismiss = (target: Locator) =>
  under(target, () => target.getByTestId("inbox-dismiss").click({ timeout: 2_000 }));

test("one row for each session that needs him, from every project, and the sidebar counts them by project", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);

  // newest first: the one that stopped a minute ago is last
  const got = await kinds(page);
  expect([...got].sort()).toEqual(["failed", "permission", "stopped", "turn"]);
  expect(got[3]).toBe("stopped");
  // the sidebar: every row on the inbox, and each project's own. the tray counts them all
  await expect(count(page.getByTestId("nav-inbox"))).toHaveText("4");
  await expect(page.getByTestId("nav-inbox")).toHaveAttribute("aria-current", "page");
  await expect(count(projectItem(page, "auth-sso"))).toHaveText("3");
  await expect(count(projectItem(page, "billing-export"))).toHaveText("1");
  expect(await groveTest(app.app).trayTitle()).toBe("4");

  const turn = row(page, "turn");
  await expect(turn).toHaveAttribute("data-id", SID.turn);
  await expect(turn).toContainText("idp config");
  await expect(turn.getByTestId("state")).toHaveText("Your turn");
  // the end of its last message, where the question is
  await expect(turn.getByTestId("inbox-summary")).toHaveText(QUESTION);
  await expect(turn.getByTestId("inbox-project")).toHaveText("auth-sso");
  await expect(turn.getByTestId("runtime-chip")).toHaveText("VS Code");
  const permission = row(page, "permission");
  await expect(permission.getByTestId("state")).toHaveText("Needs permission");
  await expect(permission.getByTestId("inbox-summary")).toHaveText("Bash pnpm test --filter login");
  await expect(row(page, "stopped").getByTestId("inbox-summary")).toHaveText(
    "Wire the callback route",
  );
  await expect(row(page, "stopped").getByTestId("runtime-chip")).toHaveText("Closed");
  const failed = row(page, "failed");
  await expect(failed).toContainText("export job");
  await expect(failed.getByTestId("inbox-project")).toHaveText("billing-export");
  await expect(failed.getByTestId("inbox-summary")).toHaveText("API Error: 529 Overloaded");
  // each project has its own colour, on its rows and beside its name
  const hue = (l: Locator) => l.getByTestId("project-mark").getAttribute("data-hue");
  expect(await hue(turn)).toBe(await hue(projectItem(page, "auth-sso")));
  expect(await hue(failed)).toBe(await hue(projectItem(page, "billing-export")));
  expect(await hue(failed)).not.toBe(await hue(turn));

  // where it is and when give way to the two buttons under the mouse
  await expect(turn.getByTestId("inbox-dismiss")).toBeHidden();
  await under(turn, async () => {
    await expect(turn.getByTestId("inbox-dismiss")).toHaveText("Dismiss", { timeout: 2_000 });
    await expect(turn.getByTestId("inbox-open")).toHaveText("Open in VS Code", { timeout: 2_000 });
    await expect(turn.getByTestId("runtime-chip")).toBeHidden({ timeout: 2_000 });
  });

  // an agent grove cannot open yet: the button says why, and a click on it is not a click on the row
  await expect(permission.getByTestId("runtime-chip")).toHaveText("Background");
  await expect(permission.getByTestId("inbox-open")).toBeDisabled();
  await expect(permission.getByTestId("inbox-open")).toHaveAttribute(
    "title",
    "running in the background",
  );
  // force: playwright would wait for the button to be enabled
  await under(permission, () =>
    permission.getByTestId("inbox-open").click({ force: true, timeout: 2_000 }),
  );
  await expect(page.getByTestId("panel")).toHaveCount(0);
});

test("Dismiss takes a row out: a stop is written down, a turn is only seen until its next event", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  const file = path.join(fx.root, "reviewed.json");
  const marks = () => (existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, "utf8"))) : []);

  await dismiss(row(page, "turn"));
  await ready(page, 3);
  await expect(row(page, "turn")).toHaveCount(0);
  await expect(count(projectItem(page, "auth-sso"))).toHaveText("2");
  // nothing was stored: looking at a session is not a decision
  expect(marks()).toEqual([]);

  // the row leaves the page at once, before main has written the file, and a poll that throws ends
  await dismiss(row(page, "stopped"));
  await ready(page, 2);
  await expect.poll(marks).toHaveLength(1);
  // filed under the project's id, which a rename does not change
  expect(marks()[0]).toMatch(new RegExp(`^auth-sso/stopped:${SID.stopped}@\\d+$`));

  // its next turn brings the session back, with what it asks now
  hookEvent(fx, SID.turn, "UserPromptSubmit");
  hookEvent(fx, SID.turn, "Stop", { last_assistant_message: "Opened it. Merge now?" });
  await expect(row(page, "turn").getByTestId("inbox-summary")).toHaveText("Opened it. Merge now?");
  await expect(count(page.getByTestId("nav-inbox"))).toHaveText("3");

  // the last rows go, and so do the counts
  await dismiss(row(page, "turn"));
  await dismiss(row(page, "permission"));
  await dismiss(row(page, "failed"));
  await expect(page.getByTestId("inbox-empty")).toHaveText("Nothing needs you.");
  await expect(page.getByTestId("count")).toHaveCount(0);
  expect(await groveTest(app.app).trayTitle()).toBe("");
});

test("a click opens the session in a panel beside the list, another row swaps it, Escape closes it", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  const chips = page.getByTestId("inbox").getByTestId("runtime-chip");
  // at most one row is under a pointer, and that one shows its buttons instead
  await expect(chips.filter({ visible: true })).not.toHaveCount(0);

  await row(page, "turn").click();
  await expect(panel(page)).toHaveAttribute("data-id", SID.turn);
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("idp config");
  await expect(panel(page).getByTestId("state")).toHaveAttribute("data-state", "turn");
  // where it is: the project, the branch, where it runs
  const meta = panel(page).getByTestId("panel-meta");
  await expect(meta).toContainText("auth-sso");
  await expect(meta).toContainText("feat/okta-staging");
  await expect(meta.getByTestId("runtime-chip")).toHaveText("VS Code");
  // what he last said to it, and what it said last in full, drawn as markdown
  await expect(panel(page).getByTestId("panel-prompt")).toHaveText("point staging at okta");
  const said = panel(page).getByTestId("panel-text");
  await expect(said).toContainText("Staging has no okta tenant.");
  await expect(said).toContainText(QUESTION);
  await expect(said.locator("li")).toHaveCount(2);
  await expect(said.locator("strong")).toHaveText("environment");
  // an agent's html is its text, never an element
  await expect(said).toContainText('<b id="evil">hosts</b>');
  await expect(page.locator("#evil")).toHaveCount(0);
  await expect(panel(page).getByTestId("panel-open")).toHaveText("Open in VS Code");
  await expect(panel(page).getByTestId("panel-dismiss")).toHaveText("Dismiss");

  // the list is still there, with that row marked, and it kept the keyboard
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
  await expect(rows(page)).toHaveCount(4);
  await expect(openRow(page)).toHaveAttribute("data-kind", "turn");
  await expect(page.getByRole("listbox")).toBeFocused();
  // half the window is not room for where it is: the title keeps it, and the state is its mark
  await expect(chips.filter({ visible: true })).toHaveCount(0);
  await expect(row(page, "stopped").getByTestId("inbox-project")).toBeHidden();
  await expect(row(page, "stopped").getByTestId("project-mark")).toBeVisible();
  await expect(row(page, "stopped").getByTestId("state")).toBeVisible();
  await expect(row(page, "stopped").getByTestId("state").getByText("Stopped")).toBeHidden();
  await expect(row(page, "stopped")).toContainText("callback handler");

  // a second click on it is not a toggle, and a click on another row swaps the session
  await row(page, "turn").click();
  await expect(panel(page)).toHaveAttribute("data-id", SID.turn);
  await row(page, "stopped").click();
  await expect(panel(page)).toHaveAttribute("data-id", SID.stopped);
  await expect(openRow(page)).toHaveCount(1);
  await expect(openRow(page)).toHaveAttribute("data-kind", "stopped");
  // one grove cannot open says why on its button
  await row(page, "permission").click();
  await expect(panel(page).getByTestId("panel-open")).toBeDisabled();
  await expect(panel(page).getByTestId("panel-open")).toHaveAttribute(
    "title",
    "running in the background",
  );

  // no click opened the editor
  expect(code()).toHaveLength(0);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("panel")).toHaveCount(0);
  await expect(openRow(page)).toHaveCount(0);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
  await row(page, "turn").click();
  await page.getByTestId("panel-close").click();
  await expect(page.getByTestId("panel")).toHaveCount(0);
});

test("a double-click opens the row's session in the editor, once, wherever the panel lands under it", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  // a stop stays in the inbox when its session is opened, so it can be opened again and again
  const stopped = row(page, "stopped");

  // the middle of a row: the first click opens the panel, whose edge is then under the pointer
  await stopped.dblclick();
  await expect.poll(() => code().length).toBe(1);
  await expect(panel(page)).toHaveAttribute("data-id", SID.stopped);
  await expect(openRow(page)).toHaveAttribute("data-kind", "stopped");
  await expect(page.getByTestId("toast")).toHaveText(["Opening callback handler in VS Code"]);

  // the right of a closed list's row: the second click lands in the panel
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("panel")).toHaveCount(0);
  // on its second line: under the mouse the first line's right is the row's buttons
  const box = (await stopped.boundingBox()) as { x: number; y: number; width: number };
  const at = [box.x + box.width * 0.8, box.y + 40] as const;
  await page.mouse.dblclick(...at);
  await expect.poll(() => code().length).toBe(2);
  expect(
    await page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x, y)?.closest("[data-testid]")?.closest("section")?.dataset
          .testid,
      at,
    ),
  ).toBe("panel");
  // the second click was nobody's: the panel is still on that row, and on the inbox
  await expect(panel(page)).toHaveAttribute("data-id", SID.stopped);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");

  // with the panel open nothing moves, and it is still one open
  await stopped.dblclick();
  await expect.poll(() => code().length).toBe(3);
  await expect(rows(page)).toHaveCount(4);

  // two clicks on a row's button are that button's, twice: no third open for the row
  await under(stopped, () => stopped.getByTestId("inbox-open").dblclick({ timeout: 2_000 }));
  await expect.poll(() => code().length).toBe(5);
  // a double-click in the panel is the panel's: it selects a word
  await panel(page).getByTestId("panel-prompt").dblclick();
  // an agent grove cannot open: the double-click says why, like the key does
  await row(page, "permission").dblclick({ position: { x: 200, y: 12 } });
  await expect(
    page.getByTestId("toast").filter({ hasText: "running in the background" }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  expect(code()).toHaveLength(5);

  // opening a session that waited on him is looking at it: its row leaves, and the panel moves on
  const order = await rows(page).evaluateAll((els) => els.map((e) => e.id));
  const was = order.indexOf((await row(page, "turn").getAttribute("id")) as string);
  await row(page, "turn").dblclick({ position: { x: 200, y: 12 } });
  await expect.poll(() => code().length).toBe(6);
  await expect(row(page, "turn")).toHaveCount(0);
  await expect(openRow(page)).toHaveAttribute("id", order[was + 1] as string);
});

test("the panel's own buttons: Dismiss hands it to the row that took the place, and the last row closes it", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);

  const order = await rows(page).evaluateAll((els) => els.map((e) => e.id));
  await rows(page).nth(1).click();
  await expect(openRow(page)).toHaveAttribute("id", order[1] as string);
  await panel(page).getByTestId("panel-dismiss").click();
  await ready(page, 3);
  await expect(openRow(page)).toHaveAttribute("id", order[2] as string);
  await expect(panel(page)).toHaveAttribute(
    "data-id",
    (await openRow(page).getAttribute("data-id")) as string,
  );

  // the panel's Open is the editor
  await row(page, "stopped").click();
  await panel(page).getByTestId("panel-open").click();
  await expect.poll(() => code().length).toBe(1);

  // the last rows go: the panel closes with the list, and a new row does not open it again
  for (const _ of [1, 2, 3]) await panel(page).getByTestId("panel-dismiss").click();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();
  await expect(page.getByTestId("panel")).toHaveCount(0);
  hookEvent(fx, SID.quiet, "Stop", { last_assistant_message: "Merged. Anything else?" });
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("chat-features-35");
  await expect(page.getByTestId("panel")).toHaveCount(0);
});

test("the keyboard: arrows move, cmd-D dismisses, cmd-Enter opens the editor, Enter opens the panel", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  const active = page.locator('[data-testid="inbox-row"][data-active]');
  const order = await rows(page).evaluateAll((els) => els.map((e) => e.id));
  // the rows came after the screen did, and the list took the keyboard then. no row shows it yet
  await expect(page.getByRole("listbox")).toBeFocused();
  await expect(active).toHaveCount(0);

  const press = async (...keys: string[]) => {
    for (const k of keys) await page.keyboard.press(k);
  };
  const at = (id: string) => expect(active).toHaveAttribute("id", id, { timeout: 2_000 });
  // an arrow while no row shows only shows the keyboard's row. it never moves it, so a step can
  // start with it however often it runs
  const show = async () => {
    if ((await active.count()) === 0) await page.keyboard.press("ArrowDown");
  };

  // the first key only shows where the keyboard is, an arrow as much as Enter
  await step(async () => {
    await show();
    await at(order[0]!);
  });
  await expect(page.getByRole("listbox")).toHaveAttribute("aria-activedescendant", order[0]!);
  await step(async () => {
    await press("Meta+ArrowUp", "ArrowDown", "ArrowDown");
    await at(order[2]!);
  });

  // the row that takes a dismissed row's place is the keyboard's next
  await step(async () => {
    if ((await rows(page).count()) === 4) {
      await press("Meta+ArrowUp", "ArrowDown", "ArrowDown", "Meta+d");
    }
    await expect(rows(page)).toHaveCount(3, { timeout: 3_000 });
    await show();
    await at(order[3]!);
  });

  // the last row is the stop: cmd-Enter opens it, and it stays
  const opened = () => code().length;
  await step(async () => {
    if (opened() === 0) await press("Meta+ArrowDown", "Meta+Enter");
    await expect.poll(opened, { timeout: 3_000 }).toBe(1);
  });

  // the arrows alone never open the panel. Enter does, on the keyboard's row, and the list stays
  await expect(page.getByTestId("panel")).toHaveCount(0);
  await step(async () => {
    await press("Meta+ArrowDown", "Enter");
    await expect(panel(page)).toHaveAttribute("data-id", SID.stopped, { timeout: 2_000 });
  });
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
  await expect(page.getByRole("listbox")).toBeFocused();
  expect(opened()).toBe(1);

  // while it is open it goes where the arrows go, from its own row whatever the mouse did since
  const left = await rows(page).evaluateAll((els) => els.map((e) => e.id));
  await step(async () => {
    await press("Meta+ArrowUp", "ArrowDown");
    await expect(openRow(page)).toHaveAttribute("id", left[1] as string, { timeout: 2_000 });
  });
  await expect(panel(page)).toHaveAttribute(
    "data-id",
    (await openRow(page).getAttribute("data-id")) as string,
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("panel")).toHaveCount(0);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
});

test("a notification click lands on the session with its panel open, wherever its row is", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  const g = groveTest(app.app);

  // from another screen, onto its inbox row: the row is the keyboard's and its panel is open
  await projectItem(page, "billing-export").click();
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "sessions");
  await g.reveal(SID.turn);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");
  await expect(panel(page)).toHaveAttribute("data-id", SID.turn);
  await expect(openRow(page)).toHaveAttribute("data-kind", "turn");
  await expect(row(page, "turn")).toHaveAttribute("data-active", "true");
  // looking is not dismissing
  await expect(rows(page)).toHaveCount(4);

  // one that needs nothing any more has no inbox row: its row in its project's sessions
  await g.reveal(SID.quiet);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "sessions");
  await expect(page.getByTestId("project-name")).toHaveText("auth-sso");
  await expect(panel(page)).toHaveAttribute("data-id", SID.quiet);
  await expect(page.locator('[data-testid="session-row"][data-open]')).toHaveAttribute(
    "data-id",
    SID.quiet,
  );
  expect(code()).toHaveLength(0);

  // a session in no project has no screen in grove: it opens in the editor
  await g.reveal(SID.loose);
  await expect.poll(() => code().length).toBe(1);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "sessions");
});
