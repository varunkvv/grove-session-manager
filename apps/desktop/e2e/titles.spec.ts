import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  type FakeClaude,
  fakeClaudeCalls,
  recapSays,
  setFakeRecaps,
  TITLE_ASK,
  titleSays,
  writeFakeClaude,
} from "./helpers/fakeClaude.ts";
import {
  appendTurn,
  type Fixture,
  hookEvent,
  makeFixture,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp } from "./helpers/launchApp.ts";
import { liveSession, writeProject } from "./helpers/project.ts";

const SID = {
  /** finished an hour ago after a turn with a tool call: named at launch */
  work: "aaaaaaaa-0000-4000-8000-000000000001",
  /** a hello, and nothing done */
  hello: "bbbbbbbb-0000-4000-8000-000000000002",
  /** he renamed it himself */
  mine: "cccccccc-0000-4000-8000-000000000003",
  /** in a turn */
  working: "dddddddd-0000-4000-8000-000000000004",
  /** its turn ends: it needs him */
  turn: "eeeeeeee-0000-4000-8000-000000000005",
};

const WORK = {
  title: "Point staging at okta",
  description: "Registers the dashboard with okta and points staging at it.",
};
const MINE = "Tidies the okta notes for the team.";

let fx: Fixture;
let fake: FakeClaude;
let app: LaunchedApp;
let root: string;
const files: Record<string, string> = {};

test.afterEach(async () => {
  await app?.close();
});

/** auth-sso, with a session of each kind. Claude Code's own titles are the `ai-title` here */
function seed(): void {
  fx = makeFixture({ withCompanion: true });
  root = writeProject(fx, { name: "auth-sso", goal: "SSO for the dashboard" }).root;
  const session = (sessionId: string, title: string, prompt: string, worked = true) => {
    const file = writeSession(fx, {
      cwd: root,
      sessionId,
      title,
      prompt,
      reply: "On it.",
      ageMs: 2 * 3_600_000,
    });
    if (worked) {
      appendTurn(
        file,
        { sessionId, cwd: root },
        {
          prompt: "go ahead",
          tools: [{ name: "Bash", input: { command: "terraform plan" } }],
          reply: "Done. Open the PR now?",
          ageMs: 3_600_000,
        },
      );
    }
    files[sessionId] = file;
  };
  session(SID.work, "idp config", "point staging at okta");
  session(SID.hello, "say hi", "hey", false);
  session(SID.mine, "okta notes", "clean up the okta notes");
  // the person's own /rename
  rename(SID.mine, "my okta notes");
  session(SID.working, "rotate keys", "rotate the okta signing keys");
  session(SID.turn, "okta app", "register the staging app");
  fake = writeFakeClaude(path.join(fx.dir, "bin"));
}

/** what Claude Code appends when a session is renamed, by /rename or by grove's hook */
function rename(sessionId: string, title: string): void {
  appendFileSync(
    files[sessionId] as string,
    `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId })}\n${JSON.stringify({ type: "agent-name", agentName: title, sessionId })}\n`,
  );
}

/** what grove already knows of a session's name, as a launch before this one left it */
function known(names: Record<string, { title: string; description: string }>): void {
  const dir = path.join(fx.root, ".grove");
  mkdirSync(dir, { recursive: true });
  const at = Date.now();
  writeFileSync(
    path.join(dir, "titles.v1.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(names).map(([id, n]) => [
          id,
          { ...n, at, prompts: 2, compacts: 0, titles: [n.title] },
        ]),
      ),
    ),
  );
}

const pendingDir = () => path.join(fx.root, ".grove", "titles", "pending");
const settingsLocal = () => readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8");
const titleCalls = () => fakeClaudeCalls(fake).filter((c) => c.input?.includes(TITLE_ASK));
const row = (page: Page, id: string) =>
  page.locator(`[data-testid="session-row"][data-id="${id}"]`);
const panel = (page: Page) => page.getByTestId("session-panel");

