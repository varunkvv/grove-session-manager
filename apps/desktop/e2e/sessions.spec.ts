import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  type Fixture,
  hookEvent,
  makeFixture,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { groveTest, type LaunchedApp, launchApp, step } from "./helpers/launchApp.ts";
import { interrupted, liveSession, writeProject } from "./helpers/project.ts";

const sid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const SID = {
  turn: sid(1),
  permission: sid(2),
  stopped: sid(3),
  working: sid(4),
  /** started in a working copy, and running */
  insideRuns: sid(5),
  /** a scripted run under artifacts/, long finished */
  insideDone: sid(6),
};
/** forty quiet sessions, `QUIET` to `QUIET + 39`, newest first */
const QUIET = 100;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** how long ago quiet session i last moved: five in the last minutes, ten a day back, the rest older */
const age = (i: number) =>
  i < 5 ? (i + 2) * MIN : i < 15 ? (20 + i) * HOUR : (i - 10) * 30 * HOUR;
/** midnight, this many days back, by the calendar */
const midnight = (back: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
};
/** the group quiet session i is in. the days are the machine's own, so they are worked out as the app does */
const day = (i: number) => {
  const back = [0, 1, 2, 3].findIndex((n) => Date.now() - age(i) >= midnight(n));
  return ["today", "yesterday", "day-2", "day-3"][back] ?? "older";
};
const QUIETS = Array.from({ length: 40 }, (_, i) => i);

let fx: Fixture;
let app: LaunchedApp;
let root: string;

test.afterEach(async () => {
  await app?.close();
});

/**
 * auth-sso with 45 sessions to list: three that need him, two working (one of them in a working
 * copy), forty quiet ones over today, the days before and the weeks before those, which are folded
 * into Older. a finished one in a subfolder is not its to list. billing-export has none
 */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  root = writeProject(fx, { name: "auth-sso", goal: "SSO for the dashboard" }).root;
  writeProject(fx, { name: "billing-export", goal: "Invoice exports" });
  for (let i = 0; i < 40; i++) {
    writeSession(fx, {
      cwd: root,
      sessionId: sid(QUIET + i),
      title: `session ${i}`,
      prompt: i === 7 ? "rotate the okta keys" : `what session ${i} was asked`,
      reply: `what session ${i} said`,
      ...(i === 9 ? { branch: "fix/okta-callback" } : {}),
      ageMs: age(i),
    });
  }
  writeSession(fx, {
    cwd: root,
    sessionId: SID.turn,
    title: "okta app",
    branch: "feat/okta-staging",
    prompt: "register the app",
    reply: "Registered. Open the PR now?",
  });
  liveSession(fx, { sessionId: SID.turn, kind: "interactive", entrypoint: "claude-vscode" });
  hookEvent(fx, SID.turn, "Stop", { last_assistant_message: "Registered. Open the PR now?" });
  writeSession(fx, { cwd: root, sessionId: SID.permission, title: "callback route" });
  hookEvent(fx, SID.permission, "PermissionRequest", { tool_name: "Bash" });
  writeSession(fx, { cwd: root, sessionId: SID.stopped, title: "session store" });
  interrupted(fx, { [SID.stopped]: Date.now() - 10 * MIN });
  writeSession(fx, {
    cwd: root,
    sessionId: SID.working,
    title: "login page",
    lastPrompt: "wire the login form\nto the new endpoint",
  });
  liveSession(fx, {
    sessionId: SID.working,
    kind: "interactive",
    entrypoint: "cli",
    status: "busy",
  });
  // its turn started twelve minutes ago
  hookEvent(fx, SID.working, "UserPromptSubmit", {}, 12 * MIN + 5_000);

  for (const dir of ["api", "artifacts"]) mkdirSync(path.join(root, dir));
  writeSession(fx, { cwd: path.join(root, "api"), sessionId: SID.insideRuns, title: "api tests" });
  // a session with no process is not running, whatever its last hook said: it would be Stopped
  liveSession(fx, { sessionId: SID.insideRuns, kind: "interactive", entrypoint: "claude-vscode" });
  hookEvent(fx, SID.insideRuns, "UserPromptSubmit");
  writeSession(fx, {
    cwd: path.join(root, "artifacts"),
    sessionId: SID.insideDone,
    title: "scripted run",
  });
  return fx;
}

