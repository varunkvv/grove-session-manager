// grove chat's files: a card in the turn for what the session wrote or looked at, a list of every
// file it wrote with the project's plans and artifacts, and a viewer beside the conversation. all
// of it is the agent's: images go through <img>, html only into a sandboxed frame, text through
// the same Markdown the conversation has, and every path through main's check of the session's
// folders.
import { type FileMark, fileKind } from "@grove/core/pure";
import { useEffect, useState } from "react";
import type { ChatFileText } from "../../shared/ipc.ts";
import { FILE_SCHEME, HTML_SCHEME, sessionUrl } from "../../shared/sessionUrl.ts";
import { dirOf } from "../logic/links.ts";
import { ChatScopeContext, useChatScope } from "../state/chatScope.ts";
import { Highlighted, Markdown } from "./Markdown.tsx";
import { cx, Icon, IconButton, Spinner } from "./ui.tsx";

const api = () => window.grove;

const nameOf = (file: string) => file.slice(file.lastIndexOf("/") + 1);

/** where a file is, as short as the session's own folder lets it be said */
function whereOf(file: string, cwd: string): string {
  const dir = dirOf(file);
  if (dir === cwd) return "";
  return dir.startsWith(`${cwd}/`) ? dir.slice(cwd.length + 1) : dir;
}

const KIND_WORD = { image: "Image", markdown: "Markdown", html: "Page" } as const;

