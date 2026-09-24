import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackgroundEntry } from "@grove/core";
import { describe, expect, it } from "vitest";
import {
  fakeClaudeCalls,
  setFakeAgents,
  setUntrusted,
  writeFakeClaude,
} from "../../e2e/helpers/fakeClaude.ts";
import {
  AGENTS_ARGS,
  BackgroundService,
  type ClaudeRun,
  type RunClaude,
  runClaude,
} from "../../src/main/services/background.ts";

const SID = {
  a: "aaaaaaaa-0000-4000-8000-000000000001",
  b: "bbbbbbbb-0000-4000-8000-000000000002",
};

const sandbox = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-bg-")));

const ROWS = [
  { pid: 1, kind: "interactive", sessionId: SID.b, status: "idle", cwd: "/ws" },
  {
    pid: 4112,
    id: "d7b6bcc2",
    sessionId: SID.a,
    kind: "background",
    status: "busy",
    state: "working",
  },
];

function service(o: { bin: string; enabled?: () => boolean; run?: RunClaude }) {
  const seen: Array<ReadonlyMap<string, BackgroundEntry>> = [];
  const bg = new BackgroundService({
    claudeBin: async () => o.bin,
    env: async () => ({ PATH: "/usr/bin:/bin" }),
    enabled: o.enabled ?? (() => true),
    onEntries: (entries) => seen.push(entries),
    ...(o.run ? { run: o.run } : {}),
  });
  return { bg, seen };
}

describe("reading the background sessions", () => {
  it("asks `claude agents --json --all` and keeps the background rows by session id", async () => {
    const fake = writeFakeClaude(sandbox(), ROWS);
    const { bg, seen } = service({ bin: fake.bin });
    const entries = await bg.read();
    expect([...(entries?.keys() ?? [])]).toEqual([SID.a]);
    expect(bg.get(SID.a)).toMatchObject({ id: "d7b6bcc2", pid: 4112, state: "working" });
    expect(bg.get(SID.b)).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(fakeClaudeCalls(fake).map((c) => c.argv)).toEqual([[...AGENTS_ARGS]]);
  });

  it("an answer it cannot read is unknown: the last one stands and nobody is told", async () => {
    const fake = writeFakeClaude(sandbox(), ROWS);
    const { bg, seen } = service({ bin: fake.bin });
    await bg.read();
    for (const bad of [[], "not json"]) {
      setFakeAgents(fake, bad as unknown[]);
      expect(await bg.read()).toBeNull();
    }
    expect(bg.get(SID.a)?.id).toBe("d7b6bcc2");
    expect(seen).toHaveLength(1);
    // interactive rows only is a real answer: nothing in the background
    setFakeAgents(fake, [ROWS[0]]);
    expect((await bg.read())?.size).toBe(0);
    expect(bg.get(SID.a)).toBeUndefined();
    expect(seen).toHaveLength(2);
  });

  it("a claude that is not there, fails or hangs is unknown too", async () => {
    const dir = sandbox();
    const { bg } = service({ bin: path.join(dir, "nope") });
    expect(await bg.read()).toBeNull();
    const failing = service({
      bin: "/bin/x",
      run: async () => ({ code: 1, stdout: "[]", stderr: "boom" }),
    });
    expect(await failing.bg.read()).toBeNull();
    const killed = service({
      bin: "/bin/x",
      run: async () => ({ code: null, stdout: JSON.stringify(ROWS), stderr: "" }),
    });
    expect(await killed.bg.read()).toBeNull();
  });

  it("a test root without a stub never runs anything", async () => {
    const fake = writeFakeClaude(sandbox(), ROWS);
    const { bg } = service({ bin: fake.bin, enabled: () => false });
    expect(await bg.read()).toBeNull();
    expect(fakeClaudeCalls(fake)).toEqual([]);
  });

  it("one read at a time, and a call during one gets a read that started after it", async () => {
    let calls = 0;
    const gates: Array<() => void> = [];
    const run: RunClaude = () =>
      new Promise<ClaudeRun>((resolve) => {
        const n = ++calls;
        gates.push(() =>
          resolve({
            code: 0,
            stdout: JSON.stringify([{ ...ROWS[1], state: n === 1 ? "working" : "done" }]),
            stderr: "",
          }),
        );
      });
    const { bg } = service({ bin: "/bin/x", run });
    const first = bg.read();
    await new Promise((r) => setTimeout(r, 0));
    const second = bg.read();
    const third = bg.read();
    expect(second).toBe(third);
    expect(calls).toBe(1);
    gates.shift()?.();
    expect((await first)?.get(SID.a)?.state).toBe("working");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    gates.shift()?.();
    expect((await second)?.get(SID.a)?.state).toBe("done");
    expect(calls).toBe(2);
  });

  it("runs argv with no shell, and a failure comes back as a value", async () => {
    const out = await runClaude("/bin/echo", ["a b", "'$HOME'"], {
      cwd: os.tmpdir(),
      env: {},
      timeoutMs: 5000,
    });
    expect(out).toEqual({ code: 0, stdout: "a b '$HOME'\n", stderr: "" });
    const missing = await runClaude("/nope/claude", [], {
      cwd: os.tmpdir(),
      env: {},
      timeoutMs: 5000,
    });
    expect(missing.code).toBeNull();
    expect(missing.stderr).toMatch(/ENOENT/);
    const failed = await runClaude("/bin/sh", ["-c", "echo no >&2; exit 3"], {
      cwd: os.tmpdir(),
      env: {},
      timeoutMs: 5000,
    });
    expect(failed).toEqual({ code: 3, stdout: "", stderr: "no\n" });
  });
});

