// grove chat against the plan's speed budgets. not part of any test run: `pnpm app:perf`, after
// `pnpm app:build`. it opens real windows, like e2e, and prints a table. the numbers are wall
// clock between main and the page, which share the machine's clock.
//
// - summon: the summon key's action -> the main window painted
// - open: a chat window handed a session -> its header painted, and its last turn painted, on a
//   synthetic 8MB and ~100MB transcript (the plan's p90 and max)
// - keystroke: a key in the composer -> the frame after it
// - stream: frame times while a 2,000-line answer streams in
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { claudeProjectSlug } from "@grove/core";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { writeFakeClaude } from "../e2e/helpers/fakeClaude.ts";
import { type Fixture, makeFixture } from "../e2e/helpers/fixture.ts";
import { groveTest, launchApp, waitFor } from "../e2e/helpers/launchApp.ts";
import { writeProject } from "../e2e/helpers/project.ts";

const FIXTURES = path.join(import.meta.dirname, "../test/fixtures/chat");
const BUDGET = { summon: 100, open8: 150, open100: 500, key: 17, frame: 17 };
const RUNS = 5;
const LONG = "Write the long answer.";

/** p50, p90 and max of some milliseconds */
function stats(ms: number[]): { p50: number; p90: number; max: number } {
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN;
  return { p50: at(0.5), p90: at(0.9), max: s.at(-1) ?? Number.NaN };
}

const rows: Array<[string, string, string, string]> = [];
const row = (what: string, ms: number[], budget: number, by: "p90" | "max" = "p90") => {
  const s = stats(ms);
  const ok = s[by] <= budget;
  rows.push([
    what,
    `p50 ${s.p50.toFixed(0)} / p90 ${s.p90.toFixed(0)} / max ${s.max.toFixed(0)} ms`,
    `${by} <= ${budget}`,
    ok ? "ok" : "MISSES",
  ]);
};

/**
 * a transcript shaped like a long real one: most of its bytes are tool results. `turns` of a
 * prompt, a thought, a tool call with a 30KB result, and a closing message. the last one ends on
 * END-OF-SESSION
 */
function writeTranscript(fx: Fixture, cwd: string, sessionId: string, mb: number): string {
  const dir = path.join(fx.projectsDir, claudeProjectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const fd = openSync(file, "w");
  const env = {
    isSidechain: false,
    userType: "external",
    entrypoint: "claude-vscode",
    cwd,
    sessionId,
    version: "2.1.296",
  };
  const result = "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(520);
  const reply = (n: number) =>
    `## turn ${n}\n\nDid the thing in \`src/file${n}.ts\`:\n\n- **one** part of it\n- another part, with a [link](https://example.com)\n\n\`\`\`ts\nexport const answer${n} = ${n};\nfunction twice(x: number) {\n  return x * 2;\n}\n\`\`\`\n\nThe rest is as it was. `.repeat(
      3,
    );
  let at = Date.now() - 86_400_000;
  let n = 0;
  let bytes = 0;
  const line = (o: object) => {
    const text = `${JSON.stringify(o)}\n`;
    bytes += Buffer.byteLength(text);
    writeSync(fd, text);
  };
  const stamp = () => {
    at += 1000;
    return new Date(at).toISOString();
  };
  while (bytes < mb * 1_000_000) {
    n++;
    const id = (k: string) =>
      `${sessionId.slice(0, 8)}-${String(n).padStart(4, "0")}-4000-8000-${k.padEnd(12, "0")}`;
    line({
      type: "user",
      ...env,
      uuid: id("a"),
      timestamp: stamp(),
      origin: { kind: "human" },
      message: {
        role: "user",
        content: [{ type: "text", text: `turn ${n}: do the next thing, and tell me how it went` }],
      },
    });
    line({
      type: "assistant",
      ...env,
      uuid: id("b"),
      timestamp: stamp(),
      message: {
        role: "assistant",
        id: `msg_${n}_a`,
        model: "claude-opus-5",
        content: [
          { type: "thinking", thinking: "thinking about it. ".repeat(60) },
          {
            type: "tool_use",
            id: `toolu_${n}`,
            name: "Bash",
            input: { command: `pnpm test --filter thing${n}` },
          },
        ],
        usage: { input_tokens: 3, output_tokens: 200 },
      },
    });
    line({
      type: "user",
      ...env,
      uuid: id("c"),
      timestamp: stamp(),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: `toolu_${n}`, content: result, is_error: false },
        ],
      },
    });
    line({
      type: "assistant",
      ...env,
      uuid: id("d"),
      timestamp: stamp(),
      message: {
        role: "assistant",
        id: `msg_${n}_b`,
        model: "claude-opus-5",
        content: [{ type: "text", text: reply(n) }],
        usage: { input_tokens: 3, output_tokens: 900 },
      },
    });
  }
  n++;
  line({
    type: "user",
    ...env,
    uuid: `${sessionId.slice(0, 8)}-9999-4000-8000-a00000000000`,
    timestamp: stamp(),
    origin: { kind: "human" },
    message: { role: "user", content: [{ type: "text", text: "and the last one" }] },
  });
  line({
    type: "assistant",
    ...env,
    uuid: `${sessionId.slice(0, 8)}-9999-4000-8000-b00000000000`,
    timestamp: stamp(),
    message: {
      role: "assistant",
      id: "msg_last",
      model: "claude-opus-5",
      content: [{ type: "text", text: "Done. END-OF-SESSION" }],
      usage: { input_tokens: 3, output_tokens: 9 },
    },
  });
  line({ type: "ai-title", aiTitle: `synthetic ${mb}MB`, sessionId });
  closeSync(fd);
  return file;
}

