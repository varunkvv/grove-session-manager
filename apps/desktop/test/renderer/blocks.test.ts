import { describe, expect, it } from "vitest";
import { blocks } from "../../src/renderer/logic/blocks.ts";

describe("a message cut into parts that parse alone", () => {
  it("at blank lines, headings and fences, and never inside a fence", () => {
    const text = [
      "# title",
      "a paragraph",
      "that wraps",
      "",
      "- one",
      "- two",
      "  more of two",
      "",
      "```ts",
      "const a = 1;",
      "",
      "# not a heading",
      "```",
      "after the fence",
      "## next",
      "    indented code after a heading's line",
    ].join("\n");
    expect(blocks(text)).toEqual([
      "# title",
      "a paragraph\nthat wraps\n",
      "- one\n- two\n  more of two\n",
      "```ts\nconst a = 1;\n\n# not a heading\n```",
      "after the fence",
      "## next\n    indented code after a heading's line",
    ]);
  });

  it("puts the parts back together as the message", () => {
    const text = "a\n\n\nb\n```\nc\n```\n\n~~~~\nd\n~~~\n~~~~\n";
    expect(blocks(text).join("\n")).toBe(text);
  });

  it("keeps an unclosed fence, and an indented line after a blank one, in the part before", () => {
    expect(blocks("- item\n\n  still the item\n\n```py\nwhile True:")).toEqual([
      "- item\n\n  still the item\n",
      "```py\nwhile True:",
    ]);
  });
});
