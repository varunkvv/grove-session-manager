import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeRun, RunClaude } from "../../src/main/services/background.ts";
import { RECAP_FILE, RecapService, recapArgs, standing } from "../../src/main/services/recaps.ts";
import type { SessionRow } from "../../src/shared/ipc.ts";

const NOW = Date.parse("2026-10-08T18:00:00.000Z");
const REPLY =
  "goal: point staging at okta\n\ndone: registered the app\n\nstate: waiting on you\n\nneeds: pick the tenant\n";
const LINES = {
  goal: "point staging at okta",
  done: "registered the app",
  state: "waiting on you",
  needs: "pick the tenant",
};

const sandbox = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-recaps-")));
const jsonl = (lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
let n = 0;
const typed = (text: string) => ({
  type: "user",
  uuid: `u${++n}`,
  timestamp: new Date(NOW + n * 1000).toISOString(),
  origin: { kind: "human" },
  message: { role: "user", content: [{ type: "text", text }] },
});
const said = (text: string) => ({
  type: "assistant",
  uuid: `a${++n}`,
  timestamp: new Date(NOW + n * 1000).toISOString(),
  message: { id: `m${n}`, model: "claude-opus-5", content: [{ type: "text", text }] },
});

/** a transcript on disk and its row */
function session(dir: string, id: string, o: Partial<SessionRow> = {}): SessionRow {
  const key = path.join(dir, `${id}.jsonl`);
  writeFileSync(
    key,
    jsonl([typed(`what ${id} was asked`), said(`what ${id} said. Which tenant?`)]),
  );
  return { key, sessionId: id, projectLabel: "p", activityMs: NOW, parsed: true, title: id, ...o };
}

function harness(o: { reply?: (input: string) => ClaudeRun | Promise<ClaudeRun> } = {}) {
  const dir = sandbox();
  const calls: Array<{ bin: string; args: readonly string[]; cwd: string; input?: string }> = [];
  const state = { enabled: true, now: NOW, changes: 0 };
  const run: RunClaude = async (bin, args, opts) => {
    calls.push({ bin, args, cwd: opts.cwd, input: opts.input });
    return (await o.reply?.(opts.input ?? "")) ?? { code: 0, stdout: REPLY, stderr: "" };
  };
  const make = () =>
    new RecapService({
      stateDir: dir,
      claudeBin: async () => "/bin/claude",
      env: async () => ({ PATH: "/usr/bin" }),
      enabled: () => state.enabled,
      onChange: () => state.changes++,
      run,
      now: () => state.now,
    });
  return { dir, calls, state, make, svc: make() };
}

describe("a session's recap", () => {
  it("the invocation is the one that was verified by hand", () => {
    expect(recapArgs()).toEqual([
      "-p",
      "--model",
      "claude-haiku-4-5-20251001",
      "--no-session-persistence",
      "--restricted",
      "--strict-mcp-config",
      "--permission-prompts",
      "none",
      "--tools",
      "",
    ]);
  });

  it("is written from a digest on stdin, in a temp dir that is nobody's repo", async () => {
    const h = harness();
    const row = session(h.dir, "s1", { live: { state: "waiting", at: NOW, lastEventAt: NOW } });
    expect(h.svc.view(row.key)).toBeUndefined();
    await h.svc.want(row);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.bin).toBe("/bin/claude");
    expect(call.args).toEqual(recapArgs());
    expect(call.cwd).toBe(path.join(os.tmpdir(), "grove-recap"));
    expect(call.input).toContain("title: s1");
    expect(call.input).toContain("  - what s1 was asked");
    expect(call.input).toContain("what s1 said. Which tenant?");
    expect(call.input).toContain("right now: its turn is over");
    expect(call.input).not.toContain('"type":"assistant"');
    expect(h.svc.view(row.key)).toEqual({ lines: LINES, at: NOW });
    // told once that one is being written, and once that it is there
    expect(h.state.changes).toBe(2);
  });

  it("is kept across a restart, and old only when the conversation moved", async () => {
    const h = harness();
    const row = session(h.dir, "s1");
    await h.svc.want(row);
    const kept = JSON.parse(readFileSync(path.join(h.dir, RECAP_FILE), "utf8"));
    expect(kept[row.key]).toMatchObject({ ...LINES, at: NOW });

    const next = h.make();
    await next.load();
    expect(next.view(row.key)).toEqual({ lines: LINES, at: NOW });
    await next.want(row);
    expect(h.calls).toHaveLength(1);

    // what Claude Code appends long after a turn is over: the file grows, nothing was said
    appendFileSync(
      row.key,
      jsonl([{ type: "last-prompt", lastPrompt: "x" }, { type: "cost-state" }]),
    );
    await next.want(row);
    expect(h.calls).toHaveLength(1);

    appendFileSync(
      row.key,
      jsonl([typed("the dev tenant"), said("Done. It is on the dev tenant.")]),
    );
    h.state.now = NOW + 60_000;
    await next.want(row);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.input).toContain("Done. It is on the dev tenant.");
    expect(next.view(row.key)).toEqual({ lines: LINES, at: NOW + 60_000 });
  });

  it("runs two calls at once and no more", async () => {
    let open = 0;
    let most = 0;
    const waiting: Array<() => void> = [];
    const h = harness({
      reply: async () => {
        most = Math.max(most, ++open);
        await new Promise<void>((r) => waiting.push(r));
        open--;
        return { code: 0, stdout: REPLY, stderr: "" };
      },
    });
    const rows = ["a", "b", "c", "d", "e"].map((id) => session(h.dir, id));
    const all = Promise.all(rows.map((r) => h.svc.want(r)));
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    expect(h.calls).toHaveLength(2);
    // the ones in line say so, with nothing to show yet
    expect(rows.map((r) => h.svc.view(r.key))).toEqual(rows.map(() => ({ writing: true })));
    while (waiting.length) {
      waiting.shift()?.();
      await settle();
    }
    await all;
    expect(h.calls).toHaveLength(5);
    expect(most).toBe(2);
    expect(rows.every((r) => h.svc.view(r.key)?.lines && !h.svc.view(r.key)?.writing)).toBe(true);
  });

  it("writes nothing and shows nothing while the switch is off", async () => {
    const h = harness();
    const row = session(h.dir, "s1");
    await h.svc.want(row);
    h.state.enabled = false;
    expect(h.svc.view(row.key)).toBeUndefined();
    await h.svc.want(row, { again: true });
    await h.svc.want(session(h.dir, "s2"));
    expect(h.calls).toHaveLength(1);
    h.state.enabled = true;
    expect(h.svc.view(row.key)).toEqual({ lines: LINES, at: NOW });
  });

  it("is never written for a session that is working", async () => {
    const h = harness();
    const row = session(h.dir, "s1", { live: { state: "running", at: NOW, lastEventAt: NOW } });
    await h.svc.want(row);
    await h.svc.want(row, { again: true });
    expect(h.calls).toHaveLength(0);
  });

  it("a call that failed or said anything else is no recap, and is not made again at once", async () => {
    const replies: ClaudeRun[] = [
      { code: 1, stdout: "", stderr: "Not logged in" },
      { code: null, stdout: "", stderr: "timed out" },
      { code: 0, stdout: "I cannot summarise this.", stderr: "" },
      // exit 1 with the four lines on stdout: only exit 0 counts
      { code: 1, stdout: REPLY, stderr: "" },
    ];
    for (const reply of replies) {
      const h = harness({ reply: () => reply });
      const row = session(h.dir, "s1");
      await h.svc.want(row);
      expect(h.svc.view(row.key)).toBeUndefined();
      // the panel opens again: nothing has been said since, so nothing is asked
      await h.svc.want(row);
      expect(h.calls).toHaveLength(1);
      // a minute on it is tried again, and so it is when the person asks or the session moves
      h.state.now += 61_000;
      await h.svc.want(row);
      expect(h.calls).toHaveLength(2);
      await h.svc.want(row, { again: true });
      expect(h.calls).toHaveLength(3);
      appendFileSync(row.key, jsonl([typed("and now?")]));
      await h.svc.want(row);
      expect(h.calls).toHaveLength(4);
    }
  });

  it("is taken to be old when its session starts needing the person, until the transcript says", async () => {
    const waiting: Array<() => void> = [];
    let hold = false;
    const h = harness({
      reply: async () => {
        if (hold) await new Promise<void>((r) => waiting.push(r));
        return {
          code: 0,
          stdout: REPLY.replace("pick the tenant", `call ${h.calls.length}`),
          stderr: "",
        };
      },
    });
    const row = session(h.dir, "s1");
    await h.svc.want(row);
    // it comes into the inbox again and nothing was said: old for as long as the look takes
    const look = h.svc.want(row, { moved: true });
    expect(h.svc.view(row.key)).toMatchObject({ old: true, lines: { needs: "call 1" } });
    await look;
    expect(h.svc.view(row.key)).toEqual({ lines: { ...LINES, needs: "call 1" }, at: NOW });
    expect(h.calls).toHaveLength(1);

    // it moved: the old lines stay in sight, marked, while new ones are written
    appendFileSync(row.key, jsonl([typed("the dev tenant"), said("On it.")]));
    hold = true;
    const write = h.svc.want(row, { moved: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.svc.view(row.key)).toMatchObject({
      old: true,
      writing: true,
      lines: { needs: "call 1" },
    });
    // and it moves again before the answer is back: looked at once more when it is
    appendFileSync(row.key, jsonl([typed("no, prod"), said("Prod it is.")]));
    void h.svc.want(row, { moved: true });
    waiting.shift()?.();
    await write;
    await new Promise((r) => setTimeout(r, 20));
    expect(h.calls).toHaveLength(3);
    waiting.shift()?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.svc.view(row.key)).toEqual({ lines: { ...LINES, needs: "call 3" }, at: NOW });
  });

  it("gives a notification its line when it is there in time, and nothing when it is not", async () => {
    let wait = 0;
    const h = harness({
      reply: async () => {
        await new Promise((r) => setTimeout(r, wait));
        return { code: 0, stdout: REPLY, stderr: "" };
      },
    });
    expect(await h.svc.soon(session(h.dir, "quick"), 200)).toBe("pick the tenant");
    wait = 120;
    const slow = session(h.dir, "slow");
    expect(await h.svc.soon(slow, 20)).toBeUndefined();
    // it is still written, for the row and the panel
    await new Promise((r) => setTimeout(r, 200));
    expect(h.svc.view(slow.key)?.lines).toEqual(LINES);
    h.state.enabled = false;
    expect(await h.svc.soon(session(h.dir, "off"), 5000)).toBeUndefined();
  });

  it("keeps what it has when the transcript is gone", async () => {
    const h = harness();
    const row = session(h.dir, "s1");
    await h.svc.want(row);
    await h.svc.want({ ...row, key: path.join(h.dir, "gone.jsonl") });
    writeFileSync(row.key, "");
    await h.svc.want(row, { moved: true });
    expect(h.calls).toHaveLength(1);
    expect(h.svc.view(row.key)?.lines).toEqual(LINES);
  });

  it("keeps the newest 500", async () => {
    const h = harness();
    const old = Object.fromEntries(
      Array.from({ length: 520 }, (_, i) => [`/old/${i}.jsonl`, { ...LINES, at: i, end: 9 }]),
    );
    writeFileSync(path.join(h.dir, RECAP_FILE), JSON.stringify({ ...old, junk: { goal: 1 } }));
    const svc = h.make();
    await svc.load();
    await svc.want(session(h.dir, "s1"));
    await new Promise((r) => setTimeout(r, 20));
    const kept = Object.keys(JSON.parse(readFileSync(path.join(h.dir, RECAP_FILE), "utf8")));
    expect(kept).toHaveLength(500);
    expect(kept).not.toContain("/old/20.jsonl");
    expect(kept).toContain("/old/21.jsonl");
    expect(kept).not.toContain("junk");
  });

  it("tells the model what grove itself knows about where a session stands", () => {
    const at = { at: NOW, lastEventAt: NOW };
    expect(standing({})).toBeUndefined();
    expect(standing({ live: { state: "running", ...at } })).toBeUndefined();
    expect(standing({ live: { state: "waiting", ...at } })).toMatch(/^its turn is over/);
    expect(
      standing({ live: { state: "permission", detail: "Bash", target: "pnpm test", ...at } }),
    ).toBe("it is waiting for the person to allow a tool call: Bash pnpm test");
    expect(standing({ live: { state: "failed", detail: "API Error: 529", ...at } })).toBe(
      "it stopped on an error: API Error: 529",
    );
    // its process is gone, whatever its status said before
    expect(
      standing({ live: { state: "waiting", ...at }, interrupted: { why: "gone", at: NOW } }),
    ).toMatch(/^it stopped mid-turn/);
    expect(standing({ interrupted: { why: "failed" } })).toMatch(/^its background run failed/);
  });
});
