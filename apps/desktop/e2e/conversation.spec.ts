import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { recapSays, setFakeRecaps, writeFakeClaude } from "./helpers/fakeClaude.ts";
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
  /** three turns, the last one over */
  talk: "aaaaaaaa-0000-4000-8000-000000000001",
  /** 103 short turns */
  long: "bbbbbbbb-0000-4000-8000-000000000002",
};

// long enough that three turns do not fit the panel: it has to open at its end
const para = (word: string) =>
  Array.from({ length: 12 }, (_, i) => `${word} line ${i}.`).join("\n\n");
// an agent wrote it: markdown is drawn, html is its text
const FIRST = `Staging has **no tenant** of its own.\n\n${para("first")}\n\n<i id="evil">raw</i>`;
const SECOND = `The app is registered.\n\n${para("second")}`;
const THIRD = `Both redirect URIs are in.\n\n${para("third")}\n\nOpen the PR now?`;

let fx: Fixture;
let app: LaunchedApp;
let file: string;
let cwd: string;

test.afterEach(async () => {
  await app?.close();
});

function seed(): void {
  fx = makeFixture({ withCompanion: true });
  cwd = writeProject(fx, { name: "auth-sso", goal: "SSO for the dashboard" }).root;
  file = writeSession(fx, {
    cwd,
    sessionId: SID.talk,
    title: "idp config",
    prompt: "which tenant does staging use",
    reply: FIRST,
    ageMs: 10 * 60_000,
  });
  const o = { sessionId: SID.talk, cwd };
  appendTurn(file, o, {
    prompt: "register an app in the dev tenant",
    tools: [
      { name: "Read", input: { file_path: path.join(cwd, "infra/okta.tf") } },
      { name: "Edit", input: { file_path: path.join(cwd, "infra/okta.tf") } },
      { name: "Bash", input: { command: "terraform plan" } },
    ],
    reply: SECOND,
    ageMs: 8 * 60_000,
    tookMs: 4 * 60_000,
  });
  appendTurn(file, o, {
    prompt: "one redirect URI per environment",
    tools: [{ name: "Edit", input: { file_path: path.join(cwd, "infra/okta.tf") } }],
    reply: THIRD,
    ageMs: 2 * 60_000,
  });
  liveSession(fx, { sessionId: SID.talk, kind: "interactive", entrypoint: "claude-vscode" });
  hookEvent(fx, SID.talk, "Stop", { last_assistant_message: THIRD });

  const long = writeSession(fx, {
    cwd,
    sessionId: SID.long,
    title: "a long one",
    prompt: "prompt 0",
    reply: "answer 0",
    ageMs: 3 * 3_600_000,
  });
  for (let i = 1; i < 103; i++) {
    appendTurn(
      long,
      { sessionId: SID.long, cwd },
      { prompt: `prompt ${i}`, reply: `answer ${i}`, ageMs: 3 * 3_600_000 },
    );
  }
}

const panel = (page: Page) => page.getByTestId("session-panel");
const turns = (page: Page) => panel(page).getByTestId("turn");
const row = (page: Page, id: string) =>
  page.locator(`[data-testid="session-row"][data-id="${id}"]`);
/** how far the conversation is from its end, in pixels */
const fromEnd = (page: Page) =>
  panel(page)
    .getByTestId("conversation")
    .evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));

