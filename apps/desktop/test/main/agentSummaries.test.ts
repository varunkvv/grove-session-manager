import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentSnapshot, SessionAgent } from "@grove/core";
import { describe, expect, it } from "vitest";
import {
  AgentSummaries,
  FOUND_FILE,
  type SummarySpawn,
  summaryArgs,
  summaryPrompt,
} from "../../src/main/services/agentSummaries.ts";

const NOW = Date.parse("2026-09-22T18:00:00.000Z");
const KEY = "/projects/-ws-queue/aaaa.jsonl";

function sandbox(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-summaries-")));
}

const TAIL = [
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"pnpm test"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"two of the retry tests fail"}]}}',
].join("\n");

function agent(partial: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: "a1",
    agentType: "long-task",
    description: "Rewrite the retry policy",
    startedAt: NOW - 60_000,
    lastActivityAt: NOW - 1000,
    state: "running",
    ...partial,
  };
}

function snapshot(dir: string, agents: SessionAgent[], mark = "1:2"): AgentSnapshot {
  const file = path.join(dir, "agent-a1.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${TAIL}\n`);
  return {
    agents,
    reads: Object.fromEntries(agents.map((a) => [a.id, { file, mark }])),
  };
}

interface Harness {
  service: AgentSummaries;
  calls: Array<{ args: readonly string[]; input: string }>;
  summaries: Array<{ id: string; summary: string }>;
  dir: string;
  setNow: (at: number) => void;
}

function harness(
  opts: { reply?: string | null; enabled?: boolean; visible?: boolean; refreshMs?: number } = {},
) {
  const dir = sandbox();
  const calls: Harness["calls"] = [];
  const summaries: Harness["summaries"] = [];
  let now = NOW;
  const spawn: SummarySpawn = async (_bin, args, input) => {
    calls.push({ args, input });
    return opts.reply === undefined ? "  reading the retry tests\n" : opts.reply;
  };
  const service = new AgentSummaries({
    stateDir: dir,
    claudeBin: async () => "/bin/claude",
    enabled: () => opts.enabled ?? true,
    visible: () => opts.visible ?? true,
    onSummary: (_key, id, summary) => summaries.push({ id, summary }),
    spawn,
    now: () => now,
    ...(opts.refreshMs !== undefined ? { refreshMs: opts.refreshMs } : {}),
  });
  return { service, calls, summaries, dir, setNow: (at: number) => (now = at) };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("agent summaries", () => {
  it("the invocation is the one that was verified by hand", () => {
    expect(summaryArgs()).toEqual([
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
    const prompt = summaryPrompt("long-task", "Rewrite the retry policy", "Bash: pnpm test");
    expect(prompt).toContain("long-task");
    expect(prompt).toContain("Rewrite the retry policy");
    expect(prompt).toContain("Bash: pnpm test");
    // no description at all is the workflow-agent case
    expect(summaryPrompt("workflow-subagent", undefined, "Bash: ls")).not.toContain("asked to");
  });

  it("one call per running agent, with the digest rather than the raw transcript", async () => {
    const h = harness();
    h.service.note(KEY, snapshot(h.dir, [agent()]));
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.input).toContain("Bash: pnpm test");
    expect(h.calls[0]?.input).toContain("said: two of the retry tests fail");
    expect(h.calls[0]?.input).not.toContain('"type":"assistant"');
    expect(h.summaries).toEqual([{ id: "a1", summary: "reading the retry tests" }]);
  });

  it("an agent that is already done is never asked about", async () => {
    const h = harness();
    h.service.note(KEY, snapshot(h.dir, [agent({ state: "done" })]));
    await settle();
    expect(h.calls).toHaveLength(0);
  });

  it("nothing new written means nothing new to say, and the cadence holds the rest", async () => {
    const h = harness();
    const first = snapshot(h.dir, [agent()], "10:100");
    h.service.note(KEY, first);
    await settle();
    expect(h.calls).toHaveLength(1);

    // same mark: the transcript did not move
    h.service.note(KEY, first);
    await settle();
    expect(h.calls).toHaveLength(1);

    // it moved, but not 30s have passed
    h.setNow(NOW + 5_000);
    h.service.note(KEY, snapshot(h.dir, [agent()], "20:200"));
    await settle();
    expect(h.calls).toHaveLength(1);

    h.setNow(NOW + 40_000);
    h.service.note(KEY, snapshot(h.dir, [agent()], "30:300"));
    await settle();
    expect(h.calls).toHaveLength(2);
  });

  it("an agent that goes quiet is still refreshed on the cadence, with no rescan to do it", async () => {
    const h = harness({ refreshMs: 40 });
    h.service.note(KEY, snapshot(h.dir, [agent()], "10:100"));
    await settle();
    expect(h.calls).toHaveLength(1);

    // it writes once more too soon, then thinks: no further scan is coming to carry it
    h.setNow(NOW + 5);
    h.service.note(KEY, snapshot(h.dir, [agent()], "20:200"));
    await settle();
    expect(h.calls).toHaveLength(1);

    h.setNow(NOW + 100);
    await new Promise((r) => setTimeout(r, 120));
    expect(h.calls.length).toBeGreaterThanOrEqual(2);
    h.service.dispose();
  });

  it("switched off, or hidden, spends nothing - and waking up catches up", async () => {
    const off = harness({ enabled: false });
    off.service.note(KEY, snapshot(off.dir, [agent()]));
    await settle();
    expect(off.calls).toHaveLength(0);

    const hidden = harness({ visible: false });
    hidden.service.note(KEY, snapshot(hidden.dir, [agent()]));
    await settle();
    expect(hidden.calls).toHaveLength(0);
  });

  it("a wake after the window comes back asks about what it already knows", async () => {
    let visible = false;
    const dir = sandbox();
    const calls: string[] = [];
    const service = new AgentSummaries({
      stateDir: dir,
      claudeBin: async () => "/bin/claude",
      enabled: () => true,
      visible: () => visible,
      onSummary: () => {},
      spawn: async (_bin, _args, input) => {
        calls.push(input);
        return "reading the retry tests";
      },
      now: () => NOW,
    });
    service.note(KEY, snapshot(dir, [agent()]));
    await settle();
    expect(calls).toHaveLength(0);
    visible = true;
    service.wake();
    await settle();
    expect(calls).toHaveLength(1);
    service.dispose();
  });

  it("a failed call is silent, and does not retry before the cadence is up", async () => {
    const h = harness({ reply: null });
    h.service.note(KEY, snapshot(h.dir, [agent()], "10:100"));
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.summaries).toEqual([]);
    h.service.note(KEY, snapshot(h.dir, [agent()], "20:200"));
    await settle();
    expect(h.calls).toHaveLength(1);
  });

  it("a reply that arrives after the agent finished is dropped", async () => {
    const dir = sandbox();
    const summaries: string[] = [];
    const pending: Array<(reply: string) => void> = [];
    const service = new AgentSummaries({
      stateDir: dir,
      claudeBin: async () => "/bin/claude",
      enabled: () => true,
      visible: () => true,
      onSummary: (_key, _id, summary) => summaries.push(summary),
      spawn: () => new Promise((resolve) => pending.push(resolve)),
      now: () => NOW,
    });
    service.note(KEY, snapshot(dir, [agent()]));
    await settle();
    // the agent stops while the model is still thinking
    service.note(KEY, snapshot(dir, [agent({ state: "done" })]));
    pending[0]?.("reading the retry tests");
    await settle();
    expect(summaries).toEqual([]);
    service.dispose();
  });
});

describe("a line for a finished agent", () => {
  function found(
    opts: { reply?: string | null; enabled?: boolean; visible?: boolean; dir?: string } = {},
  ) {
    const dir = opts.dir ?? sandbox();
    const calls: string[] = [];
    const lines: Array<{ id: string; line: string }> = [];
    const service = new AgentSummaries({
      stateDir: dir,
      claudeBin: async () => "/bin/claude",
      enabled: () => opts.enabled ?? true,
      visible: () => opts.visible ?? true,
      onSummary: () => {},
      onFound: (_key, id, line) => lines.push({ id, line }),
      spawn: async (_bin, _args, input) => {
        calls.push(input);
        return opts.reply === undefined
          ? "found the lease is renewed only on success\n"
          : opts.reply;
      },
      now: () => NOW,
    });
    return { service, calls, lines, dir };
  }
  const done = agent({ state: "done" });

  it("is asked once, when someone looks, and kept for good", async () => {
    const h = found();
    const snap = snapshot(h.dir, [done], "7:77");
    await h.service.seen(KEY, done, snap.reads.a1);
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toContain("has finished");
    expect(h.calls[0]).toContain("what it found or did");
    expect(h.calls[0]).toContain("Rewrite the retry policy");
    expect(h.lines).toEqual([{ id: "a1", line: "found the lease is renewed only on success" }]);
    expect(JSON.parse(readFileSync(path.join(h.dir, FOUND_FILE), "utf8"))).toEqual({
      "a1:7:77": "found the lease is renewed only on success",
    });

    // looked at again, and after a restart: never asked again
    await h.service.seen(KEY, done, snap.reads.a1);
    const again = found({ dir: h.dir });
    await again.service.seen(KEY, done, snap.reads.a1);
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(again.calls).toHaveLength(0);
    expect(again.lines).toEqual([{ id: "a1", line: "found the lease is renewed only on success" }]);

    // and a scan brings it back for a row that lost it, still for nothing
    const later = found({ dir: h.dir });
    later.service.note(KEY, snap);
    await settle();
    expect(later.lines.map((l) => l.id)).toEqual(["a1"]);
    expect(later.calls).toHaveLength(0);
  });

  it("never for an agent nobody looked at, a running one, or with the setting off or the window hidden", async () => {
    const h = found();
    h.service.note(KEY, snapshot(h.dir, [done]));
    await settle();
    expect(h.calls).toHaveLength(0);
    await h.service.seen(KEY, agent({ state: "running" }), snapshot(h.dir, [agent()]).reads.a1);
    const off = found({ enabled: false });
    await off.service.seen(KEY, done, snapshot(off.dir, [done]).reads.a1);
    const hidden = found({ visible: false });
    await hidden.service.seen(KEY, done, snapshot(hidden.dir, [done]).reads.a1);
    await settle();
    expect([h.calls, off.calls, hidden.calls].map((c) => c.length)).toEqual([0, 0, 0]);
  });

  it("a failed call keeps nothing and is not tried again while the app runs", async () => {
    const h = found({ reply: null });
    const snap = snapshot(h.dir, [done], "7:77");
    await h.service.seen(KEY, done, snap.reads.a1);
    await settle();
    await h.service.seen(KEY, done, snap.reads.a1);
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.lines).toEqual([]);
    expect(existsSync(path.join(h.dir, FOUND_FILE))).toBe(false);
  });
});
