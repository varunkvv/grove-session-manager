import type { LiveStatus } from "@grove/core";
import { needsYou } from "@grove/core";
import { describe, expect, it } from "vitest";
import { Reveals } from "../../src/main/services/reveal.ts";

const live = (state: LiveStatus["state"], extra: Partial<LiveStatus> = {}): LiveStatus => ({
  state,
  at: 1,
  lastEventAt: 1,
  ...extra,
});

function setup(rows: Record<string, LiveStatus | undefined>) {
  const calls: string[] = [];
  const reveals = new Reveals({
    find: (id) => (id in rows ? { key: `/p/${id}.jsonl`, live: rows[id] } : undefined),
    needsYou,
    raise: () => calls.push("raise"),
    notify: () => calls.push("notify"),
  });
  return { reveals, calls };
}

describe("a notification click, landing in grove", () => {
  it("lands in the inbox while the session still waits, and is held until the page takes it", () => {
    const { reveals, calls } = setup({ a: live("waiting") });
    expect(reveals.reveal("a")).toMatchObject({ key: "/p/a.jsonl", scope: "inbox" });
    expect(calls).toEqual(["raise", "notify"]);
    // the page was not listening yet: it takes the landing when it connects, and only once
    expect(reveals.take()).toMatchObject({ key: "/p/a.jsonl" });
    expect(reveals.take()).toBeNull();
  });

  it("answered meanwhile: every session instead, and no agent", () => {
    const { reveals } = setup({ a: live("waiting", { seen: true }), b: live("running") });
    expect(reveals.reveal("a")).toMatchObject({ scope: "all" });
    expect(reveals.reveal("b")?.agentId).toBeUndefined();
  });

  it("a subagent asking for permission: its detail, not the conversation", () => {
    const { reveals } = setup({ a: live("permission", { agentId: "a7", detail: "Bash" }) });
    expect(reveals.reveal("a")).toMatchObject({ scope: "inbox", agentId: "a7" });
  });

  it("a session gone from the list still brings the window forward, and lands nowhere", () => {
    const { reveals, calls } = setup({});
    expect(reveals.reveal("x")).toBeNull();
    expect(calls).toEqual(["raise"]);
    expect(reveals.take()).toBeNull();
  });
});