/**
 * the recordings, with one more turn: LONG answered by 2,000 lines of markdown, one line a delta,
 * a few ms apart. built from the recorded second turn, so its messages are the real shapes
 */
function writeLongRecording(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
    copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  }
  const lines = readFileSync(path.join(FIXTURES, "turn.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const from = lines.findIndex(
    (l) => l.dir === "in" && l.msg.type === "user" && JSON.stringify(l.msg).includes("second turn"),
  );
  const turn = lines.slice(from).filter((l) => l.msg);
  const text: string[] = [];
  for (let i = 1; i <= 2000; i++) {
    if (i % 100 === 1) text.push(`## part ${Math.ceil(i / 100)}`);
    else if (i % 100 === 50) text.push("```ts");
    else if (i % 100 > 50 && i % 100 < 60)
      text.push(`const line${i}: number = ${i} * 2; // a line of code`);
    else if (i % 100 === 60) text.push("```");
    else
      text.push(
        `- line ${i} of the answer, with \`code\`, **bold** and a little more prose to wrap`,
      );
  }
  const out: object[] = [];
  let t = 0;
  for (const l of turn) {
    if (l.dir === "in" && l.msg.type === "user") {
      out.push({
        ...l,
        t,
        msg: { ...l.msg, message: { role: "user", content: [{ type: "text", text: LONG }] } },
      });
      continue;
    }
    if (l.msg.type === "stream_event" && l.msg.event?.type === "content_block_delta") {
      for (const piece of text) {
        t += 5;
        out.push({
          ...l,
          t,
          msg: {
            ...l.msg,
            event: { ...l.msg.event, delta: { type: "text_delta", text: `${piece}\n` } },
          },
        });
      }
      continue;
    }
    t += 5;
    if (l.msg.type === "assistant") {
      out.push({
        ...l,
        t,
        msg: {
          ...l.msg,
          message: { ...l.msg.message, content: [{ type: "text", text: text.join("\n") }] },
        },
      });
      continue;
    }
    out.push({ ...l, t });
  }
  writeFileSync(path.join(dir, "long.jsonl"), `${out.map((o) => JSON.stringify(o)).join("\n")}\n`);
}

/** the hidden spare: a chat page with no session yet */
async function spare(electron: ElectronApplication): Promise<Page> {
  let found: Page | undefined;
  await waitFor(async () => {
    for (const p of electron.windows()) {
      if (p.isClosed() || !p.url().includes("#/chat")) continue;
      // a window can close between the look and the ask
      const n = await p
        .locator('[data-testid="chat"]:not([data-id])')
        .count()
        .catch(() => 0);
      if (n > 0) {
        found = p;
        return true;
      }
    }
    return false;
  }, 20_000);
  return found as Page;
}

/** a chat window handed `sessionId`: ms to its header painted, and to its last turn painted */
async function timeOpen(
  electron: ElectronApplication,
  sessionId: string,
  title: string,
): Promise<[number, number]> {
  const page = await spare(electron);
  await page.evaluate(
    ([t, last]) => {
      const w = window as unknown as { __marks: Record<string, number> };
      w.__marks = {};
      const mark = (k: string) => {
        if (k in w.__marks) return;
        w.__marks[k] = 0;
        // after the frame that has it
        requestAnimationFrame(() => setTimeout(() => (w.__marks[k] = Date.now()), 0));
      };
      const check = () => {
        if (document.querySelector("h1")?.textContent === t) mark("visible");
        const texts = document.querySelectorAll('[data-testid="panel-text"]');
        if (texts[texts.length - 1]?.textContent?.includes(last as string)) mark("painted");
      };
      new MutationObserver(check).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    },
    [title, "END-OF-SESSION"],
  );
  const t0 = await electron.evaluate((_e, id) => {
    const at = Date.now();
    (globalThis as unknown as { groveTest: { reveal(id: string): void } }).groveTest.reveal(id);
    return at;
  }, sessionId);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __marks: Record<string, number> }).__marks.painted ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const marks = await page.evaluate(
    () => (window as unknown as { __marks: Record<string, number> }).__marks,
  );
  // closed, so the next open is handed a new spare. its title is the session's, then its project
  await electron.evaluate(({ BrowserWindow }, t) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === t || w.getTitle().startsWith(`${t} · `))
      ?.close();
  }, title);
  return [(marks.visible ?? Number.NaN) - t0, (marks.painted ?? Number.NaN) - t0];
}

