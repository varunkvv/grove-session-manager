// agent output is untrusted: a result is model text, and it quotes web pages and files. so this
// renders React elements only. react-markdown turns raw html into plain text unless rehype-raw is
// added, and it is never added here. links go to the browser through main, http(s) only.
import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { webLink } from "../logic/agentDetail.ts";
import { rehypeMarkWords } from "../logic/markWords.ts";

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
};

const plugins = [remarkGfm];
const NONE: readonly string[] = [];

/** markdown from an agent, as quiet as the rest of the pane */
export const Markdown = memo(function Markdown({
  text,
  className,
  marks = NONE,
}: {
  text: string;
  className?: string;
  /** words to mark, the way the list marks a search */
  marks?: readonly string[];
}) {
  const rehype = useMemo(() => (marks.length ? [[rehypeMarkWords, marks] as const] : []), [marks]);
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
