import { describe, expect, it } from "vitest";
import { fuzzy, rank } from "../../src/renderer/logic/fuzzy.ts";

describe("what / and @ match", () => {
  it("the letters in order, anywhere", () => {
    expect(fuzzy("cmp", "compact")).not.toBeNull();
    expect(fuzzy("pmc", "compact")).toBeNull();
    expect(fuzzy("", "anything")).not.toBeNull();
  });

  it("a file's own name before a folder that happens to hold the letters", () => {
    const files = [
      "src/chat/view.ts",
      "src/main/chat.ts",
      "docs/c-h-a-t.md",
      "src/renderer/Chat.tsx",
    ];
    expect(rank(files, "chat", (f) => f).slice(0, 2)).toEqual([
      "src/main/chat.ts",
      "src/renderer/Chat.tsx",
    ]);
  });

  it("a start of a word before letters in the middle", () => {
    expect(rank(["release-notes", "review"], "re", (f) => f)[0]).toBe("review");
    expect(rank(["amazon-bedrock", "ask-matt"], "am", (f) => f)[0]).toBe("amazon-bedrock");
    expect(rank(["amazon-bedrock", "ask-matt"], "askm", (f) => f)).toEqual(["ask-matt"]);
  });
});