test("grove chat against its speed budgets", async () => {
  test.setTimeout(10 * 60_000);
  const fx = makeFixture({ withCompanion: true });
  writeFileSync(path.join(fx.root, "settings.json"), JSON.stringify({ chat: true }));
  const { root } = writeProject(fx, { name: "perf" });
  const S8 = "eeeeeeee-0000-4000-8000-000000000008";
  const S100 = "eeeeeeee-0000-4000-8000-000000000100";
  writeTranscript(fx, root, S8, 8);
  writeTranscript(fx, root, S100, 100);
  const recordings = path.join(fx.dir, "recordings");
  writeLongRecording(recordings);
  const fake = writeFakeClaude(fx.dir);
  const app = await launchApp(fx, {
    GROVE_CLAUDE_BIN: fake.bin,
    GROVE_FAKE_CHAT_RECORDINGS: recordings,
    GROVE_FAKE_CHAT_DELAY_MS: "5",
  });
  const electron = app.app;
  try {
    // summon: hidden by its close button, then the key's action
    const summons: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      await groveTest(electron).closeMain();
      await waitFor(async () => !(await groveTest(electron).isMainVisible()));
      // the first frame the page draws once it is back on screen
      summons.push(
        await electron.evaluate(async ({ BrowserWindow }) => {
          const main = BrowserWindow.getAllWindows().find(
            (w) => !w.webContents.getURL().includes("#/chat"),
          );
          const at = Date.now();
          (globalThis as unknown as { groveTest: { summon(): void } }).groveTest.summon();
          const painted: number = await main?.webContents.executeJavaScript(
            "new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(Date.now()), 0)))",
          );
          return painted - at;
        }),
      );
    }
    row("summon -> main window painted", summons, BUDGET.summon);

    for (const [id, mb, budget] of [
      [S8, 8, BUDGET.open8],
      [S100, 100, BUDGET.open100],
    ] as const) {
      const visible: number[] = [];
      const painted: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const [v, p] = await timeOpen(electron, id, `synthetic ${mb}MB`);
        visible.push(v);
        painted.push(p);
      }
      row(`open ${mb}MB -> header painted (spare)`, visible, budget);
      row(`open ${mb}MB -> last turns painted`, painted, budget);
    }

    // a key in the composer -> the frame after it. the 8MB session: a long conversation re-renders
    await spare(electron);
    await groveTest(electron).reveal(S8);
    let chat: Page | undefined;
    await waitFor(async () => {
      for (const p of electron.windows()) {
        if (
          !p.isClosed() &&
          (await p.locator(`[data-testid="chat"][data-id="${S8}"]`).count()) > 0
        ) {
          chat = p;
          return true;
        }
      }
      return false;
    });
    const c = chat as Page;
    await expect(c.getByTestId("panel-text").last()).toContainText("END-OF-SESSION");
    await c.evaluate(() => {
      const w = window as unknown as { __keys: number[] };
      w.__keys = [];
      const box = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement;
      box.addEventListener("keydown", (e) => {
        const at = e.timeStamp;
        requestAnimationFrame(() => setTimeout(() => w.__keys.push(performance.now() - at), 0));
      });
    });
    await c
      .getByTestId("composer")
      .pressSequentially("a typed line to see the latency of the composer", { delay: 40 });
    await c.waitForTimeout(300);
    row(
      "keystroke -> next frame (8MB open)",
      await c.evaluate(() => (window as unknown as { __keys: number[] }).__keys),
      BUDGET.key,
    );

    // streaming a 2,000-line answer
    await c.getByTestId("composer").fill(LONG);
    await c.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __long: number[]; __on: boolean };
      w.__frames = [];
      w.__long = [];
      w.__on = true;
      let last = performance.now();
      const tick = (t: number) => {
        w.__frames.push(t - last);
        last = t;
        if (w.__on) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__long.push(e.duration);
      }).observe({ type: "longtask" });
    });
    const started = Date.now();
    await c.getByTestId("composer").press("Enter");
    await expect(c.getByTestId("state")).toHaveAttribute("data-state", "working", {
      timeout: 20_000,
    });
    await expect(c.getByTestId("state")).toHaveCount(0, { timeout: 120_000 });
    const took = Date.now() - started;
    await expect(c.getByTestId("panel-text").last()).toContainText("line 2000 of the answer");
    const { frames, long } = await c.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __long: number[]; __on: boolean };
      w.__on = false;
      return { frames: w.__frames, long: w.__long };
    });
    row(`stream 2,000 lines (${(took / 1000).toFixed(1)}s): frame time`, frames, BUDGET.frame);
    rows.push([
      "stream: long tasks (>50ms)",
      `${long.length}, longest ${Math.max(0, ...long).toFixed(0)} ms, ${frames.filter((f) => f > 50).length} frames over 50ms of ${frames.length}`,
      "",
      "",
    ]);
  } finally {
    await app.close();
    const width = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)));
    const out = rows.map((r) => r.map((c, i) => c.padEnd(width[i] ?? 0)).join("  ")).join("\n");
    process.stdout.write(`\ngrove chat speed (${new Date().toISOString()})\n${out}\n`);
    if (process.env.GROVE_PERF_OUT) writeFileSync(process.env.GROVE_PERF_OUT, `${out}\n`);
  }
});
