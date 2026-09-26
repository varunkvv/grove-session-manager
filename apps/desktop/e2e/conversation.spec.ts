import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { paneLayout } from "../src/renderer/logic/inspector.ts";
import { appendConversation, t, writeConversation } from "./helpers/conversation.ts";
import {
  type Fixture,
  hookEvent,
  makeFixture,
  makePlainDir,
  readExecLog,
  writeSession,
} from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";

const SID = {
  root: "aaaaaaaa-0000-4000-8000-00000000000a",
  loose: "bbbbbbbb-0000-4000-8000-00000000000b",
};

let fx: Fixture;
let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

/** a combo written the way a person could write it, with its root on disk */
function writeCombo(name: string): string {
  const root = path.join(fx.root, name);
  mkdirSync(root, { recursive: true });
  const logs = makePlainDir(fx, "logs");
  writeFileSync(
    path.join(fx.root, "combos.json"),
    JSON.stringify({ combos: [{ name, root, folders: [{ path: logs, mode: "reference" }] }] }),
  );
  return root;
}

const launches = () => readExecLog(fx).filter((l) => l.bin === "code").length;

/** nothing launched for a moment: a launch that is coming would have come by then */
async function stillNoLaunch(page: Page, before: number): Promise<void> {
  await page.waitForTimeout(600);
  expect(launches()).toBe(before);
}

function setup() {
  fx = makeFixture({ withCompanion: true });
  const root = writeCombo("ops");
  writeSession(fx, {
    cwd: root,
    sessionId: SID.root,
    title: "Tidy the nightly logs",
    prompt: "the logs folder is 40GB, tidy what is older than a week",
    reply: "Removed 212 files older than seven days. The folder is 3.1GB now.",
    ageMs: 30_000,
  });
  const queue = makePlainDir(fx, "queue");
  writeSession(fx, {
    cwd: queue,
    sessionId: SID.loose,
    title: "Rate limiter backoff",
    prompt: "review the backoff handling in rate_limiter.py",
    reply: "The backoff doubles without a cap.",
    ageMs: 5 * 60_000,
  });
  return { root, queue };
}

test("a click reads a session in the pane, and only a double-click, Enter or a button opens it", async () => {
  setup();
  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 2);
  const tidy = rows.filter({ hasText: "Tidy the nightly logs" });

  // a click: the pane opens on the conversation, and the editor is left alone
  await tidy.click();
  const pane = page.getByTestId("inspector");
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute("data-view", "conversation");
  await expect(pane).toHaveAttribute("aria-label", "Session");
  await expect(pane.getByTestId("inspector-title")).toHaveText("Tidy the nightly logs");
  await expect(pane.getByTestId("conversation")).toContainText("the logs folder is 40GB");
  await expect(pane.getByTestId("conversation")).toContainText("Removed 212 files");
  await expect(pane.getByTestId("pane-meta")).toHaveText("ops · opus 5 · 1s · 0 tools");
  await expect(tidy).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("footer-open")).toContainText("Click to read");
  await stillNoLaunch(page, 0);

  // the pane's own button goes where Enter would
  await expect(pane.getByTestId("pane-open")).toHaveText("Open in VS Code");
  await pane.getByTestId("pane-open").click();
  await waitFor(async () => launches() === 1);
  expect(readExecLog(fx).find((l) => l.bin === "code")?.argv[0]).toMatch(/ops\.code-workspace$/);

  // a double-click is what a click used to be
  await tidy.dblclick();
  await waitFor(async () => launches() === 2);
  // so is Enter, from the search field
  await page.getByTestId("search").focus();
  await page.keyboard.press("Enter");
  await waitFor(async () => launches() === 3);

  // hovering a row swaps its time for a quiet open button, and the row does not move
  const loose = rows.filter({ hasText: "Rate limiter backoff" });
  const before = await loose.boundingBox();
  await loose.hover();
  await expect(loose.getByTestId("row-open")).toBeVisible();
  expect(await loose.boundingBox()).toEqual(before);
  // the reading pane follows a click to another row
  await loose.click();
  await expect(pane.getByTestId("inspector-title")).toHaveText("Rate limiter backoff");
  await expect(pane.getByTestId("conversation")).toContainText("doubles without a cap");
  // not in a combo: its open offers the folder, and ⋯ has every way in
  await expect(pane.getByTestId("pane-open")).toHaveText("Open in VS Code");
  await pane.getByTestId("pane-actions").click();
  await expect(page.getByTestId("session-menu")).toBeVisible();
  await expect(page.getByTestId("action-folder-land")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("session-menu")).toHaveCount(0);
  expect(launches()).toBe(3);

  // the row's own open button goes too, for a session outside any combo it lands on its folder
  await loose.hover();
  await loose.getByTestId("row-open").click();
  await waitFor(async () => readExecLog(fx).filter((l) => l.bin === "code").length === 4);
});

