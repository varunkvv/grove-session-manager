import { highlightRanges } from "@grove/core/pure";

// the query's words marked inside rendered markdown, the way the list marks them. it works on the
// tree react-markdown builds, after parsing: text nodes are split and the matches wrapped in a
// <mark> element. nothing here is ever parsed as html.

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

/** code is quoted as it was written: a word inside it is not the conversation's */
const SKIP = new Set(["code", "pre"]);

function split(node: HastText, tokens: readonly string[]): HastNode[] | null {
  const ranges = highlightRanges(node.value, tokens);
  if (ranges.length === 0) return null;
  const out: HastNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push({ type: "text", value: node.value.slice(at, start) });
    out.push({
      type: "element",
      tagName: "mark",
      properties: {},
      children: [{ type: "text", value: node.value.slice(start, end) }],
    });
    at = end;
  }
  if (at < node.value.length) out.push({ type: "text", value: node.value.slice(at) });
  return out;
}

function walk(node: HastNode, tokens: readonly string[]): void {
  if (!("children" in node) || !node.children) return;
  if (node.type === "element" && SKIP.has((node as HastElement).tagName)) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    const parts = child.type === "text" ? split(child as HastText, tokens) : null;
    if (parts) next.push(...parts);
    else {
      walk(child, tokens);
      next.push(child);
    }
  }
  node.children = next;
}

/** a rehype plugin: `[rehypeMarkWords, tokens]` */
export function rehypeMarkWords(tokens: readonly string[]) {
  return (tree: HastNode) => {
    if (tokens.length > 0) walk(tree, tokens);
  };
}
