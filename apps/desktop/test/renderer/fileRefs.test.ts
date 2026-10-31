import { describe, expect, it } from "vitest";
import { codeRef, remarkFileRefs } from "../../src/renderer/logic/fileRefs.ts";

type N = { type: string; value?: string; url?: string; children?: N[] };
const run = (children: N[]): N[] => {
  const tree: N = { type: "paragraph", children };
  remarkFileRefs()(tree);
  return tree.children as N[];
};
const links = (kids: N[]) => kids.filter((k) => k.type === "link").map((k) => k.url);

describe("a file named without a link", () => {
  it("inline code that is a path", () => {
    for (const c of [
      "a.ts",
      "src/a.ts",
      "./a/b.md",
      "src/a.ts:12",
      "src/a.ts:12:3",
      "Makefile.in",
    ]) {
      expect(codeRef(c), c).not.toBeNull();
    }
    expect(codeRef("src/a.ts:12")).toBe("src/a.ts");
  });
  it("not code that only has a dot", () => {
    for (const c of [
      "v1.2",
      "1.5",
      "foo()",
      "a b.ts",
      "../x.ts",
      "~/x.ts",
      "e.g.",
      "https://x.com/a.ts",
    ]) {
      expect(codeRef(c), c).toBeNull();
    }
  });
  it("links inline code and plain text, leaves the rest alone", () => {
    const out = run([
      { type: "text", value: "see src/a.ts:12, then " },
      { type: "inlineCode", value: "b.md" },
      { type: "text", value: " and Node.js, v1.2 or notes.md." },
    ]);
    expect(links(out)).toEqual(["src/a.ts", "b.md", "notes.md"]);
    expect(out.map((k) => (k.type === "text" ? k.value : "")).join("")).toBe(
      "see , then  and Node.js, v1.2 or .",
    );
  });
  it("not inside a link", () => {
    const link: N = { type: "link", url: "x", children: [{ type: "text", value: "src/a.ts" }] };
    expect(links(run([link]))).toEqual(["x"]);
    expect(link.children?.[0]?.type).toBe("text");
  });
});
