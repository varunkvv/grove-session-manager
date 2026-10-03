// agent output is untrusted: a result is model text, and it quotes web pages and files. so this
// renders React elements only. react-markdown turns raw html into plain text unless rehype-raw is
// added, and it is never added here. links go to the browser through main, http(s) only.
import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeMarkWords } from "../logic/markWords.ts";
import { rehypeRefs, webLink } from "../logic/refs.ts";
import { currentProject, useStore } from "../state/store.ts";
import { CardChip, ConclusionChip } from "./ui.tsx";

const components: Components = {
  a: ({ href, children }) => {
    const url = webLink(href);
    if (!url) return <span>{children}</span>;
    return (
      <a
        href={url}
        title={url}
        onClick={(e) => {
          // never navigated in the window: the window only ever shows our own page
          e.preventDefault();
          void window.grove.openExternal(url);
        }}
      >
        {children}
      </a>
    );
  },
  // remote images are blocked by the page's CSP anyway. a broken image says less than its words.
  img: ({ alt }) => (alt ? <span className="md-alt">{alt}</span> : null),
  // an id rehypeRefs wrapped. a card prefix is never D, F or V, so the letter says which chip
  span: ({ node: _node, children, ...props }) => {
    const ref = (props as { "data-ref"?: string })["data-ref"];
    if (!ref) return <span {...props}>{children}</span>;
    return /^[DFV]-/.test(ref) ? <ConclusionChip id={ref} /> : <CardChip cardId={ref} />;
  },
};

const plugins = [remarkGfm];
const NONE: readonly string[] = [];

/** markdown from an agent, as quiet as the rest of the page */
export const Markdown = memo(function Markdown({
  text,
  className,
  marks = NONE,
  refs,
}: {
  text: string;
  className?: string;
  /** words to mark, the way a list marks a search */
  marks?: readonly string[];
  /** card and conclusion ids in the text become chips */
  refs?: boolean;
}) {
  const prefix = useStore((s) => (refs ? (currentProject(s)?.prefix ?? "") : ""));
  const rehype = useMemo(
    () => [
      ...(refs ? [[rehypeRefs, { prefix }] as const] : []),
      ...(marks.length ? [[rehypeMarkWords, marks] as const] : []),
    ],
    [refs, prefix, marks],
  );
  return (
    <div className={className ? `md ${className}` : "md"}>
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={rehype as never}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
