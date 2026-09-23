import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeProjectSlug } from "@grove/core";
import { expect, test } from "@playwright/test";
import { type Fixture, makeFixture, makePlainDir, writeSession } from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";

const SID = {
  a: "aaaaaaaa-0000-4000-8000-000000000001",
  b: "bbbbbbbb-0000-4000-8000-000000000002",
};

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

let n = 0;
/** what the status hook writes: the hook's own stdin, one file per event */
function hookEvent(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(fx.root, ".grove", "events");
  mkdirSync(dir, { recursive: true });
  // aside and renamed in, like the real hook: the app must never see half a file
  const file = path.join(dir, `${process.pid}-${++n}`);
  writeFileSync(
    `${file}.tmp`,
    JSON.stringify({ session_id: sessionId, hook_event_name: event, cwd: "/x", ...extra }),
  );
  renameSync(`${file}.tmp`, `${file}.json`);
}

/** what a subagent leaves behind: its own transcript, and the meta its parent wrote when it started */
function writeSubagent(
  cwd: string,
  sessionId: string,
  id: string,
  meta: Record<string, unknown>,
  tool: string,
) {
  const dir = path.join(fx.projectsDir, claudeProjectSlug(cwd), sessionId, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `agent-${id}.meta.json`),
    JSON.stringify({ spawnDepth: 1, requestShape: "foreground", ...meta }),
  );
  writeFileSync(
    path.join(dir, `agent-${id}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      agentId: `agent-${id}`,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: tool, input: { pattern: "needle" } }],
      },
    })}\n`,
  );
}

test("a live session says what is running inside it", async () => {
  fx = makeFixture({ withCompanion: true });
  const queue = makePlainDir(fx, "queue");
  writeSession(fx, { cwd: queue, sessionId: SID.a, title: "Fanning out", ageMs: 10_000 });

  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 1);
  await expect(rows.first().getByTestId("row-agents")).toHaveCount(0);

  // only a live session is looked at, so it has to be running before its agents count
  hookEvent(SID.a, "UserPromptSubmit", { prompt: "survey the repo" });
  await expect(rows.first().getByTestId("live-badge")).toHaveAttribute("data-state", "running");

  writeSubagent(
    queue,
    SID.a,
    "f00d",
    { agentType: "Explore", description: "Survey the repo" },
    "Grep",
  );
  hookEvent(SID.a, "SubagentStart", { agent_id: "f00d", agent_type: "Explore" });

  const chip = rows.first().getByTestId("row-agents");
  await expect(chip).toContainText("1 agent");
  await expect(chip).toContainText("Explore");
  // the row has one line, so what each agent was asked and what it last picked up sit in the tooltip
  await expect(chip).toHaveAttribute("title", /Explore: Survey the repo/);
  await expect(chip).toHaveAttribute("title", /last tool: Grep/);
  await page.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "17-agents.png"),
  });

  // the session's turn ending does not end its agents: a background one outlives it
  hookEvent(SID.a, "Stop", { last_assistant_message: "kicked off the survey" });
  await expect(rows.first().getByTestId("live-badge")).toHaveText("Your turn");
  await expect(chip).toContainText("1 agent");
});

test("a session asking for permission comes first, and leaves once someone looked", async () => {
  fx = makeFixture({ withCompanion: true });
  const queue = makePlainDir(fx, "queue");
  writeSession(fx, { cwd: queue, sessionId: SID.a, title: "Newest session", ageMs: 10_000 });
  writeSession(fx, { cwd: queue, sessionId: SID.b, title: "Older one", ageMs: 3_600_000 });

  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 2);
  await expect(page.getByTestId("needs-you-header")).toHaveCount(0);

  hookEvent(SID.b, "UserPromptSubmit", { prompt: "run the migration" });
  await expect(rows.nth(1).getByTestId("live-badge")).toHaveAttribute("data-state", "running");

  hookEvent(SID.b, "PermissionRequest", { tool_name: "Bash" });
  await expect(page.getByTestId("needs-you-header")).toBeVisible();
  // the older session jumps the queue
  await expect(rows.first()).toContainText("Older one");
  await expect(rows.first().getByTestId("live-badge")).toHaveText("Needs permission");

  await page.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "14-needs-you.png"),
  });

  hookEvent(SID.b, "PostToolUse", { tool_name: "Bash" });
  hookEvent(SID.b, "Stop", { last_assistant_message: "migration applied" });
  await expect(rows.first().getByTestId("live-badge")).toHaveText("Your turn");

  // the action menu can clear it without opening anything, and says which key does the same
  await rows.first().click({ button: "right" });
  await expect(page.getByTestId("action-mark-seen")).toContainText("\u2318D");
  await page.getByTestId("action-mark-seen").click();
  await expect(page.getByTestId("needs-you-header")).toHaveCount(0);
  await expect(rows.first()).toContainText("Newest session");

  // and that key clears the next one without the menu at all
  hookEvent(SID.b, "UserPromptSubmit", { prompt: "and again" });
  hookEvent(SID.b, "Stop", { last_assistant_message: "second pass done" });
  await expect(page.getByTestId("needs-you-header")).toBeVisible();
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("Meta+d");
  await expect(page.getByTestId("needs-you-header")).toHaveCount(0);
});

test("search reaches into the conversation, past titles and prompts", async () => {
  fx = makeFixture({ withCompanion: true });
  const queue = makePlainDir(fx, "queue");
  writeSession(fx, {
    cwd: queue,
    sessionId: SID.a,
    title: "Rate limiter review",
    prompt: "look at the limiter",
    reply: "the token bucket refills on a monotonic clock, so the zanzibar drift is gone",
  });
  writeSession(fx, { cwd: queue, sessionId: SID.b, title: "Something else", ageMs: 90_000 });

  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 2);

  await page.getByTestId("search").fill("zanzibar drift");
  await expect(rows).toHaveCount(1, { timeout: 10_000 });
  await expect(rows.first()).toContainText("Rate limiter review");
  // the second line says where in the conversation it matched
  await expect(rows.first()).toContainText("monotonic clock");
  await expect(rows.first().locator("mark").first()).toBeVisible();
  await page.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "15-deep-search.png"),
  });
});
