import type { IndexedFile } from "@grove/core/pure";
import { describe, expect, it } from "vitest";
import { codeRef, remarkFileRefs } from "../../src/renderer/logic/fileRefs.ts";

type N = { type: string; value?: string; url?: string; children?: N[] };
const run = (children: N[], files: IndexedFile[] = []): N[] => {
  const tree: N = { type: "paragraph", children };
  remarkFileRefs(files)()(tree);
  return tree.children as N[];
};
const links = (kids: N[]) => kids.filter((k) => k.type === "link").map((k) => k.url);
const text = (kids: N[]) => kids.map((k) => (k.type === "text" ? k.value : "")).join("");

const files: IndexedFile[] = [
  { path: "/r/src/a.ts", touchedAt: 1, edited: true },
  { path: "/r/b.md", touchedAt: 2 },
  { path: "/r/notes.md", touchedAt: 3 },
];

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
  it("links inline code and plain text the index resolves, leaves the rest alone", () => {
    const out = run(
      [
        { type: "text", value: "see src/a.ts:12, then " },
        { type: "inlineCode", value: "b.md" },
        { type: "text", value: " and Node.js, v1.2 or notes.md." },
      ],
      files,
    );
    expect(links(out)).toEqual(["/r/src/a.ts#L12", "/r/b.md", "/r/notes.md"]);
    expect(text(out)).toBe("see , then  and Node.js, v1.2 or .");
  });
  it("not inside a link", () => {
    const link: N = { type: "link", url: "x", children: [{ type: "text", value: "src/a.ts" }] };
    expect(links(run([link], files))).toEqual(["x"]);
    expect(link.children?.[0]?.type).toBe("text");
  });
  it("is plain text with no index", () => {
    const out = run([{ type: "text", value: "see src/a.ts and notes.md" }]);
    expect(links(out)).toEqual([]);
    expect(text(out)).toBe("see src/a.ts and notes.md");
  });
});

describe("a reference the session's files resolve", () => {
  const touched = [{ path: "/r/src/components/Files.tsx", touchedAt: 1, edited: false }];

  it("links a name that is a touched file", () => {
    expect(links(run([{ type: "text", value: "open Files.tsx now" }], touched))).toEqual([
      "/r/src/components/Files.tsx",
    ]);
  });
  it("links a name with a line to that line", () => {
    expect(links(run([{ type: "text", value: "see Files.tsx:42" }], touched))).toEqual([
      "/r/src/components/Files.tsx#L42",
    ]);
  });
  it("keeps a bare name with two untouched candidates as plain text", () => {
    const two = [{ path: "/r/a/index.ts" }, { path: "/r/b/index.ts" }];
    const out = run([{ type: "text", value: "the index.ts file" }], two);
    expect(links(out)).toEqual([]);
    expect(text(out)).toBe("the index.ts file");
  });
  it("leaves a product's name plain", () => {
    const out = run([{ type: "text", value: "built on node.js" }], [{ path: "/r/node.js" }]);
    expect(links(out)).toEqual([]);
  });
  it("does not link a name inside a longer one", () => {
    const out = run([{ type: "text", value: "in MyFiles.tsx" }], touched);
    expect(links(out)).toEqual([]);
    expect(text(out)).toBe("in MyFiles.tsx");
  });
  it("links inline code with a line to that line", () => {
    const out = run([{ type: "inlineCode", value: "Files.tsx:7" }], touched);
    expect(links(out)).toEqual(["/r/src/components/Files.tsx#L7"]);
  });
});
