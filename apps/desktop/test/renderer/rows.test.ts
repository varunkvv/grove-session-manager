import { describe, expect, it } from "vitest";
import { nextActiveKey } from "../../src/renderer/logic/rows.ts";

describe("nextActiveKey", () => {
  it("a new query starts from the top", () => {
    expect(nextActiveKey(["a", "b"], ["b", "c"], "b", true)).toBe("b");
    expect(nextActiveKey(["a", "b", "c"], ["c"], "a", true)).toBe("c");
  });
  it("live inserts never move the active row", () => {
    expect(nextActiveKey(["a", "b"], ["new", "a", "b"], "b", false)).toBe("b");
  });
  it("when the active row disappears, the row that took its place becomes active", () => {
    expect(nextActiveKey(["a", "b", "c"], ["a", "c"], "b", false)).toBe("c");
    expect(nextActiveKey(["a", "b"], ["a"], "b", false)).toBe("a");
    expect(nextActiveKey(["a"], [], "a", false)).toBeNull();
  });
  it("a first match the list names wins over the top, when it is in the list", () => {
    expect(nextActiveKey([], ["a", "b"], null, true, "b")).toBe("b");
    expect(nextActiveKey([], ["a", "b"], null, true, "gone")).toBe("a");
  });
});
