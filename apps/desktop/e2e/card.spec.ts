import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FAKE_SHORT_ID, fakeClaudeCalls, writeFakeClaude } from "./helpers/fakeClaude.ts";
import {
  type Fixture,
  makeFixture,
  pendingIntents,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { groveTest, type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { asAgent, asPerson, interrupted, liveSession, writeProject } from "./helpers/project.ts";

const SID = {
  idp: "aaaaaaaa-0000-4000-8000-000000000001",
  callback: "bbbbbbbb-0000-4000-8000-000000000002",
  research: "cccccccc-0000-4000-8000-000000000003",
  store: "dddddddd-0000-4000-8000-000000000004",
  audit: "eeeeeeee-0000-4000-8000-000000000005",
  fresh: "ffffffff-0000-4000-8000-000000000006",
};

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/** the record stamps `at` to the millisecond and a thread sorts on it: no two writes share one */
function agent(root: string, sessionId: string, name: string) {
  const call = asAgent(fx, root, { sessionId, name });
  return (tool: string, args: object) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    return call(tool, args);
  };
}

/** the record is read after the page is up, and the self-check answers after that */
async function ready(project: string) {
  await app.page.waitForFunction(
    async (id) => {
      const b = await window.grove.bootstrap();
      return !!b.record[id]?.readAt && b.projects.every((p) => p.server.state === "ok");
    },
    project,
    { timeout: 30_000 },
  );
  return groveTest(app.app);
}

const cardPage = (page: Page, id: string) =>
  page.locator(`[data-testid="card-page"][data-id="${id}"]`);

const chipTo = (page: Page, id: string) =>
  page.locator(`[data-testid="card-chip"][data-id="${id}"]`).first();

const codeRuns = () => readExecLog(fx).filter((l) => l.bin === "code");

/**
 * AUTH-3 is held by an agent in the editor and has one of everything a thread draws. AUTH-2 is
 * held by an agent in a terminal, AUTH-1 by a session grove has no transcript of.
 */
function heldProject(): string {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "auth-sso",
    prefix: "AUTH",
    goal: "SSO for the dashboard",
  });
  const you = asPerson(root);
  const idp = agent(root, SID.idp, "idp config");
  const callback = agent(root, SID.callback, "callback route");
  you("card_create", { title: "Find out how okta wants the app registered" });
  agent(root, SID.research, "okta research")("card_claim", { card: "AUTH-1" });
  you("card_create", { title: "Callback route" });
  callback("card_claim", { card: "AUTH-2" });
  you("card_create", {
    title: "Point staging at okta",
    body: "Register the dashboard with okta, so AUTH-2 can be tried.",
    from: "AUTH-1",
    needs: ["AUTH-2"],
  });
  idp("card_claim", { card: "AUTH-3" });
  idp("comment_add", {
    card: "AUTH-3",
    text: "The settings are written up.",
    artifacts: [
      { type: "file", ref: "artifacts/okta.md" },
      { type: "branch", ref: "feat/okta" },
    ],
  });
  idp("conclusion_record", {
    kind: "finding",
    what: "Staging has no okta tenant.",
    why: "terraform state lists none.",
    card: "AUTH-3",
    by: "agent",
  });
  idp("question_ask", { card: "AUTH-3", to: "AUTH-2", text: "Which redirect URI?" });
  callback("question_answer", { card: "AUTH-3", question: 2, text: "/auth/callback" });
  idp("conclusion_record", {
    kind: "decision",
    what: "One okta app, a redirect URI per environment.",
    why: "okta matches them exactly.",
    card: "AUTH-3",
    by: "agent",
  });
  idp("question_ask", { card: "AUTH-3", to: "person", text: "A dev tenant, or the prod one?" });

  writeSession(fx, { cwd: root, sessionId: SID.idp, title: "idp config" });
  writeSession(fx, { cwd: root, sessionId: SID.callback, title: "callback route" });
  liveSession(fx, { sessionId: SID.idp, kind: "interactive", entrypoint: "claude-vscode" });
  liveSession(fx, { sessionId: SID.callback, kind: "interactive", entrypoint: "cli" });
  return root;
}