test("a session that did some work is named: its row says what it is for, its panel too, and the title waits for Claude Code", async () => {
  seed();
  setFakeRecaps(fake, [
    { when: [TITLE_ASK, "point staging at okta"], say: titleSays(WORK.title, WORK.description) },
    { when: [TITLE_ASK, "clean up the okta notes"], say: titleSays("Okta notes cleanup", MINE) },
    {
      when: `title: ${WORK.title}`,
      say: recapSays("Point staging at okta", "Registered the app.", "Finished.", "nothing"),
    },
  ]);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  await page.locator('[data-testid="project-item"][data-id="auth-sso"]').click();

  const work = row(page, SID.work);
  await expect(work).toContainText(WORK.title, { timeout: 15_000 });
  await expect(work.getByTestId("session-description")).toHaveText(WORK.description);
  // a hello gets nothing: Claude Code's own title covers it
  await expect(row(page, SID.hello)).toContainText("say hi");
  await expect(row(page, SID.hello).getByTestId("session-description")).toHaveCount(0);
  // his own name stays, and what it is for is still grove's to write
  await expect(row(page, SID.mine).getByTestId("session-description")).toHaveText(MINE);
  await expect(row(page, SID.mine)).toContainText("my okta notes");
  await expect(row(page, SID.mine)).not.toContainText("Okta notes cleanup");
  // what the call was sent: the digest, and the titles of the other sessions there this week
  const call = titleCalls().find((c) => c.input?.includes("point staging at okta"));
  expect(call?.input).toContain("the person's other sessions here from the last week:");
  expect(call?.input).toContain("  - say hi");
  expect(titleCalls().some((c) => c.input?.includes("  - hey"))).toBe(false);

  // grove's title waits for the session's next prompt. his is not grove's to hand over
  expect(readdirSync(pendingDir())).toEqual([SID.work]);
  expect(readFileSync(path.join(pendingDir(), SID.work), "utf8")).toBe(`"${WORK.title}"\n`);
  expect(settingsLocal()).toContain("# grove-title");

  // the panel: the title, what it is for, then the recap without the goal the description says
  await work.click();
  await expect(panel(page).locator("h2")).toHaveText(WORK.title);
  await expect(panel(page).getByTestId("panel-description")).toHaveText(WORK.description);
  await expect(panel(page).getByTestId("recap-done")).toHaveText("Registered the app.");
  await expect(panel(page).getByTestId("recap-goal")).toHaveCount(0);

  // the description is searched like the title
  await page.getByTestId("session-filter").fill("dashboard registers");
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await expect(work.getByTestId("session-description").locator("mark")).toHaveCount(2);
  await page.getByTestId("session-filter").fill("");

  // the hook handed it over: once Claude Code has it, nothing is pending
  rename(SID.work, WORK.title);
  await expect.poll(() => existsSync(path.join(pendingDir(), SID.work))).toBe(false);
  await expect(work).toContainText(WORK.title);
  // then he renames it: his name wins, and the description stays
  rename(SID.work, "staging okta");
  await expect(work).toContainText("staging okta");
  await expect(work.getByTestId("session-description")).toHaveText(WORK.description);
});

test("a working row says what it is for, not its last prompt, and a row that needs him adds what it needs", async () => {
  seed();
  known({
    [SID.working]: {
      title: "Rotate the okta keys",
      description: "Moves the okta signing keys into the new vault.",
    },
    [SID.turn]: {
      title: "Staging okta app",
      description: "Registers a staging okta app and opens its PR.",
    },
  });
  setFakeRecaps(fake, [
    {
      when: "title: Staging okta app",
      say: recapSays(
        "x",
        "Registered the app.",
        "Waiting on the PR.",
        "Say whether to open the PR.",
      ),
    },
  ]);
  liveSession(fx, { sessionId: SID.working, kind: "interactive", entrypoint: "claude-vscode" });
  hookEvent(fx, SID.working, "UserPromptSubmit");
  liveSession(fx, { sessionId: SID.turn, kind: "interactive", entrypoint: "claude-vscode" });
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;

  const working = row(page, SID.working);
  await expect(working).toHaveAttribute("data-state", "working", { timeout: 15_000 });
  await expect(working).toContainText("Rotate the okta keys");
  await expect(working.getByTestId("session-description")).toHaveText(
    "Moves the okta signing keys into the new vault.",
  );
  await expect(working.getByTestId("session-doing")).toHaveCount(0);

  hookEvent(fx, SID.turn, "Stop", { last_assistant_message: "Done. Open the PR now?" });
  const turn = page.locator(`[data-testid="inbox-row"][data-id="${SID.turn}"]`);
  await expect(turn).toContainText("Staging okta app", { timeout: 15_000 });
  await expect(turn.getByTestId("session-description")).toHaveText(
    "Registers a staging okta app and opens its PR.",
  );
  await expect(turn.getByTestId("inbox-summary")).toHaveText("Say whether to open the PR.", {
    timeout: 15_000,
  });
  // neither was due a look: both were named at two prompts, and have two
  expect(titleCalls().filter((c) => c.input?.includes("rotate the okta"))).toHaveLength(0);
});
