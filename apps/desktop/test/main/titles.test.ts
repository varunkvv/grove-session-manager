import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeRun, RunClaude } from "../../src/main/services/background.ts";
import { recapArgs, Slots } from "../../src/main/services/recaps.ts";
import { TITLE_FILE, TitleService, theirs } from "../../src/main/services/titles.ts";
import type { SessionRow } from "../../src/shared/ipc.ts";

const NOW = Date.parse("2026-10-14T18:00:00.000Z");
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const NAME =
  "title: Fix the flaky watch test\n\ndescription: Finds why the watch test fails on CI.\n";

const sandbox = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-titles-")));
let n = 0;
const at = () => new Date(NOW + ++n * 1000).toISOString();
const typed = (text: string) => ({
  type: "user",
  uuid: `u${n}`,
  timestamp: at(),
  origin: { kind: "human" },
  message: { role: "user", content: [{ type: "text", text }] },
});
const tool = () => ({
  type: "assistant",
  uuid: `a${n}`,
  timestamp: at(),
  message: {
    id: `m${n}`,
    model: "claude-opus-5",
    content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: "ls" } }],
  },
});
const said = (text: string) => ({
  type: "assistant",
  uuid: `a${n}`,
  timestamp: at(),
  message: { id: `m${n}`, model: "claude-opus-5", content: [{ type: "text", text }] },
});
/** a turn: what was typed, a tool call when it worked, and an answer */
const turn = (text: string, worked = true) =>
  [typed(text), ...(worked ? [tool()] : []), said(`done with ${text}`)]
    .map((l) => JSON.stringify(l))
    .join("\n")
    .concat("\n");

function harness(o: { reply?: (input: string) => ClaudeRun } = {}) {
  const dir = sandbox();
  const key = path.join(dir, `${SID}.jsonl`);
  const calls: string[] = [];
  const state = { enabled: true, renames: true, now: NOW, changes: 0 };
  const run: RunClaude = async (_bin, args, opts) => {
    expect(args).toEqual(recapArgs());
    calls.push(opts.input ?? "");
    return o.reply?.(opts.input ?? "") ?? { code: 0, stdout: NAME, stderr: "" };
  };
  const make = () =>
    new TitleService({
      stateDir: dir,
      claudeBin: async () => "/bin/claude",
      env: async () => ({}),
      enabled: () => state.enabled,
      renames: () => state.renames,
      onChange: () => state.changes++,
      slots: new Slots(),
      run,
      now: () => state.now,
    });
  /** the row, as the transcript stands and as Claude Code calls it */
  const row = (o: Partial<SessionRow> = {}): SessionRow => ({
    key,
    sessionId: SID,
    projectLabel: "p",
    activityMs: Date.parse(at()),
    parsed: true,
    title: "fix the watch test",
    titleSource: "aiTitle",
    ...o,
  });
  const pending = path.join(dir, "titles", "pending", SID);
  return { dir, key, calls, state, make, row, pending, svc: make() };
}