test("a held card: the thread in order, both questions, artifacts, links and conclusions", async () => {
  const root = heldProject();
  app = await launchApp(fx);
  const { page } = app;
  const g = await ready("auth-sso");

  // where a click on its question's notification lands
  await g.reveal(SID.idp);
  await expect(cardPage(page, "AUTH-3")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Point staging at okta");
  await expect(page.getByTestId("card-status")).toHaveAttribute("data-status", "waiting");
  await expect(page.getByTestId("card-status")).toHaveText("In progress, waiting on you");
  await expect(page.getByTestId("card-primary")).toHaveText("Open in VS Code");
  await expect(page.getByTestId("card-primary")).toHaveAttribute("data-action", "open");
  // the keyboard is on the column that scrolls
  await expect(page.getByTestId("card-main")).toBeFocused();
  // an id in the description is a chip
  await expect(page.getByTestId("card-main").locator(".md").first()).toContainText("so AUTH-2 can");
  await expect(chipTo(page, "AUTH-2")).toBeVisible();

  // oldest first. the claim is not drawn, the conclusions sit where they were recorded
  const items = page.getByTestId("thread-item");
  await expect(items).toHaveCount(6);
  expect(await items.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind))).toEqual(
    ["comment", "finding", "question", "answer", "decision", "question"],
  );
  await expect(items.nth(0)).toContainText("attached");
  await expect(items.nth(0)).toContainText("The settings are written up.");
  await expect(items.nth(0).getByTestId("file-chip")).toHaveText(["okta.md", "feat/okta"]);
  await expect(items.nth(1)).toContainText("found");
  await expect(items.nth(1).getByTestId("conclusion-chip")).toHaveText("F-1");
  // a question to another agent, answered: no dot
  await expect(items.nth(2)).toContainText("asked");
  await expect(items.nth(2).getByTestId("card-chip")).toHaveAttribute("data-id", "AUTH-2");
  await expect(items.nth(2)).toContainText("Which redirect URI?");
  await expect(items.nth(3)).toContainText("callback route");
  await expect(items.nth(3)).toContainText("replied");
  await expect(items.nth(4)).toContainText("decided");
  await expect(items.nth(4).getByTestId("conclusion-chip")).toHaveText("D-1");
  // the open one, to the person
  await expect(items.nth(5)).toContainText("asked you");
  await expect(page.getByTestId("dot")).toHaveCount(1);
  await expect(items.nth(5).getByTestId("dot")).toBeVisible();
  await expect(page.getByTestId("answer-hint")).toHaveText(
    "Answer in the agent's session · Open in VS Code",
  );

  const side = page.getByTestId("card-side");
  await expect(side.getByTestId("side-agent")).toContainText("idp config");
  await expect(side.getByTestId("runtime-chip")).toHaveText("VS Code");
  expect(
    await side
      .getByTestId("artifact")
      .evaluateAll((els) =>
        els.map((e) => [(e as HTMLElement).dataset.type, e.querySelector("span")?.textContent]),
      ),
  ).toEqual([
    ["file", "okta.md"],
    ["branch", "feat/okta"],
  ]);
  await expect(side.getByTestId("side-links").locator("p")).toHaveText([
    "needs AUTH-2",
    "created from AUTH-1",
  ]);
  await expect(side.getByTestId("card-conclusion")).toHaveText([
    "D-1One okta app, a redirect URI per environment.",
    "F-1Staging has no okta tenant.",
  ]);

  // a conclusion recorded while the page is open: it moves nothing on the card's own files
  agent(
    root,
    SID.idp,
    "idp config",
  )("conclusion_record", {
    kind: "verdict",
    what: "The prod tenant is not safe to share.",
    why: "A mistake there locks people out.",
    card: "AUTH-3",
    by: "agent",
  });
  await expect(items).toHaveCount(7, { timeout: 15_000 });
  await expect(items.nth(6)).toHaveAttribute("data-kind", "verdict");
  await expect(side.getByTestId("card-conclusion")).toHaveCount(3);

  // a chip goes to its card, and Escape comes back, then to where the landing came from
  await side.getByTestId("side-links").getByTestId("card-chip").first().click();
  await expect(cardPage(page, "AUTH-2")).toBeVisible();
  await expect(page.getByTestId("thread")).toHaveCount(0);
  await expect(page.getByTestId("card-main")).toContainText("No description.");
  await expect(page.getByTestId("card-main")).toContainText("No activity yet.");
  await page.keyboard.press("Escape");
  await expect(cardPage(page, "AUTH-3")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="screen"][data-view="inbox"]')).toBeAttached();
});

