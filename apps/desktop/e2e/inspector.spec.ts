import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { paneLayout } from "../src/renderer/logic/inspector.ts";
import { agentFile, appendCalls, FANOUT, writeDerive, writeFanOut } from "./helpers/agents.ts";
import {
  type Fixture,
  hookEvent,
  makeFixture,
  makePlainDir,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";

const OUT = path.join(import.meta.dirname, "screenshots");

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/** the frame in both appearances, so both get looked at */
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

function setup(): { cwd: string } {
  fx = makeFixture({ withCompanion: true });
  const cwd = makePlainDir(fx, "platform");
  writeFanOut(fx, cwd);
  writeSession(fx, {
    cwd,
    sessionId: "dddddddd-0000-4000-8000-00000000000d",
    title: "Onboarding copy changes",
    prompt: "soften the copy on the onboarding panel",
    ageMs: 3 * 3_600_000,
  });
  return { cwd };
}

test("the inspector shows what a session's agents did, and follows the selection", async () => {
  setup();
  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 2);
  // live, so the two agents still writing count as running
  hookEvent(fx, FANOUT.session, "UserPromptSubmit", { prompt: "go" });
  await expect(rows.first().getByTestId("live-badge")).toHaveAttribute("data-state", "running");

  // cmd-I opens the pane on the session's conversation. its agents are one segment away
  await page.keyboard.press("Meta+i");
  const pane = page.getByTestId("inspector");
  await expect(pane).toBeVisible();
  await expect(pane.getByTestId("inspector-title")).toHaveText(
    "Database CPU spike during the nightly job",
  );
  await expect(pane).toHaveAttribute("data-view", "conversation");
  await expect(pane.getByTestId("view-agents")).toHaveText("Agents 5");
  await pane.getByTestId("view-agents").click();
  await expect(pane).toHaveAttribute("data-view", "agents");
  await expect(pane.getByTestId("agent-row")).toHaveCount(5);
  await expect(pane.getByTestId("fan-bar")).toHaveCount(5);
  // the numbers come from each agent's own transcript, a moment after the scan draws the rows
  await expect(pane.getByTestId("inspector-summary")).toContainText("2 running · 3 done");
  await expect(pane.getByTestId("inspector-summary")).toContainText("tokens");
  const guide = pane.getByTestId("agent-row").filter({ hasText: "pg_stat_statements" });
  await expect(guide.getByTestId("agent-line")).toContainText("API Error: Connection refused");
  await expect(pane.locator('[data-testid="fan-bar"][data-tone="error"]')).toHaveCount(1);
  await expect(pane.locator('[data-testid="fan-bar"][data-tone="running"]')).toHaveCount(2);
  const survey = pane.getByTestId("agent-row").filter({ hasText: "Survey the nightly job" });
  await expect(survey).toContainText("Explore · 7 tools");
  await expect(survey.getByTestId("agent-line")).toContainText("The job runs 14 queries");

  // every agent says how it stands, in words where its time is. an error is the one colour
  const state = (text: string) =>
    pane.getByTestId("agent-row").filter({ hasText: text }).getByTestId("agent-state");
  await expect(state("Survey the nightly job")).toHaveText(/^Done \d+m$/);
  await expect(state("Survey the nightly job")).toHaveAttribute("data-status", "done");
  await expect(state("pg_stat_statements")).toHaveText(/^Failed \d+(s|m)$/);
  await expect(state("pg_stat_statements")).toHaveAttribute("data-status", "failed");
  await expect(state("Reproduce the spike")).toHaveText(/^Running \d+m$/);
  await expect(state("Plan the index change")).toHaveAttribute("data-status", "running");

  // the session itself is the root, its agents under it on one rail, and its own lane tops the
  // fan-out with a hairline between it and theirs
  const main = pane.getByTestId("main-row");
  await expect(main).toContainText("Main conversation");
  await expect(main).toContainText("main · opus 5 · 0 tools");
  await expect(main).toHaveAttribute("data-state", "running");
  await expect(main.getByTestId("agent-state")).toHaveText(/^Running \d+s$/);
  await expect(pane.getByTestId("fan-main")).toHaveAttribute("data-running", "true");
  await expect(pane.getByTestId("fan-main-gap")).toHaveCount(1);
  await expect(pane.getByTestId("tree-rail")).toHaveCount(5);
  const mainBox = await main.boundingBox();
  const surveyBox = await survey.boundingBox();
  expect((surveyBox?.x ?? 0) - (mainBox?.x ?? 0)).toBe(18);
  // one rail from under the root to the last row, never past its text
  const rails = await pane
    .getByTestId("tree-rail")
    .evaluateAll((els) =>
      els
        .map((el) => el.getBoundingClientRect())
        .map((r) => ({ x: r.x, top: r.top, bottom: r.bottom })),
    );
  expect(new Set(rails.map((r) => r.x)).size).toBe(1);
  expect(rails[0]?.top).toBeCloseTo(mainBox ? mainBox.y + mainBox.height : 0, 0);
  for (let i = 1; i < rails.length; i++)
    expect(rails[i]?.top).toBeCloseTo(rails[i - 1]?.bottom ?? 0, 0);
  const lastBox = await pane.getByTestId("agent-row").last().boundingBox();
  expect(rails.at(-1)?.bottom).toBeCloseTo(lastBox ? lastBox.y + lastBox.height - 8 : 0, 0);
  await shot(page, "19-inspector");

  // Tab goes into it and the arrows move there, not in the list of sessions
  await page.keyboard.press("Tab");
  await expect(main).toHaveAttribute("data-active", "true");
  await page.keyboard.press("ArrowDown");
  await expect(pane.locator('[data-testid="agent-row"][data-active]')).toContainText(
    "Survey the nightly job",
  );
  await page.keyboard.press("ArrowDown");
  await expect(pane.locator('[data-testid="agent-row"][data-active]')).toContainText(
    "Find what changed",
  );
  await expect(rows.first()).toHaveAttribute("data-active", "true");
  // Escape steps back out to the list, and the next one closes the pane
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search")).toBeFocused();
  await expect(pane).toBeVisible();

  // it follows the selected row, like a reading pane. a session with no agents has only its
  // conversation to show, and the pane shows that without being asked
  await page.keyboard.press("ArrowDown");
  await expect(pane.getByTestId("inspector-title")).toHaveText("Onboarding copy changes");
  await expect(pane.getByTestId("view-agents")).toHaveCount(0);
  await expect(pane.getByTestId("conversation")).toContainText(
    "soften the copy on the onboarding panel",
  );
  // back on a session with agents, the arrows kept the view - and the list's keyboard row is
  // this session's own again, not the one it had before the arrows left
  await page.keyboard.press("ArrowUp");
  await expect(pane.getByTestId("agent-row")).toHaveCount(5);
  await expect(pane.locator('[data-testid="agent-row"][data-active]')).toHaveCount(0);
  // the session's own row goes to its conversation
  await main.click();
  await expect(pane).toHaveAttribute("data-view", "conversation");
  await pane.getByTestId("view-agents").click();
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
});

