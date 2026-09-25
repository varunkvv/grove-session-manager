import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { paneLayout } from "../src/renderer/logic/inspector.ts";
import {
  type Fixture,
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
