// grove chat draws what a session made: images and videos through main's session scheme, which
// serves only the session's folders and the temp folder, cards for files it wrote, and a viewer
// beside the conversation. no claude runs: the transcripts are written before launch.
import {
  copyFileSync,
  mkdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { FILE_SCHEME, sessionUrl } from "../src/shared/sessionUrl.ts";
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
  // and the main window's session card draws none of it: the end of the answer as words
  await app.page.locator(`[data-testid="session-row"][data-id="${SID}"]`).click();
  await expect(app.page.getByTestId("card-tail")).toContainText("web");
  await expect(app.page.locator(".md img")).toHaveCount(0);
});

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0b817d"/></svg>';
const PAGE = `<!doctype html><html><body><h1>mockup</h1><p id="out"></p><script>
let reached = "no";
try { reached = window.parent.document.title ? "yes" : "no"; } catch { reached = "blocked"; }
document.getElementById("out").textContent = "grove: " + reached;
</script></body></html>`;

test("what a turn wrote is a card in it, and opens beside the conversation, live", async () => {
  const s = seed("");
  mkdirSync(path.join(s.root, "plans"), { recursive: true });
  mkdirSync(path.join(s.root, "artifacts"), { recursive: true });
  const plan = path.join(s.root, "plans", "plan.md");
  const page = path.join(s.root, "art", "page.html");
  writeFileSync(plan, "# The plan\n\n![diagram](d.svg)\n");
  writeFileSync(path.join(s.root, "plans", "d.svg"), SVG);
  writeFileSync(page, PAGE);
  writeFileSync(path.join(s.root, "artifacts", "report.md"), "report");
  appendTurn(
    s.file,
    { sessionId: SID, cwd: s.root },
    {
      prompt: "make things",
      tools: [
        { name: "Read", input: { file_path: path.join(s.root, "art", "shot.png") } },
        { name: "Write", input: { file_path: plan, content: "x" } },
        { name: "Write", input: { file_path: page, content: "x" } },
        { name: "Write", input: { file_path: path.join(s.root, "app.ts"), content: "x" } },
      ],
      reply: "Made a plan and a page.",
    },
  );
  const chat = await open(s);
  const cards = chat.getByTestId("output-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute("data-kind", "image");
  await expect
    .poll(() =>
      cards
        .nth(0)
        .locator("img")
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    )
    .toBe(2);
  // the files pane is closed until asked for
  await expect(chat.getByTestId("viewer")).toHaveCount(0);
  await expect(chat.getByTestId("files")).toHaveCount(0);

  await cards.filter({ hasText: "plan.md" }).click();
  const viewer = chat.getByTestId("viewer");
  await expect(viewer.getByTestId("viewer-text")).toContainText("The plan");
  // its image is from its own folder
  await expect
    .poll(() =>
      viewer.locator('img[alt="diagram"]').evaluate((i: HTMLImageElement) => i.naturalWidth),
    )
    .toBe(40);
  // rewritten on disk: the viewer follows
  writeFileSync(plan, "# The plan, again\n");
  await expect(viewer.getByTestId("viewer-text")).toContainText("The plan, again");

  // every file it wrote, then the project's plans and artifacts
  await chat.getByTestId("viewer-list").click();
  const files = chat.getByTestId("files");
  await expect(files).toContainText("Written in this session");
  await expect(files.getByTestId("file-item")).toHaveText([
    /app\.ts/,
    /page\.html/,
    /plan\.md/,
    /plan\.md/,
    /d\.svg/,
    /report\.md/,
  ]);

  // a page runs in the sandbox, and cannot reach grove
  await files.getByTestId("file-item").filter({ hasText: "page.html" }).click();
  const frame = chat.frameLocator('[data-testid="viewer-frame"]');
  await expect(frame.locator("h1")).toHaveText("mockup");
  await expect(frame.locator("#out")).toHaveText("grove: blocked");
  // a page that sets no ground of its own is on white, as in a browser, in either appearance
  expect(
    await chat.getByTestId("viewer-frame").evaluate((f) => getComputedStyle(f).backgroundColor),
  ).toBe("rgb(255, 255, 255)");

  // the toggle closes it, and so does Esc
  await chat.getByTestId("chat-files").click();
  await expect(chat.getByTestId("viewer")).toHaveCount(0);
  await chat.getByTestId("chat-files").click();
  await expect(chat.getByTestId("files")).toBeVisible();
  await chat.getByTestId("composer").press("Escape");
  await expect(chat.getByTestId("files")).toHaveCount(0);
});

test("the viewer reads nothing outside the session's folders", async () => {
  const s = seed("hello");
  const chat = await open(s);
  const read = (file: string) =>
    chat.evaluate((f) => window.grove.chatReadFile(f).then((o) => o.ok), file);
  expect(await read(path.join(s.root, "art", "shot.png"))).toBe(true);
  expect(await read("/etc/hosts")).toBe(false);
  expect(await read(path.join(s.root, "escape", "secret.png"))).toBe(false);
  expect(await read(`${s.root}/../outside/secret.png`)).toBe(false);
  // nor from the main window, which has no session
  expect(
    await app.page.evaluate(() => window.grove.chatReadFile("/etc/hosts").then((o) => o.ok)),
  ).toBe(false);
});

test("code is coloured in a chat window, as a viewer's text file is, and the card's is plain", async () => {
  const s = seed(
    "```ts\nconst answer: number = 42;\n```\n\n```nosuchlang\nplain words\n```\n\nSee [the app](app.py).",
  );
  writeFileSync(path.join(s.root, "app.py"), "def hello():\n    return 1\n");
  const chat = await open(s);
  const ts = chat.locator('code[data-lang="ts"]');
  await expect(ts).toContainText("const answer");
  await expect.poll(() => ts.locator("span[style]").count()).toBeGreaterThan(2);
  // a language shiki does not know stays plain
  await expect(chat.locator('code[data-lang="nosuchlang"]')).toHaveText("plain words");
  expect(await chat.locator('code[data-lang="nosuchlang"] span[style]').count()).toBe(0);
  // a link to a file opens it beside the conversation, coloured by its extension
  await chat.locator(".md-file", { hasText: "the app" }).click();
  const py = chat.getByTestId("viewer").locator('code[data-lang="py"]');
  await expect(py).toContainText("def hello");
  await expect.poll(() => py.locator("span[style]").count()).toBeGreaterThan(1);
  // the main window's session card: the end of the answer, no colour, no file link
  await app.page.locator(`[data-testid="session-row"][data-id="${SID}"]`).click();
  await expect(app.page.getByTestId("card-tail")).toContainText("plain words");
  expect(await app.page.locator("[data-testid=card-tail] span[style]").count()).toBe(0);
  expect(await app.page.locator("[data-testid=card-tail] .md-file").count()).toBe(0);
});

test("a mermaid fence is drawn as a picture, and one that is not a diagram stays code", async () => {
  const s = seed(
    "```mermaid\nflowchart LR\n  A[open] --> B{chat}\n  B --> C[files]\n```\n\n```mermaid\nthis is not a diagram\n```",
  );
  const chat = await open(s);
  const blocked: string[] = [];
  chat.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text());
  });
  const diagram = chat.getByTestId("diagram");
  await expect(diagram).toHaveCount(1, { timeout: 20_000 });
  await expect
    .poll(() => diagram.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(50);
  await expect(chat.locator('code[data-lang="mermaid"]')).toContainText(
    "Could not draw this diagram",
  );
  expect(blocked).toEqual([]);
});