test("Open by runtime: the editor lands, a terminal says so, an unfound session waits", async () => {
  const root = heldProject();
  app = await launchApp(fx);
  const { page } = app;
  const g = await ready("auth-sso");
  const primary = page.getByTestId("card-primary");
  const toasts = page.getByTestId("toast");

  // in the editor: the project's window, and an intent that names the session. cmd-Enter is Open
  await g.reveal(SID.idp);
  await expect(cardPage(page, "AUTH-3")).toBeVisible();
  await page.keyboard.press("Meta+Enter");
  await expect(toasts.filter({ hasText: "Opening AUTH-3 in VS Code" })).toBeVisible();
  await waitFor(async () => codeRuns().length === 1);
  expect(codeRuns()[0]?.argv[0]).toMatch(/auth-sso\.code-workspace$/);
  expect(pendingIntents(fx)).toMatchObject([{ kind: "resume", sessionId: SID.idp, cwd: root }]);

  // in a terminal: it cannot be landed on. the project opens, and nothing new is left to land
  await chipTo(page, "AUTH-2").click();
  await expect(cardPage(page, "AUTH-2")).toBeVisible();
  await expect(page.getByTestId("runtime-chip")).toHaveText("Terminal");
  await expect(page.getByTestId("answer-hint")).toHaveText("Answer in the agent's terminal.");
  await primary.click();
  await expect(
    toasts.filter({
      hasText: "This agent is running in a terminal. Quit it there, then open it in VS Code.",
    }),
  ).toBeVisible();
  expect(pendingIntents(fx).map((i) => i.sessionId)).toEqual([SID.idp]);

  // no transcript yet: the button says why it cannot, and a title needs the pointer to show
  await page.keyboard.press("Escape");
  await page.getByTestId("side-links").locator('[data-id="AUTH-1"]').click();
  await expect(cardPage(page, "AUTH-1")).toBeVisible();
  await expect(primary).toBeDisabled();
  await expect(primary).toHaveAttribute("title", "Grove has not found this agent's session yet.");
  expect(await primary.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe("auto");
});

test("a background agent is stopped after a confirm, then landed on", async () => {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, { name: "ops-jobs", prefix: "OPS", goal: "Nightly exports" });
  asPerson(root)("card_create", { title: "Export job skeleton" });
  agent(root, SID.idp, "export job")("card_claim", { card: "OPS-1" });
  writeSession(fx, { cwd: root, sessionId: SID.idp, title: "export job" });
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), [
    {
      pid: 99999,
      id: "d7b6bcc2",
      sessionId: SID.idp,
      cwd: root,
      kind: "background",
      status: "busy",
      state: "working",
    },
  ]);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  const g = await ready("ops-jobs");

  await g.reveal(SID.idp);
  await expect(cardPage(page, "OPS-1")).toBeVisible();
  // the supervisor's answer comes after the first look: the page reads the card again
  await expect(page.getByTestId("runtime-chip")).toHaveText("Background");
  await page.getByTestId("card-primary").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("Stop it while it works?");
  expect(codeRuns()).toEqual([]);
  await page.getByTestId("confirm-run").click();
  await waitFor(async () => codeRuns().length === 1);
  // stop, never rm, and only then the editor
  const argv = fakeClaudeCalls(fake).map((c) => c.argv);
  expect(argv).toContainEqual(["stop", "d7b6bcc2"]);
  expect(argv.flat()).not.toContain("rm");
  expect(pendingIntents(fx)).toMatchObject([{ kind: "resume", sessionId: SID.idp }]);
  await expect(page.getByTestId("toast").filter({ hasText: "Opening OPS-1" })).toBeVisible();
});

