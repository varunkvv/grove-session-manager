import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readCard } from "@grove/record";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { reviewAllKeys } from "../src/renderer/logic/palette.ts";
import {
  type Fixture,
  hookEvent,
  makeFixture,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { api, groveTest, type LaunchedApp, launchApp, step } from "./helpers/launchApp.ts";
import { asAgent, asPerson, interrupted, liveSession, writeProject } from "./helpers/project.ts";

const SID = {
  idp: "aaaaaaaa-0000-4000-8000-000000000001",
  login: "bbbbbbbb-0000-4000-8000-000000000002",
  callback: "cccccccc-0000-4000-8000-000000000003",
  tokens: "dddddddd-0000-4000-8000-000000000004",
  /** in the project, holding no card */
  chat: "eeeeeeee-0000-4000-8000-000000000005",
};

const QUESTION =
  "Staging has no okta tenant. Create a dev tenant, or point staging at the prod tenant with its own app? I would create a dev tenant.";

let fx: Fixture;
let app: LaunchedApp;
let root: string;

test.afterEach(async () => {
  await app?.close();
});

/**
 * one project with a row of every kind: Asked, Stopped, Decided, Verdict, Found, New card,
 * Finished. the person wrote the backlog, so only the card an agent made is a New card. the other
 * Asked row, a session with no card, comes from a hook event. the second project has nothing
 */
function seed(): Fixture {
  fx = makeFixture({ withCompanion: true });
  root = writeProject(fx, { name: "auth-sso", prefix: "AUTH", goal: "SSO for the dashboard" }).root;
  const you = asPerson(root);
  for (const title of [
    "Point staging at okta",
    "Login page with the SSO button",
    "Callback handler",
    "Token storage",
  ]) {
    you("card_create", { title });
  }
  const agent = (sessionId: string, name: string, lastPrompt?: string) => {
    writeSession(fx, { cwd: root, sessionId, title: name, lastPrompt });
    return asAgent(fx, root, { sessionId, name });
  };

  const idp = agent(SID.idp, "idp config");
  idp("card_claim", { card: "AUTH-1" });
  idp("question_ask", { card: "AUTH-1", text: QUESTION, to: "person" });
  liveSession(fx, { sessionId: SID.idp, kind: "interactive", entrypoint: "claude-vscode" });

  const login = agent(SID.login, "login page");
  login("card_claim", { card: "AUTH-2" });
  login("conclusion_record", {
    kind: "decision",
    what: "State and nonce go in a signed cookie.",
    why: "No redis round trip on the callback.",
    by: "agent",
    card: "AUTH-2",
  });
  login("conclusion_record", {
    kind: "verdict",
    what: "The saml strategy cannot be reused for oidc.",
    why: "It assumes a POST binding.",
    by: "agent",
    card: "AUTH-2",
  });
  login("card_create", {
    title: "Error page for a disabled org",
    body: "Found while doing AUTH-2. A disabled org lands on a blank page.",
    from: "AUTH-2",
  });
  // held by the supervisor, and Claude Code has not said which background session it is
  liveSession(fx, { sessionId: SID.login, kind: "bg" });

  const callback = agent(SID.callback, "callback handler", "Wire the callback route");
  callback("card_claim", { card: "AUTH-3" });
  // its process went away mid-turn while grove was closed
  interrupted(fx, { [SID.callback]: Date.now() - 60_000 });

  const tokens = agent(SID.tokens, "token storage");
  tokens("card_claim", { card: "AUTH-4" });
  tokens("conclusion_record", {
    kind: "finding",
    what: "Staging has no okta tenant in terraform state.",
    why: "terraform state list shows none.",
    by: "agent",
    card: "AUTH-4",
    changes_plan: true,
  });
  tokens("card_done", { card: "AUTH-4", summary: "Refresh tokens stay on the server (D-1)." });

  writeSession(fx, { cwd: root, sessionId: SID.chat, title: "chat-features-35" });
  writeProject(fx, { name: "billing-export", prefix: "BILL", goal: "Invoice exports" });
  return fx;
}

const rows = (page: Page) => page.getByTestId("inbox-row");
const row = (page: Page, kind: string) =>
  page.locator(`[data-testid="inbox-row"][data-kind="${kind}"]`);
const kinds = (page: Page) =>
  rows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind));