/** the files a turn wrote that can be looked at, and the images it read */
export function OutputCards({ outputs }: { outputs: readonly FileMark[] }) {
  const scope = useChatScope();
  if (!scope) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid="outputs">
      {outputs.map((o) => {
        const kind = fileKind(o.path);
        const open = () => scope.open?.(o.path);
        if (kind === "image") {
          return (
            <button
              key={o.path}
              type="button"
              title={o.path}
              data-testid="output-card"
              data-kind="image"
              onClick={open}
              className="fade overflow-hidden rounded-md border border-line hover:border-line-strong"
            >
              <img
                src={sessionUrl(FILE_SCHEME, scope.session, o.path)}
                alt={nameOf(o.path)}
                className="block max-h-44 max-w-[320px] bg-raised"
              />
              <span className="block truncate border-t border-line px-2 py-1 text-left text-sm text-fg-3">
                {o.read ? "Read " : ""}
                {nameOf(o.path)}
              </span>
            </button>
          );
        }
        return (
          <button
            key={o.path}
            type="button"
            title={o.path}
            data-testid="output-card"
            data-kind={kind}
            onClick={open}
            className="fade flex min-w-0 max-w-full items-center gap-2.5 rounded-md border border-line px-3 py-2 text-left hover:border-line-strong hover:bg-raised"
          >
            <Icon name="file" faint />
            <span className="min-w-0">
              <span className="block truncate font-medium text-fg">{nameOf(o.path)}</span>
              <span className="block truncate text-sm text-fg-4">
                {kind ? KIND_WORD[kind] : "File"}
                {whereOf(o.path, scope.base) && ` · ${whereOf(o.path, scope.base)}`}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** a file the viewer has open: drawn for what it is, and again whenever it changes on disk */
export function Viewer({
  file,
  onList,
  onClose,
}: {
  file: string;
  onList: () => void;
  onClose: () => void;
}) {
  const scope = useChatScope();
  const [v, setV] = useState(0);
  useEffect(() => {
    void api().chatWatch(file);
    const off = api().on("chat:file", () => setV((n) => n + 1));
    return () => {
      off();
      void api().chatWatch(null);
    };
  }, [file]);
  if (!scope) return null;
  const kind = fileKind(file);
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-line"
      data-testid="viewer"
      data-file={file}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-3">
        <IconButton label="All files" onClick={onList} data-testid="viewer-list">
          <Icon name="chevron" size={12} className="rotate-180" />
        </IconButton>
        <span className="min-w-0 flex-1 truncate" title={file}>
          <span className="font-medium text-fg">{nameOf(file)}</span>
          {whereOf(file, scope.base) && (
            <span className="text-sm text-fg-4"> · {whereOf(file, scope.base)}</span>
          )}
        </span>
        <IconButton label="Close" onClick={onClose} data-testid="viewer-close">
          <Icon name="x" size={12} />
        </IconButton>
      </div>
      {kind === "html" ? (
        // no allow-same-origin: an opaque origin, so the page reaches nothing of grove's
        <iframe
          key={v}
          title={nameOf(file)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={sessionUrl(HTML_SCHEME, scope.session, file, v)}
          className="min-h-0 w-full flex-1 bg-white"
          data-testid="viewer-frame"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {kind === "image" ? (
            <img
              src={sessionUrl(FILE_SCHEME, scope.session, file, v)}
              alt={nameOf(file)}
              className="mx-auto block max-w-full"
              data-testid="viewer-image"
            />
          ) : (
            <TextFile file={file} v={v} />
          )}
        </div>
      )}
    </section>
  );
}

/** a text file: markdown drawn, from its own folder, anything else as it is */
function TextFile({ file, v }: { file: string; v: number }) {
  const scope = useChatScope();
  const [read, setRead] = useState<{ at: string; got: ChatFileText | string }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: v is when it changed on disk
  useEffect(() => {
    let live = true;
    void api()
      .chatReadFile(file)
      .then((o) => live && setRead({ at: file, got: o.ok ? o.value : o.error.message }));
    return () => {
      live = false;
    };
  }, [file, v]);
  // the last read stays until the next one lands, so a file being rewritten never blinks
  if (!read || read.at !== file) return <Spinner />;
  const got = read.got;
  if (typeof got === "string") return <p className="text-danger">{got}</p>;
  if ("binary" in got) return <p className="text-fg-3">Not a text file.</p>;
  if ("tooBig" in got) {
    return <p className="text-fg-3">Too big to show here: {Math.round(got.tooBig / 1e6)} MB.</p>;
  }
  if (fileKind(file) === "markdown" && scope) {
    return (
      <ChatScopeContext.Provider value={{ ...scope, base: dirOf(file) }}>
        <div data-testid="viewer-text">
          <Markdown text={got.text} className="md-full" />
        </div>
      </ChatScopeContext.Provider>
    );
  }
  return (
    <pre className="selectable font-mono text-sm text-fg-2" data-testid="viewer-text">
      <Highlighted lang={file.slice(file.lastIndexOf(".") + 1)} code={got.text} />
    </pre>
  );
}

/** every file the session wrote, then the project's plans and artifacts */
export function FileList({
  written,
  rev,
  onClose,
}: {
  written: readonly string[];
  /** the transcript moved: a plan or an artifact may have come */
  rev: number;
  onClose: () => void;
}) {
  const scope = useChatScope();
  const [listed, setListed] = useState<{ plans: string[]; artifacts: string[] }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev is when to look again
  useEffect(() => {
    void api()
      .chatFiles()
      .then(setListed)
      .catch(() => setListed({ plans: [], artifacts: [] }));
  }, [rev]);
  if (!scope) return null;
  const groups: Array<[string, readonly string[]]> = [
    ["Written in this session", written],
    ["Plans", listed?.plans ?? []],
    ["Artifacts", listed?.artifacts ?? []],
  ];
  return (
    <section
      className="flex min-h-0 w-72 shrink-0 flex-col border-l border-line bg-chrome"
      data-testid="files"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="flex-1 font-medium text-fg">Files</h2>
        <IconButton label="Close" onClick={onClose} data-testid="files-close">
          <Icon name="x" size={12} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groups.map(([title, files]) =>
          files.length === 0 ? null : (
            <div key={title} className="mb-3">
              <h3 className="px-2 py-1 text-sm font-medium text-fg-4">{title}</h3>
              {files.map((f) => (
                <button
                  key={f}
                  type="button"
                  title={f}
                  data-testid="file-item"
                  onClick={() => scope.open?.(f)}
                  className={cx(
                    "fade flex w-full min-w-0 flex-col rounded-md px-2 py-1 text-left hover:bg-raised",
                  )}
                >
                  <span className="truncate text-fg">{nameOf(f)}</span>
                  {whereOf(f, scope.base) && (
                    <span className="truncate text-sm text-fg-4">{whereOf(f, scope.base)}</span>
                  )}
                </button>
              ))}
            </div>
          ),
        )}
        {listed && groups.every(([, f]) => f.length === 0) && (
          <p className="px-2 py-1 text-sm text-fg-4">Nothing written yet.</p>
        )}
      </div>
    </section>
  );
}
