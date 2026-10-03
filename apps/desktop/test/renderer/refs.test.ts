import { describe, expect, it } from "vitest";
import { rehypeRefs, webLink } from "../../src/renderer/logic/refs.ts";

// the trees react-markdown hands a rehype plugin, cut down to what the plugin reads
type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: object;
  children?: Node[];
};
const text = (value: string): Node => ({ type: "text", value });
const el = (tagName: string, ...children: Node[]): Node => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

/** the tree after the plugin, as `text` and `[ID]` for each ref */
function run(tree: Node, prefix = "AUTH"): string {
  rehypeRefs({ prefix })(tree as never);
  const flat = (n: Node): string =>
    n.type === "text"
      ? (n.value ?? "")
      : n.tagName === "span" && n.properties && "dataRef" in n.properties
        ? `[${String(n.properties.dataRef)}]`
        : (n.children ?? []).map(flat).join("");
  return flat(tree);
}

const para = (s: string) => run({ type: "root", children: [el("p", text(s))] });

describe("rehypeRefs", () => {
  it("wraps card and conclusion ids in text", () => {
    expect(para("Asked in AUTH-4 which uri. See D-8 and F-10, V-9.")).toBe(
      "Asked in [AUTH-4] which uri. See [D-8] and [F-10], [V-9].",
    );
  });

  it("puts the id in a span the Markdown component can find", () => {
    const tree: Node = { type: "root", children: [el("p", text("see AUTH-4"))] };
    rehypeRefs({ prefix: "AUTH" })(tree as never);
    expect(tree.children?.[0]?.children).toEqual([
      text("see "),
      {
        type: "element",
        tagName: "span",
        properties: { dataRef: "AUTH-4" },
        children: [text("AUTH-4")],
      },
    ]);
  });

  it("leaves inline code, a code block and a link's text alone", () => {
    const tree: Node = {
      type: "root",
      children: [
        el("p", text("in "), el("code", text("AUTH-1")), text(" and "), el("a", text("AUTH-9"))),
        el("pre", el("code", text("AUTH-3 in a block"))),
        el("ul", el("li", el("em", text("V-2")))),
      ],
    };
    expect(run(tree)).toBe("in AUTH-1 and AUTH-9AUTH-3 in a block[V-2]");
  });

  it("does not take XAUTH-4, AUTH-04 or lower case", () => {
    expect(para("XAUTH-4 AUTH-04 auth-4 d-8 D-0 AUTH-")).toBe(
      "XAUTH-4 AUTH-04 auth-4 d-8 D-0 AUTH-",
    );
  });

  it("does not take another project's prefix", () => {
    expect(para("DATA-3 and AUTH-3")).toBe("DATA-3 and [AUTH-3]");
  });

  it("takes F-1024", () => {
    expect(para("F-1024")).toBe("[F-1024]");
  });

  it("takes two ids in one text node, and one at the end of a node", () => {
    expect(para("AUTH-1, at the end: AUTH-12")).toBe("[AUTH-1], at the end: [AUTH-12]");
  });

  it("takes only conclusion ids when the project has no prefix yet", () => {
    expect(run({ type: "root", children: [el("p", text("item-4 D-2"))] }, "")).toBe("item-4 [D-2]");
  });
});

describe("a link in what an agent wrote", () => {
  it("only a web link is a link", () => {
    expect(webLink("https://example.com/x")).toBe("https://example.com/x");
    expect(webLink("javascript:alert(1)")).toBeNull();
    expect(webLink("file:///etc/passwd")).toBeNull();
    expect(webLink("/relative")).toBeNull();
    expect(webLink(undefined)).toBeNull();
  });
});