describe("a session's title and description", () => {
  it("is written once a turn did some work, and handed to Claude Code through a pending file", async () => {
    const h = harness();
    writeFileSync(h.key, turn("hey", false));
    await h.svc.want(h.row(), () => []);
    // a hello: Claude Code's own title covers it
    expect(h.calls).toHaveLength(0);

    appendFileSync(h.key, turn("fix the watch test"));
    await h.svc.want(h.row(), () => ["Release 0.16"]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toContain("  - Release 0.16");
    expect(h.calls[0]).toContain("title: (none)");
    const name = {
      title: "Fix the flaky watch test",
      description: "Finds why the watch test fails on CI.",
    };
    expect(h.svc.named(h.row())).toEqual(name);
    expect(h.state.changes).toBe(1);
    expect(readFileSync(h.pending, "utf8")).toBe('"Fix the flaky watch test"\n');
    const kept = JSON.parse(readFileSync(path.join(h.dir, TITLE_FILE), "utf8"))[SID];
    expect(kept).toEqual({ ...name, at: NOW, prompts: 2, compacts: 0, titles: [name.title] });

    // once Claude Code has it, nothing is pending
    h.svc.named({ sessionId: SID, title: name.title, titleSource: "customTitle" });
    await expect.poll(() => existsSync(h.pending)).toBe(false);

    // and it is all there after a restart
    const next = h.make();
    await next.load();
    expect(next.named(h.row())).toEqual(name);
  });

  it("is looked at again only when the prompts have doubled, and a same keeps it", async () => {
    const h = harness({
      reply: (input) =>
        input.includes("title: Fix the flaky watch test")
          ? { code: 0, stdout: "same\n", stderr: "" }
          : { code: 0, stdout: NAME, stderr: "" },
    });
    writeFileSync(h.key, turn("p1"));
    await h.svc.want(h.row(), () => []);
    expect(h.calls).toHaveLength(1);
    // the same row again is not even read. a moved one with 2 prompts is not due
    const same = h.row();
    await h.svc.want(same, () => []);
    await h.svc.want(same, () => []);
    appendFileSync(h.key, turn("p2"));
    await h.svc.want(h.row(), () => []);
    expect(h.calls).toHaveLength(1);
    appendFileSync(h.key, turn("p3"));
    await h.svc.want(h.row(), () => []);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toContain("reply with the single word same");
    expect(h.svc.named(h.row())?.title).toBe("Fix the flaky watch test");
    expect(h.state.changes).toBe(1);
    const kept = JSON.parse(readFileSync(path.join(h.dir, TITLE_FILE), "utf8"))[SID];
    expect(kept.prompts).toBe(3);
    // never while a turn runs
    appendFileSync(h.key, turn("p4") + turn("p5") + turn("p6"));
    await h.svc.want(h.row({ live: { state: "running", at: NOW, lastEventAt: NOW } }), () => []);
    expect(h.calls).toHaveLength(2);
    await h.svc.want(h.row(), () => []);
    expect(h.calls).toHaveLength(3);
  });

  it("a new title gets broader, and the hook may replace the one grove gave before", async () => {
    let reply = NAME;
    const h = harness({ reply: () => ({ code: 0, stdout: reply, stderr: "" }) });
    writeFileSync(h.key, turn("p1"));
    await h.svc.want(h.row(), () => []);
    reply = "title: Ship the watch fix in 0.16\ndescription: Fixes the watch test and releases it.";
    appendFileSync(h.key, turn("p2") + turn("p3"));
    await h.svc.want(
      h.row({ title: "Fix the flaky watch test", titleSource: "customTitle" }),
      () => [],
    );
    expect(readFileSync(h.pending, "utf8")).toBe(
      '"Ship the watch fix in 0.16"\n"Fix the flaky watch test"\n',
    );
    // Claude Code still has the first: grove shows its newest, and it stays pending
    const shown = h.svc.named({
      sessionId: SID,
      title: "Fix the flaky watch test",
      titleSource: "customTitle",
    });
    expect(shown?.title).toBe("Ship the watch fix in 0.16");
    expect(existsSync(h.pending)).toBe(true);
  });

  it("a name the person gave it wins for good, and its description is still written", async () => {
    let reply = NAME;
    const h = harness({ reply: () => ({ code: 0, stdout: reply, stderr: "" }) });
    writeFileSync(h.key, turn("p1"));
    const mine = { title: "my okta thing", titleSource: "customTitle" as const };
    expect(theirs({ sessionId: SID, ...mine })).toBe(true);
    await h.svc.want(h.row(mine), () => []);
    expect(h.svc.named({ sessionId: SID, ...mine })).toEqual({
      description: "Finds why the watch test fails on CI.",
    });
    expect(existsSync(h.pending)).toBe(false);
    expect(h.calls[0]).not.toContain("same");

    // renamed after grove titled it: grove's name is no longer shown or handed over
    reply = "title: Something new\ndescription: Broader now.";
    appendFileSync(h.key, turn("p2") + turn("p3"));
    await h.svc.want(h.row(mine), () => []);
    expect(h.calls[1]).toContain("title: my okta thing");
    expect(h.svc.named({ sessionId: SID, ...mine })).toEqual({ description: "Broader now." });
    expect(existsSync(h.pending)).toBe(false);
    // an agent name is the same as a custom title
    expect(theirs({ sessionId: SID, title: "x", titleSource: "agentName" })).toBe(true);
    expect(theirs({ sessionId: SID, title: "x", titleSource: "aiTitle" })).toBe(false);
  });

  it("an answer that is not the two lines is no name, and the row stays as it was", async () => {
    const h = harness({ reply: () => ({ code: 0, stdout: "I am not sure.", stderr: "" }) });
    writeFileSync(h.key, turn("p1"));
    await h.svc.want(h.row(), () => []);
    expect(h.calls).toHaveLength(1);
    expect(h.svc.named(h.row())).toBeUndefined();
    expect(existsSync(path.join(h.dir, TITLE_FILE))).toBe(false);
  });
});

describe("the calls through the person's login", () => {
  it("never run more than two at once, and a recap goes ahead of every title in line", async () => {
    const slots = new Slots(2);
    const order: string[] = [];
    await slots.take();
    await slots.take();
    const waiting = [
      slots.take().then(() => order.push("title 1")),
      slots.take().then(() => order.push("title 2")),
      slots.take(true).then(() => order.push("recap")),
    ];
    slots.release();
    slots.release();
    slots.release();
    await Promise.all(waiting);
    expect(order).toEqual(["recap", "title 1", "title 2"]);
  });
});