const rows = (page: Page) => page.getByTestId("session-row");
const row = (page: Page, id: string) =>
  page.locator(`[data-testid="session-row"][data-id="${id}"]`);
const group = (page: Page, key: string) =>
  page.locator(`[data-testid="session-group"][data-group="${key}"]`);
const openRow = (page: Page) => page.locator('[data-testid="session-row"][data-open]');
const panel = (page: Page) => page.getByTestId("session-panel");
const filter = (page: Page) => page.getByTestId("session-filter");
const older = (page: Page) => page.getByTestId("older-toggle");
/** the rows that are drawn while Older is closed */
const DRAWN = 5 + QUIETS.filter((i) => day(i) !== "older").length;
const projectItem = (page: Page, id: string) =>
  page.locator(`[data-testid="project-item"][data-id="${id}"]`);
const code = () => readExecLog(fx).filter((l) => l.bin === "code");

/** the project's screen, with every session indexed, and Older opened: all 45 are drawn */
async function open(page: Page): Promise<void> {
  await projectItem(page, "auth-sso").click();
  await expect(rows(page)).toHaveCount(DRAWN, { timeout: 20_000 });
  await expect(older(page)).toContainText(`Older${45 - DRAWN}`);
  await older(page).click();
  await expect(rows(page)).toHaveCount(45);
}

