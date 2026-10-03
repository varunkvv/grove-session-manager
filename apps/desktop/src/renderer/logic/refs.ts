// card and conclusion ids inside rendered markdown, wrapped in <span data-ref> so Markdown can draw
// them as chips. like rehypeMarkWords it edits the tree react-markdown built and never parses html.

interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

/** code is quoted as it was written, and a link's text belongs to the link */
const SKIP = new Set(["code", "pre", "a"]);

function walk(node: HastNode, re: RegExp): void {
  if (!("children" in node) || !node.children) return;
  if (node.type === "element" && SKIP.has((node as HastElement).tagName)) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type !== "text") {
      walk(child, re);
      next.push(child);
      continue;
    }
    const { value } = child as HastText;
    let at = 0;
    for (const m of value.matchAll(re)) {
      if (m.index > at) next.push({ type: "text", value: value.slice(at, m.index) });
      next.push({
        type: "element",
        tagName: "span",
        properties: { dataRef: m[0] },
        children: [{ type: "text", value: m[0] }],
      });
      at = m.index + m[0].length;
    }
    if (at === 0) next.push(child);
    else if (at < value.length) next.push({ type: "text", value: value.slice(at) });
  }
  node.children = next;
}

/** a rehype plugin: `[rehypeRefs, { prefix }]`. `AUTH-4`, `D-8`, `F-10`, `V-9`, not `XAUTH-4` or `AUTH-04` */
export function rehypeRefs({ prefix }: { prefix: string }) {
  // a project with no prefix yet still gets its conclusion ids
  const card = prefix ? `${prefix}-[1-9]\\d{0,5}|` : "";
  const re = new RegExp(`\\b(${card}[DFV]-[1-9]\\d{0,5})\\b`, "g");
  return (tree: HastNode) => walk(tree, re);
}

/** only http(s) links go anywhere, and they go to the browser through main */
export function webLink(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
