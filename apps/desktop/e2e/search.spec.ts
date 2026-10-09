import { expect, type Page, test } from "@playwright/test";
import {
  type Fixture,
  hookEvent,
  makeFixture,
  makePlainDir,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

const sid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const SID = {
  /** the word is in its title */
  titled: sid(1),
  /** the word is only in what was said in it */
  said: sid(2),
  /** in the other project, said there too */
  other: sid(3),
  /** needs him, and the word is in what it said */
  asks: sid(4),
  /** in no project, and nothing about the word */
  loose: sid(5),
  /** ten days old, said there: it is in Older */
  old: sid(6),
  /** the word is in its branch, which a row of the home screen does not show */
  branch: sid(7),
};
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/**
 * two projects and a folder outside them. `flamingo` is in one title, in one branch, and in what
 * four other sessions said: one in each project, one that needs him, one of ten days ago
 */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const auth = writeProject(fx, { name: "auth-sso" }).root;
  const billing = writeProject(fx, { name: "billing-export" }).root;
  writeSession(fx, {
    cwd: auth,
    sessionId: SID.titled,
    title: "okta flamingo notes",
    ageMs: 2 * MIN,
  });
  writeSession(fx, {
    cwd: auth,
    sessionId: SID.said,
    title: "idp config",
    reply: "The flamingo migration is done, the old table can go.",
    ageMs: 3 * MIN,
  });
  writeSession(fx, {
    cwd: billing,
    sessionId: SID.other,
    title: "export job",
    reply: "csv only. The Flamingo table is not exported.",
    ageMs: 4 * MIN,
  });
  writeSession(fx, {
    cwd: billing,
    sessionId: SID.asks,
    title: "invoice totals",
    reply: "The flamingo column is rounded twice. Round up or down?",
  });
  hookEvent(fx, SID.asks, "Stop", { last_assistant_message: "Round up or down?" });
  writeSession(fx, {
    cwd: makePlainDir(fx, "scratch"),
    sessionId: SID.loose,
    title: "meeting notes",
    reply: "nothing about birds",
    ageMs: 5 * MIN,
  });
  writeSession(fx, {
    cwd: billing,
    sessionId: SID.branch,
    title: "table cleanup",
    branch: "feat/flamingo-table",
    ageMs: 6 * MIN,
  });
  writeSession(fx, {
    cwd: auth,
    sessionId: SID.old,
    title: "session store",
    reply: "an old flamingo lived here",
    ageMs: 10 * DAY,
  });
  return fx;
}

const field = (page: Page) => page.getByTestId("session-filter");
const rows = (page: Page) => page.getByTestId("session-row");
const row = (page: Page, id: string) =>
  page.locator(`[data-testid="session-row"][data-id="${id}"]`);
const needs = (page: Page) => page.getByTestId("inbox-row");
const older = (page: Page) => page.getByTestId("older-toggle");
const group = (page: Page, key: string) =>
  page.locator(`[data-testid="session-group"][data-group="${key}"]`);
const panel = (page: Page) => page.getByTestId("session-panel");
const projectItem = (page: Page, id: string) =>
  page.locator(`[data-testid="project-item"][data-id="${id}"]`);
const drawn = (page: Page) =>
  rows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));

/** every session indexed: five are drawn, and Older holds the sixth */
async function ready(page: Page): Promise<void> {
  await expect(needs(page)).toHaveCount(1, { timeout: 15_000 });
  await expect(rows(page)).toHaveCount(5, { timeout: 20_000 });
  await expect(older(page)).toHaveText("Older1");
}