test("a project's screen is every one of its sessions: the ones that need him, the working, then the rest by day, and Older folded away", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await projectItem(page, "auth-sso").click();
  await expect(rows(page)).toHaveCount(DRAWN, { timeout: 20_000 });

  // the project is marked in the sidebar, with how many of its sessions need him
  await expect(projectItem(page, "auth-sso")).toHaveAttribute("aria-current", "page");
  await expect(projectItem(page, "auth-sso").getByTestId("count")).toHaveText("3");
  await expect(page.getByTestId("project-name")).toHaveText("auth-sso");
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "sessions");

  // the groups, in order: today, yesterday, the two days before by their weekday, then Older
  const all = QUIETS.map(day);
  const days = ["today", "yesterday", "day-2", "day-3", "older"].filter((d) => all.includes(d));
  const drawnIn = (d: string) =>
    group(page, d)
      .getByTestId("session-row")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
  expect(
    await page
      .getByTestId("session-group")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group)),
  ).toEqual(["needs", "working", ...days]);
  await expect(group(page, "needs").getByTestId("session-row")).toHaveCount(3);
  await expect(group(page, "needs")).toContainText("Needs you3");
  await expect(group(page, "working").getByTestId("session-row")).toHaveCount(2);
  for (const d of days.filter((x) => x !== "older")) {
    // newest first inside each
    expect(await drawnIn(d), d).toEqual(
      QUIETS.filter((i) => day(i) === d).map((i) => sid(QUIET + i)),
    );
  }
  for (const [d, back] of [
    ["day-2", 2],
    ["day-3", 3],
  ] as const) {
    if (!days.includes(d)) continue;
    const name = new Date(midnight(back)).toLocaleDateString("en-US", { weekday: "long" });
    await expect(group(page, d)).toContainText(name);
  }

  // Older says how many it holds and draws none of them until its header is pressed
  const old = QUIETS.filter((i) => day(i) === "older");
  await expect(older(page)).toHaveAttribute("aria-expanded", "false");
  await expect(older(page)).toHaveText(`Older${old.length}`);
  expect(await drawnIn("older")).toEqual([]);
  await older(page).click();
  await expect(older(page)).toHaveAttribute("aria-expanded", "true");
  expect(await drawnIn("older")).toEqual(old.map((i) => sid(QUIET + i)));
  await expect(rows(page)).toHaveCount(45);
  // the click left the keyboard with the list
  await expect(page.getByRole("listbox")).toBeFocused();

  // one started in a working copy is here while it runs. a finished one in a subfolder is the palette's
  await expect(row(page, SID.insideRuns)).toHaveAttribute("data-state", "working");
  await expect(row(page, SID.insideDone)).toHaveCount(0);
  // every row of the inbox for this project is in its list
  const inbox = (await page.evaluate(() => window.grove.bootstrap())).inbox.rows;
  expect(inbox.map((r) => r.project)).toEqual(["auth-sso", "auth-sso", "auth-sso"]);
  for (const r of inbox) await expect(row(page, r.sessionId)).toHaveAttribute("data-state", r.kind);

  // a row: what it is at, the branch when it has one, where it runs, when
  const turn = row(page, SID.turn);
  await expect(turn).toContainText("okta app");
  await expect(turn.getByTestId("state")).toHaveText("Your turn");
  await expect(turn).toContainText("feat/okta-staging");
  await expect(turn.getByTestId("runtime-chip")).toHaveText("VS Code");
  await expect(row(page, SID.permission).getByTestId("state")).toHaveText("Needs permission");
  await expect(row(page, SID.stopped).getByTestId("state")).toHaveText("Stopped");
  await expect(row(page, SID.working).getByTestId("state")).toHaveText("Working");
  await expect(row(page, SID.working).getByTestId("runtime-chip")).toHaveText("Terminal");
  // a working one has a second line, what it was last asked, and says how long its turn has run
  await expect(row(page, SID.working).getByTestId("session-doing")).toHaveText(
    "wire the login form to the new endpoint",
  );
  await expect(row(page, SID.working)).toContainText(/for 1[23]m/);
  // a quiet one says nothing, on one line
  const quiet = row(page, sid(QUIET));
  await expect(quiet).toContainText("session 0");
  await expect(quiet.getByTestId("state")).toHaveCount(0);
  await expect(quiet.getByTestId("session-doing")).toHaveCount(0);
  await expect(quiet.getByTestId("runtime-chip")).toHaveText("Closed");
  await expect(row(page, SID.turn).getByTestId("session-doing")).toHaveCount(0);

  // the last of 45 is a scroll away
  const last = row(page, sid(QUIET + 39));
  await expect(last).not.toBeInViewport();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toContainText("session 39");

  // Older closes again from its header, and every time the screen comes up
  await older(page).click();
  await expect(rows(page)).toHaveCount(DRAWN);
  await older(page).click();
  await expect(rows(page)).toHaveCount(45);

  // the other project has none: one line, and how to start one
  await projectItem(page, "billing-export").click();
  await expect(page.getByTestId("sessions-empty")).toContainText("No sessions yet.");
  await expect(rows(page)).toHaveCount(0);
  await projectItem(page, "auth-sso").click();
  await expect(older(page)).toHaveAttribute("aria-expanded", "false");
  await expect(rows(page)).toHaveCount(DRAWN);
});