test("the pane starts at half the room, and keeps the width it is dragged to", async () => {
  setup();
  app = await launchApp(fx);
  const { page } = app;
  const rows = page.getByTestId("session-row");
  await waitFor(async () => (await rows.count()) === 2);
  await rows.first().click();
  const pane = page.getByTestId("inspector");
  await expect(pane).toHaveAttribute("data-layout", "side");
  const available = await pane.evaluate((el) => el.parentElement?.clientWidth ?? 0);
  const box = await pane.boundingBox();
  expect(box?.width).toBe(paneLayout(available).width);

  // dragged wider by its left edge
  const edge = pane.getByTestId("pane-edge");
  const at = await edge.boundingBox();
  if (!at) throw new Error("no edge");
  await page.mouse.move(at.x + at.width / 2, at.y + 200);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2 - 60, at.y + 200, { steps: 4 });
  await page.mouse.up();
  const wider = (await pane.boundingBox())?.width ?? 0;
  // a pixel either way: the pointer lands on half pixels
  expect(Math.abs(wider - paneLayout(available, (box?.width ?? 0) + 60).width)).toBeLessThan(2);

  // it remembers across a reload of the window
  await page.reload();
  await page.getByTestId("app-ready").waitFor();
  await page.getByTestId("session-row").first().click();
  await expect.poll(async () => (await pane.boundingBox())?.width).toBe(wider);

  // a double-click on the edge puts it back to half
  await pane.getByTestId("pane-edge").dblclick();
  await expect.poll(async () => (await pane.boundingBox())?.width).toBe(box?.width);
});

const OUT = path.join(import.meta.dirname, "screenshots");

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

const DAY = 86_400;
const ASKED = {
  questions: [
    {
      header: "Flag",
      question: "Should the old button stay behind a flag?",
      options: [
        { label: "Yes, for one release", description: "d" },
        { label: "No, remove it", description: "d" },
      ],
    },
  ],
};

