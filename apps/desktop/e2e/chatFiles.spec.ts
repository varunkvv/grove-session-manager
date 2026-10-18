// grove chat draws what a session made: images through main's session scheme, which serves only
// the session's folders and the temp folder, cards for files it wrote, and a viewer beside the
// conversation. no claude runs: the transcripts are written before launch.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { appendTurn, makeFixture, writeSession } from "./helpers/fixture.ts";
import { type LaunchedApp, launchApp, waitFor } from "./helpers/launchApp.ts";
import { writeProject } from "./helpers/project.ts";

const SID = "dddddddd-0000-4000-8000-000000000001";
/** a 2x2 png */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==",
  "base64",
);

let app: LaunchedApp;

test.afterEach(async () => {
  await app?.close();
});

function seed(reply: string) {
  const fx = makeFixture({ withCompanion: true });
  writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ chat: true }));
  const { id, root } = writeProject(fx, { name: "files-trial" });
  mkdirSync(path.join(root, "art"), { recursive: true });
  writeFileSync(path.join(root, "art", "shot.png"), PNG);
  // outside every folder of the session, and a link inside that points at it
  const outside = path.join(fx.dir, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "secret.png"), PNG);
  symlinkSync(outside, path.join(root, "escape"));
  const file = writeSession(fx, { cwd: root, sessionId: SID, title: "made things", reply });
  return { fx, id, root, outside, file };
}

async function chatWindow(electron: ElectronApplication): Promise<Page> {
  let found: Page | undefined;
  await waitFor(async () => {
    for (const p of electron.windows()) {
      if (!p.url().includes("#/chat")) continue;
      if ((await p.locator(`[data-testid="chat"][data-id="${SID}"]`).count()) > 0) {
        found = p;
        return true;
      }
    }
    return false;
  }, 15_000);
  return found as Page;
}

async function open(s: ReturnType<typeof seed>): Promise<Page> {
  app = await launchApp(s.fx);
  await app.page.locator(`[data-testid="project-item"][data-id="${s.id}"]`).click();
  await app.page.locator(`[data-testid="session-row"][data-id="${SID}"]`).dblclick();
  return chatWindow(app.app);
}

/** how wide an image came out: 0 when it did not load */
const widthOf = (page: Page, alt: string) =>
  page.locator(`img[alt="${alt}"]`).evaluate((img: HTMLImageElement) => img.naturalWidth);

test("an image the agent points at is drawn from the session's folder, and nothing outside it", async () => {
  const s = seed("");
  const outside = path.join(s.outside, "secret.png");
  appendTurn(
    s.file,
    { sessionId: SID, cwd: s.root },
    {
      prompt: "show me",
      reply: `Here: ![shot](art/shot.png)\n\n![abs](${s.root}/art/shot.png)\n\n![out](${outside})\n\n![link](escape/secret.png)\n\n![web](https://example.com/x.png)`,
    },
  );
  const chat = await open(s);
  await expect.poll(() => widthOf(chat, "shot")).toBe(2);
  await expect.poll(() => widthOf(chat, "abs")).toBe(2);
  // asked for, and refused by main
  await chat.waitForTimeout(300);
  expect(await widthOf(chat, "out")).toBe(0);
  expect(await widthOf(chat, "link")).toBe(0);
  // a web image is its words, as everywhere else
  await expect(chat.locator('img[alt="web"]')).toHaveCount(0);
  await expect(chat.locator(".md-alt", { hasText: "web" })).toHaveCount(1);
  // and the main window's panel draws none of it: its markdown is as it was
  await app.page.locator(`[data-testid="session-row"][data-id="${SID}"]`).click();
  await expect(app.page.getByTestId("panel-text")).toContainText("Here:");
  await expect(app.page.locator(".md img")).toHaveCount(0);
});
