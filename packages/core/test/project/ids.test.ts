import { describe, expect, it } from "vitest";
import { projectIdOf } from "../../src/project/ids.ts";

describe("project ids", () => {
  it("a project's id is its root's last segment", () => {
    expect(projectIdOf({ root: "/Users/you/claude-ws/chat-features" })).toBe("chat-features");
  });
});