/** three days of one session: every kind of turn the pane draws */
function longSession(cwd: string) {
  const src = `${cwd}/src/report`;
  return [
    t.prompt(
      "the export button should move to the first page of the report flow.\nkeep the old one for a release",
      0,
    ),
    t.says("m1", t.text("Looking at the report flow first."), 5),
    t.says("m1", t.call("r1", "Read", { file_path: `${src}/Flow.tsx` }), 6),
    t.result("r1", "export function Flow() {}", 7),
    t.says("m2", t.call("r2", "Read", { file_path: `${src}/Page.tsx` }), 8),
    t.result("r2", "export function Page() {}", 9),
    t.says("m3", t.call("r3", "Read", { file_path: `${src}/Export.tsx` }), 10),
    t.result("r3", "export function Export() {}", 11),
    t.says("m4", t.call("e1", "Edit", { file_path: `${src}/Flow.tsx` }), 20),
    t.result("e1", "The file has been updated.", 21),
    t.says("m5", t.call("b1", "Bash", { command: "pnpm test" }), 30),
    t.result("b1", "Exit code 1\nFAIL report.test.ts", 60, { isError: true }),
    t.says("m6", t.text("Moved. The **old button** stays for one release behind a flag."), 70),
    t.command("model", "opus", 100),
    t.stdout("Set model to opus 5", 100),
    t.prompt([t.image(), t.image(), t.text("here is how it looks now. plan the rest")], 200, {
      extra: { permissionMode: "plan" },
    }),
    t.says("m7", t.call("q1", "AskUserQuestion", ASKED), 210),
    t.result("q1", "Your questions have been answered", 260, {
      told: { questions: [], answers: { [ASKED.questions[0]!.question]: "Yes, for one release" } },
    }),
    t.says(
      "m8",
      t.call("p1", "ExitPlanMode", { plan: "# the plan\n\n- move it\n- flag the old one" }),
      300,
    ),
    t.result(
      "p1",
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection:  keep the old button for two releases, not one",
      400,
      { isError: true },
    ),
    t.says(
      "m9",
      t.call("p2", "ExitPlanMode", {
        plan: "# the plan\n\n- move it\n- flag the old one for two releases",
      }),
      420,
    ),
    t.result("p2", "User has approved your plan.", 480, {
      told: { plan: "# the plan", filePath: "/plans/p.md", isAgent: false },
    }),
    t.says("m10", t.text("Plan approved. Starting on the first page."), 490),
    t.taskNotification('Background command "pnpm e2e" completed (exit code 0)', DAY),
    t.says("m11", t.text("The e2e run passed."), DAY + 10),
    t.prompt("now the second page", DAY + 100),
    t.says("m12", t.call("r4", "Read", { file_path: `${src}/Second.tsx` }), DAY + 110),
    t.compactBoundary(DAY + 120, "auto", 1_025_204, 25_073),
    t.compactSummary(
      "Summary: the export button moved, behind a flag for two releases.",
      DAY + 120,
    ),
    t.result("r4", "export function Second() {}", DAY + 130),
    t.says("m13", t.text("The second page reads the same flag."), DAY + 140),
    t.prompt("ship it", 2 * DAY),
    t.queued("and write the changelog line too", 2 * DAY + 10),
    t.says("m14", t.call("w1", "Write", { file_path: `${cwd}/CHANGELOG.md` }), 2 * DAY + 20),
    t.result("w1", "File created successfully", 2 * DAY + 21),
    t.says("m15", t.text("Shipped behind the flag, and the changelog says so."), 2 * DAY + 30),
    t.prompt("run it once more", 2 * DAY + 100),
    t.userLine([t.text("[Request interrupted by user]")], 2 * DAY + 105),
    t.prompt("go on", 2 * DAY + 200),
    t.says("m16", t.call("b2", "Bash", { command: "pnpm e2e" }), 2 * DAY + 210),
    t.result("b2", "ok", 2 * DAY + 230),
    t.apiError(2 * DAY + 240, 1),
    t.apiError(2 * DAY + 245, 2),
  ];
}

const LONG = "cccccccc-0000-4000-8000-00000000000c";

