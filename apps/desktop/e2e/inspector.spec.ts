import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FANOUT, writeFanOut } from "./helpers/agents.ts";
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

  await page.keyboard.press("Meta+i");
  const pane = page.getByTestId("inspector");
  await expect(pane).toBeVisible();
  await expect(pane.getByTestId("inspector-title")).toHaveText(
    "Database CPU spike during the nightly job",
  );
  await expect(pane.getByTestId("agent-row")).toHaveCount(5);
  await expect(pane.getByTestId("fan-bar")).toHaveCount(5);
  // the numbers come from each agent's own transcript, a moment after the scan draws the rows
  await expect(pane.getByTestId("inspector-summary")).toContainText("5 agents");
  await expect(pane.getByTestId("inspector-summary")).toContainText("tokens");
  const guide = pane.getByTestId("agent-row").filter({ hasText: "pg_stat_statements" });
  await expect(guide.getByTestId("agent-line")).toContainText("API Error: Connection refused");
  await expect(pane.locator('[data-testid="fan-bar"][data-tone="error"]')).toHaveCount(1);
  await expect(pane.locator('[data-testid="fan-bar"][data-tone="running"]')).toHaveCount(2);
  const survey = pane.getByTestId("agent-row").filter({ hasText: "Survey the nightly job" });
  await expect(survey).toContainText("Explore · 5 tools");
  await expect(survey.getByTestId("agent-line")).toContainText("The job runs 14 queries");
  await shot(page, "19-inspector");

  // Tab goes into it and the arrows move there, not in the list of sessions
  await page.keyboard.press("Tab");
  await expect(pane.locator('[data-testid="agent-row"][data-active]')).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(pane.locator('[data-testid="agent-row"][data-active]')).toContainText(
    "Find what changed",
  );
  await expect(rows.first()).toHaveAttribute("data-active", "true");
  // Escape steps back out to the list, and the next one closes the pane
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search")).toBeFocused();
  await expect(pane).toBeVisible();

  // it follows the selected row, like a reading pane
  await page.keyboard.press("ArrowDown");
  await expect(pane.getByTestId("inspector-title")).toHaveText("Onboarding copy changes");
  await expect(pane.getByTestId("inspector-empty")).toHaveText("No agents in this session.");
  await shot(page, "19-inspector-empty");

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
  await expect(pane).toHaveAttribute("data-layout", "side");

  // too narrow for both side by side: it covers the list from the right instead of crushing it
  await app.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1000, 760);
  });
  await expect(pane).toHaveAttribute("data-layout", "overlay");
  await expect(pane.getByTestId("agent-row")).toHaveCount(5);
  await shot(page, "19-inspector-narrow");
});