test("the panel has the session's turns under its recap, opened at the end, and a new turn arrives", async () => {
  seed();
  const fake = writeFakeClaude(path.join(fx.dir, "bin"));
  setFakeRecaps(fake, [
    {
      when: "title: idp config",
      say: recapSays(
        "Point staging at okta",
        "Registered the app.",
        "Waiting on the PR.",
        "Say whether to open the PR.",
      ),
    },
  ]);
  app = await launchApp(fx, { GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  await page.locator('[data-testid="project-item"][data-id="auth-sso"]').click();
  await row(page, SID.talk).click({ timeout: 15_000 });

  // the recap on top, and under it every turn, oldest first
  await expect(panel(page).getByTestId("recap-needs")).toHaveText("Say whether to open the PR.");
  await expect(turns(page)).toHaveCount(3);
  await expect(turns(page).nth(0)).toContainText("which tenant does staging use");
  // the work in one line, never its steps: no tool's name, input or output
  await expect(turns(page).getByTestId("turn-work")).toHaveText([
    "Claude",
    "Claude · 3 steps · 1 file edited · 4m",
    "Claude · 1 step · 1 file edited · 30s",
  ]);
  await expect(panel(page)).not.toContainText("terraform plan");
  // an agent's message is markdown, and its html is text
  await expect(turns(page).nth(0).locator("strong")).toHaveText("no tenant");
  await expect(turns(page).nth(0)).toContainText('<i id="evil">raw</i>');
  await expect(page.locator("#evil")).toHaveCount(0);
  // the last turn is what the panel always showed
  await expect(panel(page).getByTestId("panel-prompt")).toHaveText(
    "one redirect URI per environment",
  );
  await expect(panel(page).getByTestId("panel-text")).toContainText("Open the PR now?");
  // it opens at its end: the last message is in sight, the first turn is scrolled away
  await expect.poll(() => fromEnd(page)).toBeLessThan(4);
  await expect(panel(page).getByText("Open the PR now?")).toBeInViewport();
  await expect(turns(page).nth(0).getByText("which tenant does staging use")).not.toBeInViewport();
  // and the recap stays put over it
  await expect(panel(page).getByTestId("recap")).toBeInViewport();

  // he answers in the editor: the new turn shows while it works, with what it has done so far
  const o = { sessionId: SID.talk, cwd };
  appendTurn(file, o, {
    prompt: "yes, open it",
    tools: [{ name: "Bash", input: { command: "gh pr create" } }],
  });
  hookEvent(fx, SID.talk, "UserPromptSubmit");
  await expect(turns(page)).toHaveCount(4);
  await expect(panel(page).getByTestId("state")).toHaveAttribute("data-state", "working");
  await expect(panel(page).getByTestId("panel-prompt")).toHaveText("yes, open it");
  await expect(turns(page).nth(3).getByTestId("turn-work")).toHaveText("Claude · 1 step so far");
  await expect(panel(page).getByTestId("panel-text")).toHaveText("Nothing said yet.");
  // the recap is from before this turn, and no new one is written while it works
  await expect(panel(page).getByTestId("recap-when")).toContainText("before this turn");
  await expect(panel(page).getByTestId("recap-again")).toHaveCount(0);
  await expect.poll(() => fromEnd(page)).toBeLessThan(4);

  // and when the turn ends, the message it ended on
  appendTurn(file, o, { reply: "The PR is open: #42." });
  hookEvent(fx, SID.talk, "Stop", { last_assistant_message: "The PR is open: #42." });
  await expect(panel(page).getByTestId("panel-text")).toHaveText("The PR is open: #42.");
  await expect(turns(page)).toHaveCount(4);
  await expect(panel(page).getByText("The PR is open: #42.")).toBeInViewport();
});

test("a long session sends its last hundred turns and says the rest are in the editor", async () => {
  seed();
  app = await launchApp(fx);
  const { page } = app;
  await page.locator('[data-testid="project-item"][data-id="auth-sso"]').click();
  await row(page, SID.long).click({ timeout: 15_000 });
  await expect(turns(page)).toHaveCount(100);
  await expect(panel(page).getByTestId("turns-older")).toHaveText("3 older turns are in VS Code.");
  await expect(turns(page).first()).toContainText("prompt 3");
  await expect(panel(page).getByTestId("panel-prompt")).toHaveText("prompt 102");
  await expect(panel(page).getByTestId("panel-text")).toHaveText("answer 102");
  await expect(panel(page).getByText("answer 102")).toBeInViewport();
  // no claude was named, so nothing was asked and nothing says a recap is on its way
  await expect(panel(page).getByTestId("recap")).toHaveCount(0);
  await expect(panel(page).getByTestId("recap-writing")).toHaveCount(0);
});
