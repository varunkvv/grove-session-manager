import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type Fixture, makeFixture, readExecLog, writeSession } from "./helpers/fixture.ts";
import { api, type LaunchedApp, launchApp } from "./helpers/launchApp.ts";
import { asAgent, asPerson, liveSession, writeProject } from "./helpers/project.ts";

const SID = {
  callback: "aaaaaaaa-0000-4000-8000-000000000001",
  store: "bbbbbbbb-0000-4000-8000-000000000002",
  idp: "cccccccc-0000-4000-8000-000000000003",
};

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/** the record stamps `at` to the millisecond, and the list is newest first */
const tick = () => {
  const until = Date.now() + 2;
  while (Date.now() < until);
};

/**
 * one project, six conclusions, newest first F-2, F-1, V-1, D-3, D-2, D-1: two the person made
 * (D-2 replaced D-1), a decision and a verdict agents made without asking, a finding that changes
 * the plan, and one that does not and names no card. the second project has none
 */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "auth-sso",
    prefix: "AUTH",
    goal: "SSO for the dashboard",
  });
  const you = asPerson(root);
  for (const title of ["OIDC callback", "Session store", "Login screen", "Point staging at okta"]) {
    you("card_create", { title });
  }
  const agent = (sessionId: string, name: string, card: string) => {
    writeSession(fx, { cwd: root, sessionId, title: name });
    const call = asAgent(fx, root, { sessionId, name });
    call("card_claim", { card });
    return (args: object) => {
      tick();
      call("conclusion_record", args);
    };
  };
  const callback = agent(SID.callback, "oidc callback", "AUTH-1");
  const store = agent(SID.store, "session store", "AUTH-2");
  const idp = agent(SID.idp, "idp config", "AUTH-4");
  liveSession(fx, { sessionId: SID.store, kind: "interactive", entrypoint: "claude-vscode" });

  callback({
    kind: "decision",
    what: "Keep sessions in the existing signed cookie.",
    why: "No new infrastructure.",
    by: "person",
    card: "AUTH-2",
    area: "api",
  });
  store({
    kind: "decision",
    what: "Sessions move to redis, on the server.",
    why: "A cookie cannot be revoked, and SSO logout needs revoke.",
    by: "person",
    card: "AUTH-2",
    area: "api",
    replaces: "D-1",
  });
  store({
    kind: "decision",
    what: "Session lifetime is 8h sliding, 24h absolute.",
    why: "Matched the current cookie lifetime. The plan did not say.",
    by: "agent",
    card: "AUTH-2",
    area: "api",
    related: ["D-2"],
  });
  callback({
    kind: "verdict",
    what: "The existing SAML strategy cannot be reused for OIDC.",
    why: "It assumes signed assertions and has no token exchange step.",
    by: "agent",
    card: "AUTH-1",
    area: "api",
  });
  idp({
    kind: "finding",
    what: "Staging has no okta tenant in terraform state.",
    why: "Checked the terraform state and the okta admin console.",
    by: "agent",
    card: "AUTH-4",
    area: "infra",
    changes_plan: true,
  });
  idp({
    kind: "finding",
    what: "The api suite takes 11 minutes on CI.",
    why: "Median of the last 20 runs on main.",
    by: "agent",
    area: "tests",
  });

  writeProject(fx, { name: "billing-export", prefix: "BILL", goal: "Invoice exports" });
  return fx;
}

const rows = (page: Page) => page.getByTestId("conclusion-row");
const row = (page: Page, id: string) =>
  page.locator(`[data-testid="conclusion-row"][data-id="${id}"]`);
const ids = (page: Page) =>
  rows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
const search = (page: Page) => page.getByTestId("conclusions-search");

/** the record is read after the page is up */
async function open(): Promise<Page> {
  app = await launchApp(seed());
  await app.page.getByTestId("nav-conclusions").click();
  await expect(rows(app.page)).toHaveCount(6, { timeout: 15_000 });
  return app.page;
}