test("a conversation reads as prompts, one line for the work, and answers", async () => {
  fx = makeFixture({ withCompanion: true });
  const cwd = makePlainDir(fx, "report");
  writeConversation(fx, {
    cwd,
    sessionId: LONG,
    title: "Move the export button",
    lines: longSession(cwd),
  });
  app = await launchApp(fx);
  const { page } = app;
  const row = page.getByTestId("session-row").filter({ hasText: "Move the export button" });
  await row.click();
  const pane = page.getByTestId("inspector");
  const conv = pane.getByTestId("conversation");
  // it opens at the end, where the session is now: a run of retries nothing came after
  const last = conv.getByTestId("turn-status").filter({ hasText: "retry 2 of 10" });
  await expect(last).toBeInViewport();
  await expect(conv.getByTestId("day-header").last()).toHaveText("Today");
  await expect(pane.getByTestId("pane-meta")).toContainText("report · main · opus 5 · 2d");
  await expect(pane.getByTestId("toggle-thinking")).toBeVisible();
  await shot(page, "24-conversation");

  // the keyboard: Tab goes in, Home is the first prompt, the arrows step through prompts and work
  await page.keyboard.press("Tab");
  await expect(conv).toBeFocused();
  await page.keyboard.press("Home");
  const first = conv.locator('[data-testid="prompt"][data-cursor]');
  await expect(first).toContainText("the export button should move");
  // a prompt keeps its line breaks, and is never markdown
  await expect(first).toContainText("report flow.\nkeep the old one");
  await expect(conv.getByTestId("day-header").first()).not.toHaveText("Today");
  await page.keyboard.press("ArrowDown");
  const work = conv.locator('[data-testid="work-line"][data-cursor]');
  await expect(work).toHaveText(/^\S+ · 5 steps · 1 file edited$/);
  await expect(conv.getByTestId("answer").first()).toContainText("stays for one release");
  // Enter opens the work: runs of one tool fold, a failure says how, the prose sits between
  await page.keyboard.press("Enter");
  await expect(work).toHaveAttribute("data-open", "true");
  await expect(conv.getByTestId("step-run").first()).toContainText("Read ×3");
  await expect(conv.getByTestId("step").filter({ hasText: "pnpm test" })).toContainText("exit 1");
  await expect(conv.getByTestId("work-prose").first()).toContainText("Looking at the report flow");
  await shot(page, "25-conversation-work");
  await page.keyboard.press("Enter");
  await expect(conv.getByTestId("step-run")).toHaveCount(0);

  // a slash command is its command, and its output is the answer, both in mono
  await page.keyboard.press("ArrowDown");
  const command = conv.locator('[data-testid="prompt"][data-cursor]');
  await expect(command).toHaveAttribute("data-kind", "command");
  await expect(command).toContainText("/model opus");
  await expect(conv.getByTestId("command-output")).toContainText("Set model to opus 5");

  // what was asked of the person, and what they said back, is in sight without opening anything
  await page.keyboard.press("ArrowDown");
  const planning = conv.locator('[data-testid="prompt"][data-cursor]');
  await expect(planning).toContainText("plan the rest");
  await expect(planning.getByTestId("prompt-images")).toHaveText("2 images");
  await expect(planning.getByTestId("prompt-plan")).toHaveText("plan mode");
  await expect(conv.locator('[data-testid="mark"][data-kind="question"]')).toContainText(
    "Should the old button stay behind a flag?",
  );
  await expect(conv.getByTestId("picked")).toHaveText("Yes, for one release");
  const plans = conv.locator('[data-testid="mark"][data-kind="plan"]');
  await expect(plans.first()).toContainText("Plan · turned down");
  await expect(plans.first().getByTestId("plan-said")).toHaveText(
    "keep the old button for two releases, not one",
  );
  await expect(plans.nth(1)).toContainText("Plan · approved");
  await shot(page, "26-conversation-marks");

  // a background task's news is a quiet line, not a prompt
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const task = conv.locator('[data-testid="prompt"][data-cursor]');
  await expect(task).toHaveAttribute("data-kind", "task");
  await expect(task).toContainText('Background task finished · Background command "pnpm e2e"');

  // a compaction divides, and says what it carried on with
  const compaction = conv.getByTestId("compaction");
  await expect(compaction).toContainText("compacted · 1.0M → 25k tokens");
  await compaction.getByTestId("compaction-more").click();
  await expect(conv.getByTestId("compaction-summary")).toContainText("behind a flag");
  // the work after it went on with nobody asking: an answer with no prompt over it
  await expect(conv.getByTestId("answer").filter({ hasText: "reads the same flag" })).toBeVisible();

  // today: what was said while it worked, a turn cut short
  await expect(conv.locator('[data-testid="mark"][data-kind="said"]')).toContainText(
    "While it workedand write the changelog line too",
  );
  await expect(conv.getByTestId("turn-status").filter({ hasText: "Interrupted" })).toHaveCount(1);
  // left goes back to the list
  await conv.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("search")).toBeFocused();

  // too narrow for both: over the list, and still the whole conversation
  await app.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1000, 760);
  });
  await expect(pane).toHaveAttribute("data-layout", "overlay");
  await expect(pane).toHaveCSS("position", "absolute");
  await shot(page, "24-conversation-narrow");
});