test("the home screen's search looks in every session: titles at once, then what was said, with the words marked", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);

  // the field is the top bar's, and cmd-F is the screen he is on
  await expect(field(page)).toHaveAttribute("placeholder", "Search");
  await expect(field(page)).toHaveAttribute("aria-label", "Search every session");
  await page.keyboard.press("Meta+f");
  await expect(field(page)).toBeFocused();
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");

  await page.keyboard.type("FLAMINGO");
  // found by its title, by its branch and by what was said in it: in both projects, and in Older,
  // which is not folded while something is typed
  await expect(rows(page)).toHaveCount(5);
  expect(await drawn(page)).toEqual([SID.titled, SID.said, SID.other, SID.branch, SID.old]);
  await expect(row(page, SID.loose)).toHaveCount(0);
  await expect(group(page, "older").getByTestId("session-row")).toHaveCount(1);
  await expect(older(page)).toHaveCount(0);

  // a title that holds the word marks it, and needs no second line
  const titled = row(page, SID.titled);
  await expect(titled.locator("mark")).toHaveText("flamingo");
  await expect(titled.getByTestId("session-snippet")).toHaveCount(0);
  // one found by what was said: the words around it on a second line, marked as it was written
  const said = row(page, SID.said).getByTestId("session-snippet");
  await expect(said).toContainText("The flamingo migration is done");
  await expect(said.locator("mark")).toHaveText("flamingo");
  await expect(row(page, SID.other).getByTestId("session-snippet").locator("mark")).toHaveText(
    "Flamingo",
  );
  await expect(row(page, SID.old).getByTestId("session-snippet")).toContainText(
    "an old flamingo lived here",
  );
  // one found by its branch says the branch: no other part of its row here would
  const branch = row(page, SID.branch).getByTestId("session-snippet");
  await expect(branch).toHaveText("feat/flamingo-table");
  await expect(branch.locator("mark")).toHaveText("flamingo");
  // the one that needs him is still his first row, and says why it is here in place of what it asks
  await expect(needs(page)).toHaveCount(1);
  await expect(needs(page).getByTestId("session-snippet")).toContainText("flamingo column");
  await expect(needs(page).getByTestId("inbox-summary")).toHaveCount(0);

  // every word has to be there, wherever each one is
  await field(page).fill("flamingo okta");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, SID.titled)).toHaveCount(1);
  // a project's name finds its sessions here
  await field(page).fill("billing-export");
  await expect(rows(page)).toHaveCount(2);
  expect(await drawn(page)).toEqual([SID.other, SID.branch]);
  await expect(needs(page)).toHaveCount(1);
  // nothing: said once main has looked
  await field(page).fill("nothing like it");
  await expect(page.getByTestId("sessions-none")).toHaveText("No sessions match.");

  // Escape, one step at a time: the panel, then what was typed. Older folds again
  await field(page).fill("flamingo");
  await expect(rows(page)).toHaveCount(5);
  await row(page, SID.said).click();
  await expect(panel(page)).toHaveAttribute("data-id", SID.said);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("panel")).toHaveCount(0);
  await expect(field(page)).toHaveValue("flamingo");
  await page.keyboard.press("Escape");
  await expect(field(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(5);
  await expect(needs(page).getByTestId("inbox-summary")).toHaveText("Round up or down?");
  await expect(older(page)).toHaveAttribute("aria-expanded", "false");
});

test("a project's search stays in the project, and what is typed never follows him to another screen", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);

  await field(page).fill("flamingo");
  await expect(rows(page)).toHaveCount(5);
  // another screen starts with nothing typed
  await projectItem(page, "auth-sso").click();
  await expect(page.getByTestId("project-name")).toHaveText("auth-sso");
  await expect(field(page)).toHaveValue("");
  await expect(field(page)).toHaveAttribute("aria-label", "Search the sessions in auth-sso");
  await expect(rows(page)).toHaveCount(2);

  await page.keyboard.press("Meta+f");
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("flamingo");
  // its own three: by title, by what was said, and the old one. not billing-export's two
  await expect(rows(page)).toHaveCount(3);
  expect(await drawn(page)).toEqual([SID.titled, SID.said, SID.old]);
  await expect(row(page, SID.said).getByTestId("session-snippet").locator("mark")).toHaveText(
    "flamingo",
  );
  // every row here is in the project: its name finds nothing
  await field(page).fill("auth-sso");
  await expect(page.getByTestId("sessions-none")).toHaveText("No sessions match.");

  // from a form cmd-F is the form's list: the project's sessions come back with the field focused
  await field(page).fill("");
  await page.keyboard.press("Meta+e");
  await expect(page.getByTestId("project-form")).toBeVisible();
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "sessions");
  await expect(field(page)).toBeFocused();

  // and back on the home screen nothing is typed either
  await field(page).fill("flamingo");
  await expect(rows(page)).toHaveCount(3);
  await page.getByTestId("nav-inbox").click();
  await expect(field(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(5);
});
