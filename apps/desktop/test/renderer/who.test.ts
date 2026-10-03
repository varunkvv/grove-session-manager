import { describe, expect, it } from "vitest";
import { agentHue, fnv1a, initials, whoView } from "../../src/renderer/logic/who.ts";

describe("fnv1a", () => {
  it("matches the known vectors", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });
});

describe("agentHue", () => {
  it("is 1 to 9 and the same for the same id", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `session-${i}`);
    const hues = ids.map(agentHue);
    expect(new Set(hues)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(ids.map(agentHue)).toEqual(hues);
  });
});

describe("initials", () => {
  it.each([
    ["idp config", "IC"],
    ["chat-features-35", "CF"],
    ["agent 1", "A1"],
    ["Explore", "E"],
    ["a.b_c/d", "AB"],
    ["", "?"],
    ["  ", "?"],
  ])("%j is %s", (name, want) => {
    expect(initials(name)).toBe(want);
  });
});

describe("whoView", () => {
  it("is you for the person", () => {
    expect(whoView("person")).toEqual({ kind: "person", id: "person", name: "you" });
  });
  it("keys an agent by its session, and a subagent by session and name", () => {
    expect(whoView({ sessionId: "s1", name: "idp config" })).toEqual({
      kind: "agent",
      id: "s1",
      name: "idp config",
    });
    expect(whoView({ sessionId: "s1", name: "idp config", sub: "explore" })?.id).toBe("s1/explore");
  });
  it("leaves nobody as nobody", () => {
    expect(whoView(undefined)).toBeUndefined();
  });
});