/**
 * PAY-1 is held and names the others. PAY-2 was claimed and given back, PAY-3's agent stopped
 * mid-turn, PAY-4 is done, and two of PAY-5's files were cut short.
 */
function mixedProject(): string {
  fx = makeFixture({ withCompanion: true });
  const { root } = writeProject(fx, {
    name: "pay-fix",
    prefix: "PAY",
    goal: "Fix the payout retries",
  });
  const you = asPerson(root);
  you("card_create", { title: "Plan the retry fix", body: "PAY-2, PAY-3, PAY-4 and PAY-5." });
  agent(root, SID.idp, "planner")("card_claim", { card: "PAY-1" });
  you("card_create", { title: "Retry with backoff" });
  const quitter = agent(root, SID.research, "first try");
  quitter("card_claim", { card: "PAY-2" });
  quitter("card_release", { card: "PAY-2", note: "Not started." });
  you("card_create", { title: "Idempotency keys" });
  agent(root, SID.store, "key store")("card_claim", { card: "PAY-3" });
  you("card_create", { title: "Audit the retry table" });
  const audit = agent(root, SID.audit, "auditor");
  audit("card_claim", { card: "PAY-4" });
  audit("card_done", { card: "PAY-4", summary: "412 rows, none retried twice." });
  you("card_create", { title: "Cut", body: "A writer died halfway through this file." });
  you("comment_add", { card: "PAY-5", text: "And through this one, a moment later." });
  for (const f of ["card.md", "comments/0001.md"]) {
    const file = path.join(root, "cards", "PAY-5", f);
    const whole = readFileSync(file, "utf8");
    writeFileSync(file, whole.slice(0, whole.length / 2));
  }
  writeSession(fx, { cwd: root, sessionId: SID.store, title: "key store" });
  writeSession(fx, { cwd: root, sessionId: SID.audit, title: "auditor" });
  interrupted(fx, { [SID.store]: Date.now() - 5 * 60_000 });
  return root;
}

test("a card that was given back offers a start, and waits for the claim", async () => {
  const root = mixedProject();
  app = await launchApp(fx);
  const { page } = app;
  const g = await ready("pay-fix");
  await g.reveal(SID.idp);
  await chipTo(page, "PAY-2").click();
  await expect(cardPage(page, "PAY-2")).toBeVisible();

  // the agent that gave it back is not shown as if it held the card
  const primary = page.getByTestId("card-primary");
  await expect(page.getByTestId("card-status")).toHaveText("Todo");
  await expect(primary).toHaveText("Start an agent in VS Code");
  await expect(primary).toHaveAttribute("data-action", "start");
  const side = page.getByTestId("side-agent");
  await expect(side).toContainText("Nobody is on this card.");
  await expect(side.getByTestId("start-background-card")).toHaveText("Start in the background");
  await expect(page.getByTestId("answer-hint")).toHaveCount(0);

  await primary.click();
  await expect(
    page
      .getByTestId("toast")
      .filter({ hasText: "Opening pay-fix in VS Code on a new conversation" }),
  ).toBeVisible();
  expect(pendingIntents(fx)).toMatchObject([
    {
      kind: "new",
      cwd: root,
      prompt:
        "Call record_state first, then claim PAY-2 with card_claim and work on it: Retry with backoff\n\nRead it with card_show before you start.",
    },
  ]);
  // until it claims, nothing here offers a second one
  await expect(side.getByTestId("side-waiting")).toContainText("Waiting for it to claim this card");
  await expect(side.getByTestId("runtime-chip")).toHaveText("VS Code");
  await expect(side.getByTestId("start-background-card")).toHaveCount(0);

  // the claim arrives while the page is open
  agent(root, SID.fresh, "retry worker")("card_claim", { card: "PAY-2" });
  await expect(page.getByTestId("card-status")).toHaveText("In progress", { timeout: 15_000 });
  await expect(side.getByTestId("side-waiting")).toHaveCount(0);
  await expect(side).toContainText("retry worker");
  await expect(primary).toHaveAttribute("data-action", "open");
});