/** what Open hands to the Mac, kept in main instead: a test never opens Preview on the desk */
async function stubOpen(electron: ElectronApplication, answer = "") {
  await electron.evaluate(({ shell }, why) => {
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    shell.openPath = async (file) => {
      g.opened.push(file);
      return why;
    };
  }, answer);
}

const opened = (electron: ElectronApplication) =>
  electron.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);

test("a video opens in the viewer, plays only when asked, seeks, and opens in the Mac's app", async () => {
  const s = seed("");
  mkdirSync(path.join(s.root, "artifacts"), { recursive: true });
  // 4s of h264, 160x90, made once with ffmpeg
  const clip = path.join(s.root, "artifacts", "clip.mp4");
  copyFileSync(path.join(import.meta.dirname, "fixtures", "clip.mp4"), clip);
  const chat = await open(s);
  const blocked: string[] = [];
  chat.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text());
  });
  await chat.getByTestId("chat-files").click();
  await chat.getByTestId("file-item").filter({ hasText: "clip.mp4" }).click();
  const video = chat.getByTestId("viewer-video");
  // a duration: the scheme served it, the page's CSP let it in, and its type was a video's
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.duration)).toBeCloseTo(4, 0);
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const seeked = await video.evaluate(
    (v: HTMLVideoElement) =>
      new Promise<number>((done) => {
        v.addEventListener("seeked", () => done(v.currentTime), { once: true });
        v.currentTime = 3;
      }),
  );
  expect(seeked).toBeCloseTo(3, 0);
  expect(blocked).toEqual([]);

  // the pieces a seek asks for, from main's scheme as the page gets them
  const size = statSync(clip).size;
  const ask = (range?: string) =>
    app.app.evaluate(
      async ({ net }, o) => {
        const r = await net.fetch(o.url, o.range ? { headers: { range: o.range } } : {});
        return {
          status: r.status,
          type: r.headers.get("content-type"),
          ranges: r.headers.get("accept-ranges"),
          range: r.headers.get("content-range"),
          length: r.headers.get("content-length"),
          got: (await r.arrayBuffer()).byteLength,
        };
      },
      { url: sessionUrl(FILE_SCHEME, SID, clip), range },
    );
  expect(await ask()).toEqual({
    status: 200,
    type: "video/mp4",
    ranges: "bytes",
    range: null,
    length: String(size),
    got: size,
  });
  expect(await ask("bytes=10-19")).toMatchObject({
    status: 206,
    range: `bytes 10-19/${size}`,
    length: "10",
    got: 10,
  });
  expect(await ask("bytes=-100")).toMatchObject({
    status: 206,
    range: `bytes ${size - 100}-${size - 1}/${size}`,
    got: 100,
  });
  expect(await ask(`bytes=${size}-`)).toMatchObject({ status: 416, range: `bytes */${size}` });

  // Open: the file as it really is, to the Mac. what the Mac says back when it cannot
  await stubOpen(app.app);
  await chat.getByTestId("viewer-open").click();
  await expect.poll(() => opened(app.app)).toEqual([realpathSync(clip)]);
  await expect(chat.getByTestId("chat-error")).toHaveCount(0);
  await stubOpen(app.app, "No application knows how to open it.");
  await chat.getByTestId("viewer-open").click();
  await expect(chat.getByTestId("chat-error")).toHaveText("No application knows how to open it.");
});

