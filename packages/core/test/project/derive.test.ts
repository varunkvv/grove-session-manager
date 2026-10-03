import { describe, expect, it } from "vitest";
import {
  agentRef,
  agentState,
  cardDisplayStatus,
  runtimeOf,
  type SessionFacts,
} from "../../src/project/derive.ts";
import type { LiveState } from "../../src/types.ts";

const facts = (o: Partial<SessionFacts> = {}): SessionFacts => ({
  sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
  runtime: "vscode",
  ...o,
});
const live = (state: LiveState, seen?: boolean) => ({ state, at: 1, lastEventAt: 1, seen });

describe("where a session runs", () => {
  it("names the five runtimes", () => {
    const vscode = { kind: "interactive", entrypoint: "claude-vscode" };
    expect(runtimeOf({ holder: vscode, alive: true })).toBe("vscode");
    expect(runtimeOf({ holder: { entrypoint: "cli" }, alive: true })).toBe("terminal");
    expect(runtimeOf({ holder: { kind: "bg" }, alive: true })).toBe("background");
    expect(runtimeOf({ holder: { entrypoint: "sdk-cli" }, alive: true })).toBe("elsewhere");
    expect(runtimeOf({ holder: {}, alive: true })).toBe("elsewhere");
    expect(runtimeOf({ alive: false })).toBe("closed");
  });

  it("a holder whose process is gone is closed, and a held background session wins", () => {
    expect(runtimeOf({ holder: { entrypoint: "claude-vscode" }, alive: false })).toBe("closed");
    expect(runtimeOf({ held: true, holder: { entrypoint: "claude-vscode" }, alive: true })).toBe(
      "background",
    );
    expect(runtimeOf({ held: true, alive: false })).toBe("background");
  });
});

describe("a card's display status", () => {
  it("goes in order: closed, stopped, waiting, then the record's own", () => {
    const stopped = facts({ interrupted: { why: "gone", at: 5 } });
    const held = { status: "in_progress", asksPerson: false } as const;
    expect(cardDisplayStatus({ status: "done", asksPerson: true }, stopped)).toBe("done");
    expect(cardDisplayStatus({ status: "canceled", asksPerson: false })).toBe("canceled");
    expect(cardDisplayStatus(held, stopped)).toBe("stopped");
    expect(cardDisplayStatus({ ...held, asksPerson: true }, facts())).toBe("waiting");
    expect(cardDisplayStatus(held, facts({ live: live("permission") }))).toBe("waiting");
    expect(cardDisplayStatus(held, facts({ live: live("running") }))).toBe("in_progress");
    expect(cardDisplayStatus({ status: "todo", asksPerson: false })).toBe("todo");
  });

  it("a todo card with an open question to the person is waiting", () => {
    expect(cardDisplayStatus({ status: "todo", asksPerson: true })).toBe("waiting");
  });

  it("a holder someone already looked at, or one that closed between turns, is in progress", () => {
    const held = { status: "in_progress", asksPerson: false } as const;
    expect(cardDisplayStatus(held, facts({ live: live("waiting", true) }))).toBe("in_progress");
    expect(cardDisplayStatus(held, facts({ runtime: "closed" }))).toBe("in_progress");
  });
});

describe("an agent's state", () => {
  it("stopped first, then the live state, then idle or closed", () => {
    expect(agentState(facts({ interrupted: { why: "failed" }, live: live("running") }))).toBe(
      "stopped",
    );
    expect(agentState(facts({ live: live("running") }))).toBe("working");
    for (const s of ["permission", "waiting", "failed"] as const) {
      expect(agentState(facts({ live: live(s) }))).toBe(s);
    }
    expect(agentState(facts())).toBe("idle");
    expect(agentState(facts({ runtime: "closed" }))).toBe("closed");
  });

  it("is named by the session's title, else the record, else the id", () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000001";
    expect(agentRef(id, facts({ title: "fix login" }), "idp config")).toEqual({
      sessionId: id,
      name: "fix login",
    });
    expect(agentRef(id, facts(), "idp config", "researcher")).toEqual({
      sessionId: id,
      name: "idp config",
      sub: "researcher",
    });
    expect(agentRef(id, undefined, "")).toEqual({ sessionId: id, name: "aaaaaaaa" });
  });
});