/** the record is read after the page is up */
async function ready(page: Page, count = 7): Promise<void> {
  await expect(rows(page)).toHaveCount(count, { timeout: 15_000 });
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

const reviewed = (target: Locator) =>
  under(target, () => target.getByTestId("inbox-review").click({ timeout: 2_000 }));

test("one row of every kind, Asked and Stopped first, each with its summary on a second line", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);

  const got = await kinds(page);
  expect(got.slice(0, 2).sort()).toEqual(["asked", "stopped"]);
  expect(got.slice(2).sort()).toEqual(["decided", "finished", "found", "new", "verdict"]);
  // the nav counts every row. the tray only the two that wait on the person
  await expect(page.getByTestId("inbox-count")).toHaveText("7");
  expect(await groveTest(app.app).trayTitle()).toBe("2");

  const asked = row(page, "asked");
  await expect(asked).toHaveAttribute("data-card", "AUTH-1");
  await expect(asked).toContainText("AUTH-1Point staging at okta");
  await expect(asked.getByTestId("inbox-summary")).toHaveText(QUESTION);
  await expect(asked.getByTestId("runtime-chip")).toHaveText("VS Code");
  await expect(row(page, "decided").getByTestId("inbox-summary")).toHaveText(
    "D-1State and nonce go in a signed cookie.",
  );
  await expect(row(page, "found").getByTestId("inbox-summary")).toContainText("F-1");
  await expect(row(page, "new")).toContainText("AUTH-5Error page for a disabled org");
  await expect(row(page, "stopped").getByTestId("inbox-summary")).toHaveText(
    "Stopped mid-turn. It was working on: Wire the callback route",
  );

  // who, where and when give way to the two buttons under the mouse
  await expect(asked.getByTestId("inbox-review")).toBeHidden();
  await under(asked, async () => {
    await expect(asked.getByTestId("inbox-review")).toBeVisible({ timeout: 2_000 });
    await expect(asked.getByTestId("inbox-open")).toHaveText("Open in VS Code", { timeout: 2_000 });
    await expect(asked.getByTestId("avatar")).toBeHidden({ timeout: 2_000 });
  });

  // an agent grove cannot open yet: the button says why, and a click on it is not a click on the row
  const held = row(page, "decided");
  await expect(held.getByTestId("runtime-chip")).toHaveText("Background");
  await expect(held.getByTestId("inbox-open")).toBeDisabled();
  await expect(held.getByTestId("inbox-open")).toHaveAttribute(
    "title",
    "running in the background",
  );
  // force: playwright would wait for the button to be enabled
  await under(held, () => held.getByTestId("inbox-open").click({ force: true, timeout: 2_000 }));
  await expect(page.getByTestId("screen")).toHaveAttribute("data-view", "inbox");

  // the other project's inbox is its own: nothing, and no count in the nav
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByTestId("project-switcher")).toContainText("billing-export");
  await expect(page.getByTestId("inbox-empty")).toHaveText("Nothing needs you.");
  await expect(page.getByTestId("inbox-count")).toHaveCount(0);
});

test("Reviewed takes a row out and writes reviewed.json, and marking all leaves Asked and Stopped", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);

  await reviewed(row(page, "decided"));
  await ready(page, 6);
  await expect(row(page, "decided")).toHaveCount(0);
  // the row leaves the page at once, before main has written the file, and a poll that throws ends
  const file = path.join(fx.root, "reviewed.json");
  const marks = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  await expect.poll(() => Object.keys(marks())).toEqual(["AUTH/conclusion:D-1"]);

  // the palette's `Mark all reviewed in auth-sso` (its own piece) makes this same call
  const boot = await api(page).bootstrap();
  const keys = reviewAllKeys(boot.inbox.rows);
  expect(keys).toHaveLength(4);
  await page.evaluate((k) => window.grove.review("auth-sso", k, true), keys);
  await ready(page, 2);
  expect((await kinds(page)).sort()).toEqual(["asked", "stopped"]);
});