test("the chip and the action menu open it too, and a narrow window gets it over the list", async () => {
  setup();
  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 2);
  hookEvent(fx, FANOUT.session, "UserPromptSubmit", { prompt: "go" });

  // the menu says which key does the same thing
  await rows.first().click({ button: "right" });
  await expect(page.getByTestId("action-inspect")).toContainText("⌘I");
  await page.getByTestId("action-inspect").click();
  const pane = page.getByTestId("inspector");
  await expect(pane).toBeVisible();
  await page.getByTestId("inspector-close").click();
  await expect(pane).toHaveCount(0);

  // clicking the agents chip is the same as asking for the inspector, not opening the session
  await rows.first().getByTestId("row-agents").click();
  await expect(pane).toBeVisible();
  await expect(page.getByTestId("session-menu")).toHaveCount(0);

  // beside the list when there is room. a CI runner's display can be narrower than the window asks
  // for, and then the overlay is the right answer - so the layout is held to the rule at the width
  // the window really got. paneLayout's thresholds have their own unit tests
  await app.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1400, 900);
  });
  await expect
    .poll(async () => {
      const available = await pane.evaluate((el) => el.parentElement?.clientWidth ?? 0);
      return (await pane.getAttribute("data-layout")) === paneLayout(available).mode;
    })
    .toBe(true);

  // too narrow for both side by side: it covers the list from the right instead of crushing it
  await app.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1000, 760);
  });
  await expect(pane).toHaveAttribute("data-layout", "overlay");
  await expect(pane.getByTestId("agent-row")).toHaveCount(5);
  await shot(page, "19-inspector-narrow");
});