test("the list: newest first, what and why on two lines, a dot on what an agent settled alone", async () => {
  const page = await open();
  expect(await ids(page)).toEqual(["F-2", "F-1", "V-1", "D-3", "D-2", "D-1"]);
  await expect(search(page)).toBeFocused();

  const d3 = row(page, "D-3");
  await expect(d3).toHaveAttribute("data-kind", "decision");
  await expect(d3.getByTestId("kind")).toHaveText("Decision");
  await expect(d3).toContainText("Session lifetime is 8h sliding, 24h absolute.");
  await expect(d3.getByTestId("conclusion-why")).toHaveText(
    "Matched the current cookie lifetime. The plan did not say.",
  );
  await expect(d3).toContainText("session store");
  await expect(d3.getByTestId("card-chip")).toHaveText("AUTH-2");
  await expect(d3).toContainText("api");
  await expect(row(page, "V-1").getByTestId("kind")).toHaveText("Verdict");
  await expect(row(page, "F-1").getByTestId("kind")).toHaveText("Finding");

  // the dot: an agent's decision or verdict, and a finding that changes the plan
  for (const id of ["D-3", "V-1", "F-1"])
    await expect(row(page, id).getByTestId("dot")).toHaveCount(1);
  for (const id of ["F-2", "D-2", "D-1"])
    await expect(row(page, id).getByTestId("dot")).toHaveCount(0);

  // the person's read `you`, whoever's chat it was said in. a conclusion with no card has no chip
  await expect(row(page, "D-2")).toContainText("you");
  await expect(row(page, "D-2")).not.toContainText("session store");
  await expect(row(page, "F-2").getByTestId("card-chip")).toHaveCount(0);

  // replaced: struck through, and it says by what
  const d1 = row(page, "D-1");
  await expect(d1).toHaveAttribute("data-superseded", "true");
  await expect(d1.getByTestId("replaced-by")).toHaveText("replaced by D-2");
  await expect(d1.getByText("Keep sessions in the existing signed cookie.")).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );
  await expect(row(page, "D-2")).not.toHaveAttribute("data-superseded");

  // nothing in a closed row wraps: two lines and the border
  for (const h of await rows(page).evaluateAll((els) => els.map((e) => e.clientHeight))) {
    expect(h).toBe(56);
  }
});

test("a row opens in place, one at a time, and says who settled it and how", async () => {
  const page = await open();
  const detail = page.getByTestId("conclusion-detail");

  await row(page, "D-3").click();
  await expect(row(page, "D-3")).toHaveAttribute("data-open", "true");
  await expect(detail).toHaveCount(1);
  await expect(detail).toContainText("Decided by session store without asking");
  await expect(detail).toContainText("Related");
  await expect(detail.getByTestId("conclusion-chip")).toHaveText("D-2");
  await expect(detail.getByTestId("conclusion-open")).toHaveText("Open in VS Code");
  await expect(detail.getByTestId("conclusion-review")).toBeVisible();

  await row(page, "V-1").click();
  await expect(row(page, "D-3")).not.toHaveAttribute("data-open");
  await expect(detail).toHaveCount(1);
  await expect(detail).toContainText("Concluded by oidc callback without asking");

  await row(page, "F-1").click();
  await expect(detail).toContainText("Found by idp config");
  // the open row's own line closes it
  await row(page, "F-1").getByTestId("conclusion-why").click();
  await expect(detail).toHaveCount(0);

  // the person's: whose chat it was said in, nothing to review
  await row(page, "D-2").click();
  await expect(detail).toContainText("Decided by you in session store's chat");
  await expect(detail).toContainText("Replaces");
  await expect(detail.getByTestId("conclusion-review")).toHaveCount(0);

  // Open in the editor opens the session that recorded it
  await detail.getByTestId("conclusion-open").click();
  await expect.poll(() => readExecLog(fx).filter((l) => l.bin === "code").length).toBe(1);
});

