// a file an agent names without a link: `src/a.ts`, src/a.ts:12, ./notes.md. a remark plugin turns
// these into links, and the chat window's link component opens them in the viewer

type Node = { type: string; value?: string; url?: string; children?: Node[] };

const EXT = "[A-Za-z][A-Za-z0-9]{0,9}";
const SEG = "[\\w@.+~-]+";
/** in plain text: only a path with a folder in it, or a name with a common extension */
const COMMON =
  "ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|py|rb|go|rs|java|kt|swift|sh|zsh|sql|yml|yaml|toml|txt|csv|html|css|scss|xml|log|lock|env|ini|cfg|conf|tf|proto|graphql|ipynb|png|jpg|jpeg|gif|svg|webp|mp4|mov|pdf";
const TEXT_REF = new RegExp(
  `(?<![\\w/.~@-])((?:\\.{0,2}/|~/)?(?:${SEG}/)+${SEG}\\.${EXT}|${SEG}\\.(?:${COMMON}))(?::\\d+(?::\\d+)?)?(?![\\w/-])`,
  "g",
);
/** a product's name, not a file */
const PRODUCT =
  /^(node|next|nuxt|vue|react|three|d3|express|chart|socket|alpine|ember|backbone)\.js$/i;
const CODE_REF = new RegExp(`^((?:\\.{0,2}/|~/)?(?:${SEG}/)*${SEG}\\.${EXT})(?::\\d+(?::\\d+)?)?$`);

/** the path in a span of inline code, or null when it is not one */
export function codeRef(code: string): string | null {
  const m = CODE_REF.exec(code);
  const p = m?.[1];
  // a version, a domain or a method call is not a file: need a letter-led extension and no ".."
  return p && !p.includes("..") && !/^[\d.]+$/.test(p) && !p.startsWith("~") ? p : null;
}

const link = (url: string, children: Node[]): Node => ({
  type: "link",
  url: encodeURI(url),
  children,
});

function walk(node: Node) {
  const kids = node.children;
  if (!kids || node.type === "link" || node.type === "linkReference") return;
  const out: Node[] = [];
  for (const k of kids) {
    if (k.type === "inlineCode" && k.value) {
      const p = codeRef(k.value);
      out.push(p ? link(p, [k]) : k);
    } else if (k.type === "text" && k.value) {
      const text = k.value;
      let at = 0;
      for (const m of text.matchAll(TEXT_REF)) {
        const p = m[1] as string;
        if (p.includes("..") || p.startsWith("~") || PRODUCT.test(p)) continue;
        if (m.index > at) out.push({ type: "text", value: text.slice(at, m.index) });
        out.push(link(p, [{ type: "text", value: m[0] }]));
        at = m.index + m[0].length;
      }
      out.push(at === 0 ? k : { type: "text", value: text.slice(at) });
    } else {
      walk(k);
      out.push(k);
    }
  }
  node.children = out;
}

export function remarkFileRefs() {
  return (tree: Node) => walk(tree);
}