test("an agent's detail: the result first, then every step, and a step opened in place", async () => {
  const { cwd } = setup();
  writeDerive(fx, cwd);
  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 3);
  // links out of an agent's output go to the browser through main, and nowhere else
  await app.app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });

  // rows land in the order the scan finds them, and the active one stays put: pick the session
  await rows.filter({ hasText: "Database CPU spike" }).getByTestId("row-agents").click();
  const pane = page.getByTestId("inspector");
  await pane.getByTestId("agent-row").filter({ hasText: "Survey the nightly job" }).click();
  const detail = pane.getByTestId("agent-detail");
  await expect(detail.getByTestId("agent-title")).toHaveText("Survey the nightly job's queries");
  await expect(detail.getByTestId("agent-meta")).toHaveText(
    /^Explore · sonnet 5 · 2m 31s · 7 tools · \d+k tokens$/,
  );
  const result = detail.getByTestId("agent-result");
  await expect(result.locator("table tr")).toHaveCount(3);
  // html in an agent's output is words on the page, never elements
  await expect(result).toContainText("<script>window.pwned = true</script>");
  await expect(result.locator("script, img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as { pwned?: boolean }).pwned)).toBeUndefined();
  await expect(detail.getByTestId("agent-asked")).toContainText(
    "List every query the nightly job runs",
  );
  await shot(page, "20-agent-detail");

  // the one step that failed says how, in the only colour on the page. opened, it shows why.
  const failed = detail.locator('[data-testid="step"][data-failed]');
  await expect(failed).toHaveCount(1);
  await expect(failed.getByTestId("step-error")).toHaveText("exit 2");
  await failed.click();
  // the same body a session's step has: the command, then what it printed
  await expect(failed.getByTestId("step-bash")).toContainText("$ psql");
  await expect(failed.getByTestId("step-stdout")).toContainText("connection to server on socket");
  await failed.getByTestId("step-raw").click();
  await expect(failed.getByTestId("step-body")).toContainText('"command"');
  await shot(page, "20-agent-step-error");

  // the result folds past a dozen lines. unfolded, its link opens in the browser, not here
  await result.getByTestId("fold-toggle").click();
  await result.getByRole("link", { name: "planner docs" }).click();
  await expect
    .poll(() => app.app.evaluate(() => (globalThis as { opened?: string[] }).opened))
    .toEqual(["https://www.postgresql.org/docs/current/using-explain.html"]);
  expect(page.url()).toMatch(/^app:\/\/renderer\//);

  await detail.getByTestId("copy-result").click();
  await expect
    .poll(() => app.app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain("The job runs 14 queries");

  // Escape goes back to the list first, keyboard and all, on the agent it came from
  await page.keyboard.press("Escape");
  await expect(pane.getByTestId("agent-detail")).toHaveCount(0);
  await expect(pane.getByTestId("agent-list")).toBeFocused();
  await expect(pane.locator('[data-testid="agent-row"][data-active]')).toContainText("Survey");
  await page.keyboard.press("Tab");
  await expect(pane.getByTestId("agent-list")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(pane.getByTestId("agent-title")).toHaveText("Survey the nightly job's queries");
  await expect(pane.getByTestId("agent-steps")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(pane.getByTestId("agent-list")).toBeFocused();
});

test("a workflow's agents sit under its name, and an agent's own agents are a click away", async () => {
  const { cwd } = setup();
  writeDerive(fx, cwd);
  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 3);
  await rows.filter({ hasText: "Derive BDS table names" }).getByTestId("row-agents").click();
  const pane = page.getByTestId("inspector");
  await expect(pane.getByTestId("inspector-title")).toHaveText(
    "Derive BDS table names instead of accepting them",
  );
  await expect(pane.getByTestId("workflow-header")).toHaveText("cdit-1249-derive-bds-table-name");
  await expect(pane.getByTestId("agent-row")).toHaveCount(5);
  // an agent's own agents sit one step further in than it, on the same rail. a workflow's name
  // sits in the tree like a day header, at its agents' depth
  const left = async (text: string) =>
    (await pane.getByTestId("agent-row").filter({ hasText: text }).boundingBox())?.x ?? 0;
  const parentX = await left("Derive BDS table names on create");
  expect((await left("Find every writer")) - parentX).toBe(18);
  expect((await left("You are implementing an approved plan")) - parentX).toBe(0);
  await expect(pane.locator('[data-depth="2"]')).toHaveCount(2);
  await expect(
    pane.locator('[data-depth="1"]').filter({ has: page.getByTestId("workflow-header") }),
  ).toHaveCount(1);
  await expect(pane.getByTestId("tree-rail")).toHaveCount(6);
  // nobody labelled a workflow's agents, so what they were asked stands in
  await expect(pane.getByTestId("agent-row").nth(3)).toContainText(
    "You are implementing an approved plan in the kirby repo.",
  );
  await shot(page, "20-agent-workflow");

  await pane
    .getByTestId("agent-row")
    .filter({ hasText: "Derive BDS table names on create" })
    .click();
  const calls = pane.getByTestId("step").filter({ hasText: "→" });
  await expect(calls).toHaveCount(2);
  await calls.first().click();
  await expect(pane.getByTestId("agent-title")).toHaveText(
    "Find every writer of big_query_table_name",
  );
  await expect(pane.getByTestId("agent-result")).toContainText(
    "Only kirby's own ORM path writes it.",
  );
  await pane.getByTestId("agent-back").click();
  await expect(pane.getByTestId("agent-list")).toBeVisible();
  await expect(rows.filter({ hasText: "Derive BDS" })).toHaveAttribute("data-active", "true");
});

test("a running agent's steps arrive as it writes them, and scrolling up pauses the tail", async () => {
  const { cwd } = setup();
  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 2);
  // live, so the agents still writing count as running
  hookEvent(fx, FANOUT.session, "UserPromptSubmit", { prompt: "go" });
  const row = rows.filter({ hasText: "Database CPU spike" });
  await expect(row.getByTestId("live-badge")).toHaveAttribute("data-state", "running");
  await row.getByTestId("row-agents").click();
  const pane = page.getByTestId("inspector");
  await pane.getByTestId("agent-row").filter({ hasText: "Reproduce the spike" }).click();
  await expect(pane.getByTestId("agent-now")).toBeVisible();
  await expect(pane.getByTestId("agent-meta")).toContainText("4 tools");

  // it writes: the new steps arrive without anyone asking, and the tail stays in view
  const file = agentFile(fx, cwd, FANOUT.session, FANOUT.replay);
  appendCalls(file, { agentId: FANOUT.replay, sessionId: FANOUT.session, cwd, from: 0, count: 30 });
  await expect(pane.getByTestId("agent-meta")).toContainText("34 tools");
  const steps = pane.getByTestId("agent-steps");
  await expect(
    steps.getByTestId("step").filter({ hasText: "src/tail/file-29.ts" }),
  ).toBeInViewport();
  await expect(pane.getByTestId("jump-live")).toHaveCount(0);

  // scrolled up, it stays where it was put and says how to get back
  await steps.hover();
  await page.mouse.wheel(0, -2000);
  await expect(pane.getByTestId("jump-live")).toBeVisible();
  appendCalls(file, { agentId: FANOUT.replay, sessionId: FANOUT.session, cwd, from: 30, count: 2 });
  await expect(pane.getByTestId("agent-meta")).toContainText("36 tools");
  await expect(
    steps.getByTestId("step").filter({ hasText: "src/tail/file-31.ts" }),
  ).not.toBeInViewport();
  await shot(page, "21-agent-live");

  await pane.getByTestId("jump-live").click();
  await expect(
    steps.getByTestId("step").filter({ hasText: "src/tail/file-31.ts" }),
  ).toBeInViewport();
  await expect(pane.getByTestId("jump-live")).toHaveCount(0);
});

test("the Agents scope is one tree per session, running first, and selecting a row opens it", async () => {
  const { cwd } = setup();
  writeDerive(fx, cwd);
  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 3);
  hookEvent(fx, FANOUT.session, "UserPromptSubmit", { prompt: "go" });
  await expect(
    rows.filter({ hasText: "Database CPU spike" }).getByTestId("live-badge"),
  ).toHaveAttribute("data-state", "running");

  await page.keyboard.press("Meta+3");
  await expect(page.getByTestId("scope-agents")).toHaveAttribute("aria-checked", "true");
  const agents = page.getByTestId("agent-list-row");
  // two sessions, each heading its own agents: 2 heads and 10 agents. the one without agents,
  // not running, is not here - the Sessions scope has it
  await expect(agents).toHaveCount(12);
  // what is working right now comes first: the session in the middle of a turn heads its tree,
  // its two agents still running under it, newest started first, then the ones that finished
  await expect(agents.nth(0)).toHaveAttribute("data-main", "true");
  await expect(agents.nth(0)).toContainText("Database CPU spike during the nightly job");
  await expect(agents.nth(0).getByTestId("agent-list-second")).toHaveText("main · platform");
  await expect(agents.nth(0).getByTestId("agent-state")).toHaveText(/^Running \d+s$/);
  await expect(agents.nth(1)).toHaveAttribute("data-state", "running");
  await expect(agents.nth(1)).toContainText("Plan the index change");
  await expect(agents.nth(1).getByTestId("agent-state")).toHaveText(/^Running \d+m$/);
  await expect(agents.nth(2)).toContainText("Reproduce the spike against a replica");
  await expect(agents.nth(3)).toHaveAttribute("data-state", "done");
  await expect(agents.nth(3).getByTestId("agent-state")).toHaveText(/^Done \d+(s|m)$/);
  // an agent's second line is its kind and what it is doing: its head already says whose it is
  await expect(agents.nth(1).getByTestId("agent-list-second")).toHaveText(/^Plan( · |$)/);
  await expect(agents.nth(1)).not.toContainText("Database CPU spike");
  // the finished session is one tree under its day, listed once
  await expect(agents.nth(6)).toHaveAttribute("data-main", "true");
  await expect(agents.nth(6)).toContainText("Derive BDS table names instead of accepting them");
  await expect(agents.nth(6)).toContainText("ago");
  await expect(
    agents.filter({ hasText: "Derive BDS table names instead of accepting them" }),
  ).toHaveCount(1);
  // a workflow's agent has no label: the scan reads the start of its prompt instead
  await expect(
    agents.filter({ hasText: "You are implementing an approved plan in the kirby repo." }),
  ).toHaveCount(1);
  // an agent sits a step in from its head, on the rail that runs down from under the head's title
  const list = page.getByTestId("session-scroller");
  await expect(list.getByTestId("tree-rail")).toHaveCount(10);
  const headBox = await agents.nth(0).boundingBox();
  const childBox = await agents.nth(1).boundingBox();
  expect((childBox?.x ?? 0) - (headBox?.x ?? 0)).toBe(18);
  // the count says agents, not rows
  await expect(page.getByTestId("result-count")).toHaveText("10 agents");

  // selecting a row opens the pane on it, and it follows the selection: a head is its session's
  // conversation
  const pane = page.getByTestId("inspector");
  await expect(pane).toHaveAttribute("data-view", "conversation");
  await expect(pane.getByTestId("conversation")).toContainText("the primary is pinned");
  // the whole list, with the pane out of the way
  await page.getByTestId("inspector-close").click();
  await expect(pane).toHaveCount(0);
  await shot(page, "22-agents-scope-list");
  await page.getByTestId("search").focus();
  await page.keyboard.press("ArrowDown");
  await expect(pane.getByTestId("agent-title")).toHaveText("Plan the index change");
  await expect(pane.getByTestId("inspector-title")).toHaveText(
    "Database CPU spike during the nightly job",
  );
  await page.keyboard.press("ArrowDown");
  await expect(pane.getByTestId("agent-title")).toHaveText("Reproduce the spike against a replica");
  await shot(page, "22-agents-scope");

  // Enter takes the keyboard into it
  await page.keyboard.press("Enter");
  await expect(pane.getByTestId("agent-steps")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("search")).toBeFocused();

  // the search narrows agents by what they were for, and by their session. a found agent keeps its
  // head, and the selection lands on the agent - the answer - not on the head
  await page.keyboard.type("writer");
  await expect(agents).toHaveCount(2);
  await expect(agents.nth(0)).toHaveAttribute("data-main", "true");
  await expect(agents.nth(1)).toContainText("Find every writer of big_query_table_name");
  await expect(agents.nth(1)).toHaveAttribute("data-active", "true");
  await expect(pane.getByTestId("agent-title")).toHaveText(
    "Find every writer of big_query_table_name",
  );
  await expect(pane.getByTestId("inspector-title")).toHaveText(
    "Derive BDS table names instead of accepting them",
  );

  // and cmd-2 is back to sessions, where rows are sessions again. Escape closes the pane first,
  // then clears the query
  await page.keyboard.press("Meta+2");
  await expect(page.getByTestId("agent-list-row")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(3);
});

test("search reaches what agents said, and opens the agent at the step that said it", async () => {
  setup();
  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 2);

  // only the survey agent said this, between two of its steps
  await page.keyboard.type("local database");
  const hit = rows.filter({ hasText: "Database CPU spike" });
  // what it said, from the start of its line, so the words that matched show
  await expect(hit.getByTestId("row-agent-hit")).toContainText(
    /^in Explore: …No local database\. Reading the plan from the replica instead\./,
  );
  await expect(rows).toHaveCount(1);

  await hit.getByTestId("row-agent-hit").click();
  const pane = page.getByTestId("inspector");
  await expect(pane.getByTestId("agent-title")).toHaveText("Survey the nightly job's queries");
  const landed = pane.getByTestId("agent-prose").filter({ hasText: "No local database" });
  await expect(landed).toBeInViewport();
  await expect(landed).toHaveAttribute("data-landed", "true");
  await shot(page, "23-agent-search");

  // a tool's output is other people's file contents: it is never what a session is found by
  await page.getByTestId("search").fill("918273");
  await expect(page.getByTestId("list-empty")).toBeVisible();

  // the Agents scope finds the agent itself under its session, and says what it said
  await page.keyboard.press("Meta+3");
  await page.getByTestId("search").fill("local database");
  const agents = page.getByTestId("agent-list-row");
  await expect(agents).toHaveCount(2);
  await expect(agents.nth(0)).toHaveAttribute("data-main", "true");
  await expect(agents.nth(1).getByTestId("agent-list-second")).toContainText("No local database");
  await expect(agents.nth(1)).toHaveAttribute("data-active", "true");
});

test("a finished agent someone looked at before keeps the line it was given, for nothing", async () => {
  const { cwd } = setup();
  // what an earlier look paid for: the line for the survey agent, as its transcript is now
  const file = agentFile(fx, cwd, FANOUT.session, FANOUT.survey);
  const info = statSync(file);
  mkdirSync(path.join(fx.root, ".grove"), { recursive: true });
  writeFileSync(
    path.join(fx.root, ".grove", "agent-lines.v1.json"),
    JSON.stringify({
      [`${FANOUT.survey}:${info.mtimeMs}:${info.size}`]:
        "found two changed queries, the events join has no index",
    }),
  );
  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 2);
  await rows.filter({ hasText: "Database CPU spike" }).getByTestId("row-agents").click();
  const survey = page
    .getByTestId("inspector")
    .getByTestId("agent-row")
    .filter({ hasText: "Survey the nightly job" });
  await expect(survey.getByTestId("agent-line")).toHaveText(
    "found two changed queries, the events join has no index",
  );
});
