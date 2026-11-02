// a file an agent names without a link: `src/a.ts`, src/a.ts:12, ./notes.md. a remark plugin turns
// these into links when the session's files resolve to exactly one file, and the chat window's
// link component opens them in the viewer, at the line named

import { fileLine, type IndexedFile, resolveFileRef } from "@grove/core/pure";

type Node = { type: string; value?: string; url?: string; children?: Node[] };

const EXT = "[A-Za-z][A-Za-z0-9]{0,9}";
const SEG = "[\\w@.+~-]+";
/** a name with an extension, optionally a folder or two, and a `:N` or `:N:M` line. resolved after */
const TEXT_REF = new RegExp(
  `(?<![\\w/.~@-])((?:\\.{0,2}/|~/)?(?:${SEG}/)*${SEG}\\.${EXT})(?::\\d+(?::\\d+)?)?(?![\\w/-])`,
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

/** the link to a resolved file: its line as a fragment, when the reference names one */
const hrefOf = (file: string, token: string): string => {
  const line = fileLine(token);
  return line === undefined ? file : `${file}#L${line}`;
};

function walk(node: Node, files: readonly IndexedFile[]) {
  const kids = node.children;
  if (!kids || node.type === "link" || node.type === "linkReference") return;
  const out: Node[] = [];
  for (const k of kids) {
    if (k.type === "inlineCode" && k.value) {
      const file = codeRef(k.value) && resolveFileRef(k.value, files);
      out.push(file ? link(hrefOf(file, k.value), [k]) : k);
    } else if (k.type === "text" && k.value) {
      const text = k.value;
      let at = 0;
      for (const m of text.matchAll(TEXT_REF)) {
        const token = m[0];
        const p = m[1] as string;
        if (p.includes("..") || p.startsWith("~") || PRODUCT.test(p)) continue;
        const file = resolveFileRef(token, files);
        if (!file) continue;
        if (m.index > at) out.push({ type: "text", value: text.slice(at, m.index) });
        out.push(link(hrefOf(file, token), [{ type: "text", value: token }]));
        at = m.index + token.length;
      }
      out.push(at === 0 ? k : { type: "text", value: text.slice(at) });
    } else {
      walk(k, files);
      out.push(k);
    }
  }
  node.children = out;
}

/** links the files of a session's index that the text names. nothing is linked without the index */
export function remarkFileRefs(files: readonly IndexedFile[]) {
  return () => (tree: Node) => walk(tree, files);
}