test("replaced by and the id chips open the row they name, and a filter that hides it is reset", async () => {
  const page = await open();
  // a button inside an option has no role of its own to find it by
  await row(page, "D-1").getByTestId("replaced-by").locator("button").click();
  await expect(row(page, "D-2")).toHaveAttribute("data-open", "true");
  await expect(row(page, "D-1")).not.toHaveAttribute("data-open");

  // D-1 is not a match for `redis`
  await search(page).fill("redis");
  expect(await ids(page)).toEqual(["D-2"]);
  await expect(row(page, "D-2")).toHaveAttribute("data-open", "true");
  await page.getByTestId("conclusion-detail").getByTestId("conclusion-chip").click();
  await expect(search(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(6);
  await expect(row(page, "D-1")).toHaveAttribute("data-open", "true");
  await expect(row(page, "D-2")).not.toHaveAttribute("data-open");
});

test('the search: every word has to be there, "you" finds the person\'s, the kind applies on top', async () => {
  const page = await open();

  await search(page).fill("you");
  expect(await ids(page)).toEqual(["D-2", "D-1"]);
  // the why is searched too, and so are the card, the agent and the area
  await search(page).fill("token exchange");
  expect(await ids(page)).toEqual(["V-1"]);
  await search(page).fill("AUTH-4");
  expect(await ids(page)).toEqual(["F-1"]);
  await search(page).fill("idp  TESTS");
  expect(await ids(page)).toEqual(["F-2"]);
  await search(page).fill("okta redis");
  await expect(page.getByTestId("conclusions-nomatch")).toHaveText("No conclusion matches.");
  await expect(rows(page)).toHaveCount(0);

  await search(page).fill("");
  await page.getByTestId("kind-decision").click();
  expect(await ids(page)).toEqual(["D-3", "D-2", "D-1"]);
  await page.getByTestId("kind-finding").click();
  expect(await ids(page)).toEqual(["F-2", "F-1"]);
  // a letter typed anywhere on the screen goes to the search
  await page.keyboard.type("you");
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue("you");
  await expect(page.getByTestId("conclusions-nomatch")).toBeVisible();
  await page.getByTestId("kind-verdict").click();
  await expect(page.getByTestId("conclusions-nomatch")).toBeVisible();
  await page.getByTestId("kind-all").click();
  expect(await ids(page)).toEqual(["D-2", "D-1"]);

  // a search that hides the open row closes it, so Escape clears the search at once
  await row(page, "D-1").click();
  await search(page).fill("redis");
  await expect(page.getByTestId("conclusion-detail")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(search(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(6);
});

test("Reviewed here is the inbox's mark: the dot and the button go, the row stays, the inbox row leaves", async () => {
  const page = await open();
  const inbox = async () =>
    (await api(page).bootstrap()).inbox.rows.map((r) => r.conclusionId).sort();
  expect(await inbox()).toEqual(["D-3", "F-1", "V-1"]);
  await expect(page.getByTestId("inbox-count")).toHaveText("3");

  await row(page, "D-3").click();
  await page.getByTestId("conclusion-review").click();
  await expect(row(page, "D-3").getByTestId("dot")).toHaveCount(0);
  await expect(page.getByTestId("conclusion-review")).toHaveCount(0);
  await expect(row(page, "D-3")).toHaveAttribute("data-open", "true");
  await expect(rows(page)).toHaveCount(6);

  await expect(page.getByTestId("inbox-count")).toHaveText("2");
  expect(await inbox()).toEqual(["F-1", "V-1"]);
  const marks = () => JSON.parse(readFileSync(path.join(fx.root, "reviewed.json"), "utf8"));
  await expect.poll(() => Object.keys(marks())).toEqual(["AUTH/conclusion:D-3"]);
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("inbox-row")).toHaveCount(2);
  await expect(page.locator('[data-testid="inbox-row"][data-kind="decided"]')).toHaveCount(0);
});

test("the keyboard: typing shows the first match, arrows move, Enter opens, cmd-D reviews, Escape closes then clears", async () => {
  const page = await open();
  const active = page.locator('[data-testid="conclusion-row"][data-active]');
  await expect(active).toHaveCount(0);
  /**
   * the keyboard's row only shows until a pointer moves over the screen, and this is a real window
   * on a desk someone is using. so each step starts from a key that puts the row back, changes
   * nothing when it runs twice, and is tried again until what follows holds
   */
  const step = (run: () => Promise<unknown>) => expect(run).toPass({ timeout: 30_000 });
  const press = async (...keys: string[]) => {
    for (const k of keys) await page.keyboard.press(k);
  };

  await step(async () => {
    await search(page).fill("");
    await page.keyboard.type("session");
    await expect(active).toHaveAttribute("data-id", "D-3", { timeout: 2_000 });
    await expect(search(page)).toHaveAttribute("aria-activedescendant", "row-D-3", {
      timeout: 2_000,
    });
  });
  expect(await ids(page)).toEqual(["D-3", "D-2", "D-1"]);
  await step(async () => {
    await press("Meta+ArrowUp", "ArrowDown", "ArrowDown", "ArrowUp");
    await expect(active).toHaveAttribute("data-id", "D-2", { timeout: 2_000 });
  });
  await step(async () => {
    await press("Meta+ArrowUp");
    // Enter closes an open row: only press it while this one is closed
    if (!(await row(page, "D-3").getAttribute("data-open"))) await press("Enter");
    await expect(row(page, "D-3")).toHaveAttribute("data-open", "true", { timeout: 2_000 });
  });
  await expect(search(page)).toBeFocused();

  await step(async () => {
    await press("Meta+ArrowUp", "Meta+d");
    await expect(row(page, "D-3").getByTestId("dot")).toHaveCount(0, { timeout: 3_000 });
  });
  // the person's own has nothing to review: cmd-D leaves it alone. cmd-Enter opens its session
  const opened = () => readExecLog(fx).filter((l) => l.bin === "code").length;
  await step(async () => {
    if (opened() === 0) await press("Meta+ArrowUp", "ArrowDown", "Meta+d", "Meta+Enter");
    await expect.poll(opened, { timeout: 3_000 }).toBe(1);
  });
  const marks = () => JSON.parse(readFileSync(path.join(fx.root, "reviewed.json"), "utf8"));
  await expect.poll(() => Object.keys(marks())).toEqual(["AUTH/conclusion:D-3"]);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("conclusion-detail")).toHaveCount(0);
  await expect(search(page)).toHaveValue("session");
  await page.keyboard.press("Escape");
  await expect(search(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(6);
});

test("a card chip opens the card and Back returns to the same search and open row. a project with none says so", async () => {
  const page = await open();
  await search(page).fill("redis");
  await row(page, "D-2").click();
  await row(page, "D-2").getByTestId("card-chip").click();
  await expect(page.locator('[data-testid="screen"][data-view="card"]')).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(search(page)).toHaveValue("redis");
  await expect(search(page)).toBeFocused();
  await expect(row(page, "D-2")).toHaveAttribute("data-open", "true");

  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByTestId("project-switcher")).toContainText("billing-export");
  await expect(page.getByTestId("conclusions-empty")).toHaveText(
    "No conclusions yet. Agents record decisions, findings and verdicts as they work, yours included.",
  );
  await expect(search(page)).toHaveCount(0);
});