test("a search opens the conversation at the turn that said it, with its words marked", async () => {
  fx = makeFixture({ withCompanion: true });
  const cwd = makePlainDir(fx, "report");
  writeConversation(fx, {
    cwd,
    sessionId: LONG,
    title: "Move the export button",
    lines: longSession(cwd),
  });
  app = await launchApp(fx);
  const { page } = app;
  await page.getByTestId("session-row").first().waitFor();
  // said once, in the first turn of three days
  await page.getByTestId("search").fill("second page");
  const row = page.getByTestId("session-row").filter({ hasText: "Move the export button" });
  await row.click();
  const conv = page.getByTestId("inspector").getByTestId("conversation");
  const landed = conv.locator('[data-testid="prompt"][data-cursor]');
  await expect(landed).toContainText("now the second page");
  await expect(landed).toBeInViewport();
  await expect(landed.locator("mark")).toHaveText(["second", "page"]);
  await shot(page, "28-conversation-search");
});

test("a running session's newest turn is open, and follows what it writes", async () => {
  fx = makeFixture({ withCompanion: true });
  const cwd = makePlainDir(fx, "report");
  const lines = [
    t.prompt("move the export button", 0),
    t.says("m1", t.text("Done."), 5),
    t.prompt("now tidy the report folder", 60),
    ...Array.from({ length: 12 }, (_, i) => [
      t.says(`w${i}`, t.call(`r${i}`, "Read", { file_path: `${cwd}/src/f${i}.ts` }), 61 + i * 2),
      t.result(`r${i}`, "x", 62 + i * 2),
    ]).flat(),
    t.says("w12", t.call("b0", "Bash", { command: "pnpm lint" }), 90),
  ];
  const { file, shift } = writeConversation(fx, {
    cwd,
    sessionId: LONG,
    title: "Tidy the report folder",
    lines,
    endAgoMs: 2_000,
  });
  app = await launchApp(fx);
  const { page } = app;
  const row = page.getByTestId("session-row").filter({ hasText: "Tidy the report folder" });
  await row.waitFor();
  hookEvent(fx, LONG, "UserPromptSubmit", { prompt: "now tidy the report folder" });
  await expect(row.getByTestId("live-badge")).toHaveAttribute("data-state", "running");
  await row.click();
  const conv = page.getByTestId("inspector").getByTestId("conversation");
  // the turn under way comes open, its newest step breathing
  const live = conv.locator('[data-testid="work-line"][data-live]');
  await expect(live).toHaveAttribute("data-open", "true");
  const newest = conv.getByTestId("step").filter({ hasText: "pnpm lint" });
  await expect(newest).toBeInViewport();
  await expect(newest.locator(".live-pulse")).toHaveCount(1);

  // it writes: the steps arrive without anyone asking, and the tail stays in view
  // an edit and a check each time, so no run of one tool folds them into a line
  const more = (from: number, count: number) =>
    Array.from({ length: count }, (_, k) => {
      const i = from + k;
      const s = 92 + i * 4;
      return [
        t.says(`x${i}`, t.call(`e${i}`, "Edit", { file_path: `${cwd}/src/g${i}.ts` }), s),
        t.result(`e${i}`, "ok", s + 1),
        t.says(`y${i}`, t.call(`c${i}`, "Bash", { command: `pnpm test g${i}` }), s + 2),
        t.result(`c${i}`, "ok", s + 3),
      ];
    }).flat();
  appendConversation(file, {
    cwd,
    sessionId: LONG,
    shift,
    lines: [t.result("b0", "ok", 91), ...more(0, 20)],
  });
  const edited = conv.getByTestId("step").filter({ hasText: "src/g19.ts" });
  await expect(edited).toBeInViewport();
  await expect(page.getByTestId("jump-live")).toHaveCount(0);

  // scrolled up, it stays where it was put and says how to get back
  await conv.hover();
  await page.mouse.wheel(0, -3000);
  await expect(page.getByTestId("jump-live")).toBeVisible();
  await expect(live).toContainText("steps · 20 files edited");
  appendConversation(file, { cwd, sessionId: LONG, shift, lines: more(20, 2) });
  await expect(live).toContainText("22 files edited");
  await shot(page, "27-conversation-live");
  await page.getByTestId("jump-live").click();
  await expect(conv.getByTestId("step").filter({ hasText: "src/g21.ts" })).toBeInViewport();
});