/** an svg is drawn at the size it says it is */
const WIDE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="1500"><rect width="3000" height="1500" fill="#0b817d"/><rect x="1400" y="700" width="200" height="100" fill="#fff"/></svg>';

test("a big image opens at its own size on a click and fits again on the next, a small one stays", async () => {
  const s = seed("");
  const wide = path.join(s.root, "art", "wide.svg");
  const plan = path.join(s.root, "art", "notes.md");
  writeFileSync(wide, WIDE);
  writeFileSync(plan, "# notes");
  appendTurn(
    s.file,
    { sessionId: SID, cwd: s.root },
    {
      prompt: "draw it big",
      tools: [
        { name: "Write", input: { file_path: wide, content: "x" } },
        { name: "Read", input: { file_path: path.join(s.root, "art", "shot.png") } },
        { name: "Write", input: { file_path: plan, content: "x" } },
      ],
      reply: "Drew it.",
    },
  );
  const chat = await open(s);
  const cards = chat.getByTestId("output-card");
  await expect(cards).toHaveCount(3);
  const image = chat.getByTestId("viewer-image");
  /** how wide it is against the panel that scrolls it, and the pointer over it */
  const fit = () =>
    image.evaluate((img: HTMLImageElement) => {
      const box = img.parentElement as HTMLElement;
      return {
        natural: img.naturalWidth,
        wider: img.getBoundingClientRect().width > box.clientWidth,
        scrolls: box.scrollWidth > box.clientWidth,
        cursor: getComputedStyle(img).cursor,
      };
    });

  const FITTED = { natural: 3000, wider: false, scrolls: false, cursor: "zoom-in" };
  const ZOOMED = { natural: 3000, wider: true, scrolls: true, cursor: "zoom-out" };

  await cards.filter({ hasText: "wide.svg" }).click();
  await expect.poll(fit).toEqual(FITTED);
  await expect(chat.getByTestId("viewer-open")).toBeVisible();
  await image.click();
  await expect(image).toHaveAttribute("data-zoomed", "true");
  await expect.poll(fit).toEqual(ZOOMED);
  await image.click();
  await expect.poll(fit).toEqual(FITTED);

  // zoomed, then another file: that one is fitted, and so is this one when it comes back
  await image.click();
  await expect(image).toHaveAttribute("data-zoomed", "true");
  await cards.filter({ hasText: "shot.png" }).click();
  await expect(chat.getByTestId("viewer")).toHaveAttribute("data-file", /shot\.png$/);
  // a 2x2 image has nothing to zoom into
  await expect.poll(fit).toMatchObject({ natural: 2, cursor: "default" });
  await image.click();
  await expect(image).not.toHaveAttribute("data-zoomed");
  await expect(chat.getByTestId("viewer-open")).toBeVisible();
  await cards.filter({ hasText: "wide.svg" }).click();
  await expect.poll(fit).toEqual(FITTED);

  // no Open for words: a .md or a .ts would open in an editor
  await cards.filter({ hasText: "notes.md" }).click();
  await expect(chat.getByTestId("viewer-text")).toContainText("notes");
  await expect(chat.getByTestId("viewer-open")).toHaveCount(0);
});
