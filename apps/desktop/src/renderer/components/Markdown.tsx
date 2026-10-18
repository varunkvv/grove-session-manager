// agent output is untrusted: a result is model text, and it quotes web pages and files. so this
// renders React elements only. react-markdown turns raw html into plain text unless rehype-raw is
// added, and it is never added here. links go to the browser through main, http(s) only. in a
// grove chat window a path is a file of the session's: an image drawn through <img> from main's
// session scheme, which serves only the session's folders, or a link that opens the viewer.
import { fileKind } from "@grove/core/pure";
import { Fragment, memo, type ReactNode, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FILE_SCHEME, sessionUrl } from "../../shared/sessionUrl.ts";
import { highlight, highlighted, type Run } from "../logic/highlight.ts";
import { localPath, webLink } from "../logic/links.ts";
import { useChatScope } from "../state/chatScope.ts";
import { MermaidDiagram } from "./Mermaid.tsx";

/** an image the agent pointed at: one of the session's files, in a chat window. else its words */
function Image({ src, alt }: { src?: string; alt?: string }) {
  const scope = useChatScope();
  const file = scope && localPath(src, scope.base);
  if (!scope || !file || fileKind(file) !== "image") {
    // remote images are blocked by the page's CSP anyway. a broken image says less than its words.
    return alt ? <span className="md-alt">{alt}</span> : null;
  }
  return (
    <img
      className="md-img"
      src={sessionUrl(FILE_SCHEME, scope.session, file)}
      alt={alt ?? ""}
      title={file}
      onClick={() => scope.open?.(file)}
    />
  );
}

/** a link to a file: opened beside the conversation, in a chat window */
function FileLink({ href, children }: { href?: string; children: ReactNode }) {
  const scope = useChatScope();
  const file = scope?.open && localPath(href, scope.base);
  if (!file) return <span>{children}</span>;
  return (
    <button type="button" className="md-file" title={file} onClick={() => scope?.open?.(file)}>
      {children}
    </button>
  );
}

/**
 * code in colour, from shiki in a worker. a block still being written is coloured as far as it
 * held still, and the rest of it follows as it is
 */
export function Highlighted({ lang, code }: { lang: string; code: string }) {
  const [got, setGot] = useState(() => ({ code, lines: highlighted(lang, code) ?? null }));
  useEffect(() => {
    const known = highlighted(lang, code);
    if (known !== undefined) return setGot({ code, lines: known });
    let live = true;
    // a block being streamed changes every frame: it is asked for once it holds still
    const soon = setTimeout(() => {
      void highlight(lang, code).then((lines) => live && setGot({ code, lines }));
    }, 150);
    return () => {
      live = false;
      clearTimeout(soon);
    };
  }, [lang, code]);
  const lines: Run[][] | null = got.lines && code.startsWith(got.code) ? got.lines : null;
  return (
    <code data-lang={lang}>
      {lines?.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's place is what it is
        <Fragment key={i}>
          {i > 0 && "\n"}
          {line.map(([text, light, dark], j) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a run's place is what it is
              key={j}
              style={light ? { color: `light-dark(${light}, ${dark || light})` } : undefined}
            >
              {text}
            </span>
          ))}
        </Fragment>
      ))}
      {lines ? code.slice(got.code.length) : code}
    </code>
  );
}

/** a fenced block with a language is coloured in a chat window. anything else is as it was */
function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const scope = useChatScope();
  const lang = /\blanguage-(\S+)/.exec(className ?? "")?.[1];
  if (!scope || !lang || typeof children !== "string") {
    return <code className={className}>{children}</code>;
  }
  const code = children.replace(/\n$/, "");
  if (lang === "mermaid") return <MermaidDiagram code={code} />;
  return <Highlighted lang={lang} code={code} />;
}

const components: Components = {
  a: ({ href, children }) => {
    const url = webLink(href);
    if (!url) return <FileLink href={href}>{children}</FileLink>;
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
  img: ({ src, alt }) => <Image src={typeof src === "string" ? src : undefined} alt={alt} />,
  code: ({ className, children }) => <Code className={className}>{children}</Code>,
};

const plugins = [remarkGfm];

/** markdown from an agent, as quiet as the rest of the page */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={className ? `md ${className}` : "md"}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