test("the filter narrows the rows by title, prompt and branch, cmd-F focuses it, and the arrows drive the list from it", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await open(page);

  await page.keyboard.press("Meta+f");
  await expect(filter(page)).toBeFocused();
  // a word in the title, in what was asked, in the branch: in the list's own order
  await page.keyboard.type("OKTA");
  await expect(rows(page)).toHaveCount(3);
  expect(
    await rows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id)),
  ).toEqual([SID.turn, sid(QUIET + 7), sid(QUIET + 9)]);
  // groups with nothing left in them are gone
  await expect(group(page, "working")).toHaveCount(0);
  // every word has to be there
  await filter(page).fill("okta keys");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("session 7");
  await filter(page).fill("nothing like it");
  await expect(page.getByTestId("sessions-none")).toHaveText("No sessions match.");

  // from the field the arrows and Enter are the list's, and the field keeps the typing
  await filter(page).fill("okta");
  await expect(rows(page)).toHaveCount(3);
  await step(async () => {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('[data-testid="session-row"][data-active]')).toHaveCount(1, {
      timeout: 2_000,
    });
  });
  await step(async () => {
    await page.keyboard.press("Meta+ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(panel(page)).toHaveAttribute("data-id", sid(QUIET + 7), { timeout: 2_000 });
  });
  await expect(filter(page)).toBeFocused();
  await expect(filter(page)).toHaveValue("okta");

  // typing never sends the panel to another session: it stays while its row is there, and goes with it
  await page.keyboard.type(" keys");
  await expect(rows(page)).toHaveCount(1);
  await expect(panel(page)).toHaveAttribute("data-id", sid(QUIET + 7));
  await filter(page).fill("okta app");
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId("panel")).toHaveCount(0);

  // Escape, one step at a time: the panel, then what was typed
  await rows(page).first().click();
  await expect(panel(page)).toHaveAttribute("data-id", SID.turn);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("panel")).toHaveCount(0);
  await expect(filter(page)).toHaveValue("okta app");
  await page.keyboard.press("Escape");
  await expect(filter(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(45);

  // another project starts with an empty filter
  await filter(page).fill("okta");
  await projectItem(page, "billing-export").click();
  await projectItem(page, "auth-sso").click();
  await expect(filter(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(DRAWN);
});

test("a click opens a session in the panel, a double-click in the editor, and Dismiss leaves it in the list", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await open(page);

  // a quiet one: what he asked and what it said, and nothing to dismiss
  await row(page, sid(QUIET + 2)).click();
  await expect(panel(page)).toHaveAttribute("data-id", sid(QUIET + 2));
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("session 2");
  await expect(panel(page).getByTestId("panel-prompt")).toHaveText("what session 2 was asked");
  await expect(panel(page).getByTestId("panel-text")).toHaveText("what session 2 said");
  await expect(panel(page).getByTestId("state")).toHaveCount(0);
  await expect(panel(page).getByTestId("panel-dismiss")).toHaveCount(0);
  await expect(panel(page).getByTestId("panel-meta")).toContainText("auth-sso");
  // the list is still there, narrower: the branch and where it runs give way to the title
  await expect(rows(page)).toHaveCount(45);
  await expect(openRow(page)).toHaveAttribute("data-id", sid(QUIET + 2));
  await expect(row(page, SID.turn).getByTestId("runtime-chip")).toBeHidden();
  await expect(row(page, SID.turn).getByTestId("state")).toBeVisible();
  await expect(row(page, SID.turn).getByTestId("state").getByText("Your turn")).toBeHidden();
  await expect(page.getByRole("listbox")).toBeFocused();
  expect(code()).toHaveLength(0);

  // one that needs him: the same panel, with its state and Dismiss
  await row(page, SID.turn).click();
  await expect(panel(page)).toHaveAttribute("data-id", SID.turn);
  await expect(panel(page).getByTestId("state")).toHaveAttribute("data-state", "turn");
  await expect(panel(page).getByTestId("panel-text")).toHaveText("Registered. Open the PR now?");
  await panel(page).getByTestId("panel-dismiss").click();
  // it leaves Needs you and the inbox, not the list, and the panel stays on it
  await expect(group(page, "needs").getByTestId("session-row")).toHaveCount(2);
  await expect(row(page, SID.turn)).not.toHaveAttribute("data-state");
  await expect(rows(page)).toHaveCount(45);
  await expect(panel(page)).toHaveAttribute("data-id", SID.turn);
  await expect(panel(page).getByTestId("panel-dismiss")).toHaveCount(0);
  await expect(projectItem(page, "auth-sso").getByTestId("count")).toHaveText("2");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("panel")).toHaveCount(0);

  // a double-click is the editor, once, and so is cmd-Enter on the keyboard's row. the middle of
  // the row on purpose: with 45 rows the panel opens with the list's scrollbar right there, and a
  // press on a scrollbar is followed by no click and no dblclick
  await row(page, sid(QUIET + 1)).dblclick();
  await expect.poll(() => code().length).toBe(1);
  await expect(
    page.getByTestId("toast").filter({ hasText: "Opening session 1 in VS Code" }),
  ).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-id", sid(QUIET + 1));
  await step(async () => {
    if (code().length === 1) {
      await page.keyboard.press("Meta+ArrowUp");
      await page.keyboard.press("Meta+Enter");
    }
    await expect.poll(() => code().length, { timeout: 3_000 }).toBe(2);
  });
  // the panel's own button
  await panel(page).getByTestId("panel-open").click();
  await expect.poll(() => code().length).toBe(3);
});