describe("stopping a background session", () => {
  const held = {
    pid: 4112,
    id: "d7b6bcc2",
    sessionId: SID.a,
    kind: "background",
    status: "busy",
    state: "working",
  };

  it("runs `claude stop <id>`, never rm, and waits until the supervisor lets go", async () => {
    const fake = writeFakeClaude(sandbox(), [held]);
    const { bg } = service({ bin: fake.bin });
    await bg.read();
    expect(bg.get(SID.a)?.pid).toBe(4112);
    const out = await bg.stop("d7b6bcc2");
    expect(out.code).toBe(0);
    expect(await bg.waitReleased(SID.a, 2000, 10)).toBe(true);
    expect(bg.get(SID.a)).toMatchObject({ state: "stopped" });
    expect(bg.get(SID.a)?.pid).toBeUndefined();
    const argv = fakeClaudeCalls(fake).map((c) => c.argv);
    expect(argv).toContainEqual(["stop", "d7b6bcc2"]);
    expect(argv.flat()).not.toContain("rm");
  });

  it("gives up at the deadline while the worker is still there", async () => {
    const fake = writeFakeClaude(sandbox(), [held]);
    const { bg } = service({ bin: fake.bin });
    expect(await bg.waitReleased(SID.a, 100, 10)).toBe(false);
  });
});

describe("handing a session to the supervisor", () => {
  it("builds argv with the prompt after `--`, and no permission flags", async () => {
    const { continueArgs, newSessionArgs } = await import("../../src/main/services/background.ts");
    expect(continueArgs(SID.a, "--dangerously-skip-permissions")).toEqual([
      "--resume",
      SID.a,
      "--bg",
      "--",
      "--dangerously-skip-permissions",
    ]);
    expect(newSessionArgs("do it")).toEqual(["--bg", "--", "do it"]);
    expect(newSessionArgs("do it", "-x name")).toEqual(["--bg", "--name=-x name", "--", "do it"]);
    const all = [...continueArgs(SID.a, "x"), ...newSessionArgs("x", "n")].join(" ");
    expect(all).not.toMatch(/permission|dangerously|skip/);
  });

  it("reads the short id from the supervisor, and from the printed line when it has to", async () => {
    const { backgroundedId, isNotTrusted } = await import("../../src/main/services/background.ts");
    expect(backgroundedId("backgrounded · d7b6bcc2\n")).toBe("d7b6bcc2");
    expect(backgroundedId("\x1b[2mbackgrounded · 60221e3b\x1b[0m")).toBe("60221e3b");
    expect(backgroundedId("something else")).toBeUndefined();
    const refusal =
      "Workspace not trusted. Run `claude` in /ws/combo once and accept the trust prompt, then retry.\n";
    expect(isNotTrusted({ code: 1, stdout: "", stderr: refusal })).toBe(true);
    expect(isNotTrusted({ code: 1, stdout: "", stderr: "API Error" })).toBe(false);
    expect(isNotTrusted({ code: 0, stdout: refusal, stderr: "" })).toBe(false);
  });

  it("continues under the same id, in the session's folder, with the env it was given", async () => {
    const { continueArgs } = await import("../../src/main/services/background.ts");
    const dir = sandbox();
    const fake = writeFakeClaude(dir, []);
    const { bg, seen } = service({ bin: fake.bin });
    const res = await bg.dispatch(continueArgs(SID.a, "continue where you left off"), {
      cwd: dir,
      sessionId: SID.a,
    });
    expect(res).toMatchObject({ ok: true, id: "abcd1234" });
    const call = fakeClaudeCalls(fake).find((c) => c.argv.includes("--bg"));
    expect(call).toEqual({
      argv: ["--resume", SID.a, "--bg", "--", "continue where you left off"],
      cwd: dir,
      path: "/usr/bin:/bin",
    });
    // read again straight after, so the row is marked
    expect(bg.get(SID.a)).toMatchObject({ id: "abcd1234", state: "working" });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("a folder the CLI never trusted comes back as that, not as a failure to show raw", async () => {
    const { continueArgs } = await import("../../src/main/services/background.ts");
    const dir = sandbox();
    const fake = writeFakeClaude(dir, []);
    setUntrusted(fake, true);
    const { bg } = service({ bin: fake.bin });
    const res = await bg.dispatch(continueArgs(SID.a, "go"), { cwd: dir, sessionId: SID.a });
    expect(res).toMatchObject({ ok: false, notTrusted: true });
    expect(bg.get(SID.a)).toBeUndefined();
  });
});