test("Reviewed on a question answers it as the person, and the card stops waiting on you", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  const status = async () =>
    (await api(page).bootstrap()).record["auth-sso"]?.cards.find((c) => c.id === "AUTH-1")?.status;
  expect(await status()).toBe("waiting");

  await reviewed(row(page, "asked"));
  await expect(row(page, "asked")).toHaveCount(0);
  await expect.poll(status).toBe("in_progress");
  const card = readCard(root, "AUTH-1");
  expect(card?.asksPerson).toBe(false);
  expect(card?.comments.at(-1)).toMatchObject({
    kind: "answer",
    by: "person",
    answers: card?.questions[0]?.seq,
    text: "answered in the agent's chat",
  });
});

test("a Stop event from a session with no card makes an Asked row, and Reviewed clears it until its next event", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  const session = page.locator('[data-testid="inbox-row"][data-kind="asked"]:not([data-card])');

  hookEvent(fx, SID.chat, "Stop", { last_assistant_message: "Done. Want me to open the PR?" });
  await expect(session).toHaveCount(1);
  await expect(session).toContainText("chat-features-35");
  // its title is its own name, so the agent cell keeps the avatar and leaves the name out
  await expect(session.getByText("chat-features-35", { exact: true })).toHaveCount(1);
  await expect(session.getByTestId("avatar")).toHaveCount(1);
  await expect(session.getByTestId("inbox-summary")).toHaveText("Done. Want me to open the PR?");

  await reviewed(session);
  await expect(session).toHaveCount(0);
  // nothing was stored: looking at a session is not a decision about the record
  expect(existsSync(path.join(fx.root, "reviewed.json"))).toBe(false);

  hookEvent(fx, SID.chat, "UserPromptSubmit");
  hookEvent(fx, SID.chat, "Stop", { last_assistant_message: "Opened it. Merge now?" });
  await expect(session.getByTestId("inbox-summary")).toHaveText("Opened it. Merge now?");
});

test("a notification click lands on the card, or on the inbox row of a session with none", async () => {
  app = await launchApp(seed());
  const { page } = app;
  await ready(page);
  const g = groveTest(app.app);

  // the card page is its own piece: the shell says which screen is on
  await g.reveal(SID.idp);
  await expect(page.locator('[data-testid="screen"][data-view="card"]')).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inbox")).toBeVisible();

  hookEvent(fx, SID.chat, "Stop", { last_assistant_message: "Which branch?" });
  const session = page.locator('[data-testid="inbox-row"]:not([data-card])');
  await expect(session).toHaveCount(1);
  await page.getByTestId("nav-cards").click();
  await g.reveal(SID.chat);
  // that row is the keyboard's, with its buttons showing
  await expect(session).toHaveAttribute("data-active", "true");
  await expect(session.getByTestId("inbox-review")).toBeVisible();
});

test("the keyboard: arrows move, cmd-D reviews, cmd-Enter opens the editor, Enter opens the card", async () => {
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

  // the row that takes a reviewed row's place is the keyboard's next
  await step(async () => {
    if ((await rows(page).count()) === 7) {
      await press("Meta+ArrowUp", "ArrowDown", "ArrowDown", "Meta+d");
    }
    await expect(rows(page)).toHaveCount(6, { timeout: 3_000 });
    await show();
    await at(order[3]!);
  });

  const opens = await rows(page).first().getAttribute("data-card");
  const opened = () => readExecLog(fx).filter((l) => l.bin === "code").length;
  await step(async () => {
    if (opened() === 0) await press("Meta+ArrowUp", "Meta+Enter");
    await expect.poll(opened, { timeout: 3_000 }).toBe(1);
  });

  await step(async () => {
    await press("Meta+ArrowUp", "Enter");
    await expect(page.locator('[data-testid="screen"][data-view="card"]')).toBeAttached({
      timeout: 2_000,
    });
  });
  expect(opens).toMatch(/^AUTH-[13]$/);
});