test("the list is live: a session that starts working, then needs him, and a new one, without a refresh", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await open(page);
  const quiet = row(page, sid(QUIET + 3));
  await expect(quiet).not.toHaveAttribute("data-state");

  // someone opens it and sends a prompt
  liveSession(fx, {
    sessionId: sid(QUIET + 3),
    kind: "interactive",
    entrypoint: "claude-vscode",
  });
  hookEvent(fx, sid(QUIET + 3), "UserPromptSubmit");
  await expect(quiet).toHaveAttribute("data-state", "working");
  await expect(quiet.getByTestId("runtime-chip")).toHaveText("VS Code");
  await expect(group(page, "working").getByTestId("session-row")).toHaveCount(3);

  hookEvent(fx, sid(QUIET + 3), "Stop", { last_assistant_message: "Done. Ship it?" });
  await expect(quiet).toHaveAttribute("data-state", "turn");
  // newest first in Needs you, and the sidebar counts it
  await expect(group(page, "needs").getByTestId("session-row").first()).toHaveAttribute(
    "data-id",
    sid(QUIET + 3),
  );
  await expect(projectItem(page, "auth-sso").getByTestId("count")).toHaveText("4");
  await expect(page.getByTestId("nav-inbox").getByTestId("count")).toHaveText("4");

  // a session someone starts in the project's folder
  writeSession(fx, { cwd: root, sessionId: sid(900), title: "brand new", ageMs: 0 });
  await expect(row(page, sid(900))).toContainText("brand new", { timeout: 20_000 });
  await expect(rows(page)).toHaveCount(46);
});

test("Dismiss on a session that stopped days ago leaves the panel on it, down in Older", async () => {
  fx = makeFixture({ withCompanion: true });
  root = writeProject(fx, { name: "auth-sso" }).root;
  const old = sid(7);
  // five days back: a stop is kept for seven, and what last moved that long ago is in Older
  writeSession(fx, { cwd: root, sessionId: old, title: "session store", ageMs: 5 * 24 * HOUR });
  interrupted(fx, { [old]: Date.now() - 5 * 24 * HOUR });
  writeSession(fx, { cwd: root, sessionId: sid(8), title: "okta app" });
  app = await launchApp(fx);
  const { page } = app;
  await projectItem(page, "auth-sso").click();
  await expect(row(page, old)).toHaveAttribute("data-state", "stopped", { timeout: 20_000 });

  await row(page, old).click();
  await panel(page).getByTestId("panel-dismiss").click();
  // it is an old session like any other now, and the panel is still on it: Older shows for it
  await expect(group(page, "needs")).toHaveCount(0);
  await expect(panel(page)).toHaveAttribute("data-id", old);
  await expect(group(page, "older").getByTestId("session-row")).toHaveAttribute("data-id", old);
  await expect(openRow(page)).toHaveAttribute("data-id", old);
  // closing Older takes the panel with it, and nothing is open on a row nobody sees
  await older(page).click();
  await expect(page.getByTestId("panel")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
});

test("a landing on a session far down its project's list opens its panel and brings its row into view", async () => {
  app = await launchApp(seed());
  const { page } = app;
  const oldest = sid(QUIET + 39);
  // main has to know the session before it can say where it is
  await page.waitForFunction(
    async () => (await window.grove.listSessions("auth-sso")).length === 45,
    undefined,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");

  await groveTest(app.app).reveal(oldest);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "sessions");
  await expect(page.getByTestId("project-name")).toHaveText("auth-sso");
  await expect(panel(page)).toHaveAttribute("data-id", oldest);
  await expect(panel(page).getByTestId("panel-text")).toHaveText("what session 39 said");
  // it is five weeks old: Older shows as far as its row, since the panel is on it
  await expect(older(page)).toHaveAttribute("aria-expanded", "true");
  await expect(openRow(page)).toHaveAttribute("data-id", oldest);
  await expect(openRow(page)).toBeInViewport();
  expect(code()).toHaveLength(0);
});