test("a stopped card resumes where it ran, or gets a new agent", async () => {
  const root = mixedProject();
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), []);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  const g = await ready("pay-fix");
  await g.reveal(SID.store);
  await expect(cardPage(page, "PAY-3")).toBeVisible();
  await expect(page.getByTestId("card-status")).toHaveAttribute("data-status", "stopped");
  const side = page.getByTestId("side-agent");
  await expect(side).toContainText("stopped mid-turn 5m ago");
  await expect(side.getByTestId("runtime-chip")).toHaveText("Closed");

  // a fresh agent, told to take the card over
  await expect(side.getByTestId("start-background-card")).toHaveText("Start a new agent instead");
  await side.getByTestId("start-background-card").click();
  await expect(
    page.getByTestId("toast").filter({ hasText: `started in background · ${FAKE_SHORT_ID}` }),
  ).toBeVisible();
  const dispatch = fakeClaudeCalls(fake).find((c) => c.argv.includes("--bg"));
  expect(dispatch?.cwd).toBe(root);
  expect(dispatch?.argv).toEqual([
    "--bg",
    "--",
    "Call record_state first. I want you to take over PAY-3 from key store, whose session is no longer running: Idempotency keys\n\nTake it with card_takeover, then read it with card_show and carry on from where it stopped.",
  ]);
  await expect(side.getByTestId("side-waiting")).toBeVisible();
  await expect(side.getByTestId("start-background-card")).toHaveCount(0);

  // or the old session, where it ran
  await page.getByTestId("card-primary").click();
  await waitFor(async () => codeRuns().length === 1);
  expect(pendingIntents(fx)).toMatchObject([{ kind: "resume", sessionId: SID.store }]);
});

test("a done card opens the session that did the work, and a card that is gone says so", async () => {
  const root = mixedProject();
  app = await launchApp(fx);
  const { page } = app;
  const g = await ready("pay-fix");
  await g.reveal(SID.idp);
  await chipTo(page, "PAY-4").click();
  await expect(cardPage(page, "PAY-4")).toBeVisible();
  await expect(page.getByTestId("card-status")).toHaveText("Done");
  const done = page.getByTestId("thread-item");
  await expect(done).toHaveCount(1);
  await expect(done).toHaveAttribute("data-kind", "done");
  await expect(done).toContainText("finished");
  await expect(done).toContainText("412 rows, none retried twice.");
  const side = page.getByTestId("side-agent");
  await expect(side).toContainText("auditor");
  await expect(side).toContainText("finished now");
  await expect(side.getByTestId("start-background-card")).toHaveCount(0);
  await expect(page.getByTestId("answer-hint")).toHaveCount(0);

  await expect(page.getByTestId("card-primary")).toHaveText("Open in VS Code");
  await page.getByTestId("card-primary").click();
  await waitFor(async () => codeRuns().length === 1);
  expect(pendingIntents(fx)).toMatchObject([{ kind: "resume", sessionId: SID.audit }]);

  rmSync(path.join(root, "cards", "PAY-4"), { recursive: true });
  await expect(page.getByTestId("card-missing")).toHaveText("This card no longer exists.", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("card-primary")).toHaveCount(0);
  await expect(page.getByTestId("card-side")).toHaveCount(0);
  await page.getByTestId("back").click();
  await expect(cardPage(page, "PAY-1")).toBeVisible();
});

test("a record file that was cut short is marked where it is drawn", async () => {
  mixedProject();
  app = await launchApp(fx);
  const { page } = app;
  const g = await ready("pay-fix");
  await g.reveal(SID.idp);
  await chipTo(page, "PAY-5").click();
  await expect(cardPage(page, "PAY-5")).toBeVisible();
  // what could be read is still shown, and each mark names its own file
  await expect(page.locator("header").getByTestId("problem")).toHaveAttribute(
    "title",
    /cards\/PAY-5\/card\.md: .*frontmatter is not closed/,
  );
  const item = page.getByTestId("thread-item");
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("problem")).toHaveAttribute(
    "title",
    /cards\/PAY-5\/comments\/0001\.md: .*frontmatter is not closed/,
  );
});
