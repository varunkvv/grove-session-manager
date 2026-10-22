// grove chat's files: a card in the turn for what the session wrote or looked at, a list of every
// file it wrote with the project's plans and artifacts, and a viewer beside the conversation. all
// of it is the agent's: images go through <img>, videos through <video>, html only into a
// sandboxed frame, text through the same Markdown the conversation has, and every path through
// main's check of the session's folders.
import { type FileMark, fileKind } from "@grove/core/pure";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatChange, ChatFileText } from "../../shared/ipc.ts";
import { FILE_SCHEME, HTML_SCHEME, sessionUrl } from "../../shared/sessionUrl.ts";
import { dirOf } from "../logic/links.ts";
import { ChatScopeContext, useChatScope } from "../state/chatScope.ts";
import { Highlighted, Markdown } from "./Markdown.tsx";
import { cx, Diff, DiffCount, Icon, IconButton, Spinner } from "./ui.tsx";

const api = () => window.grove;

const nameOf = (file: string) => file.slice(file.lastIndexOf("/") + 1);

/** where a file is, as short as the session's own folder lets it be said */
function whereOf(file: string, cwd: string): string {
  const dir = dirOf(file);
  if (dir === cwd) return "";
  return dir.startsWith(`${cwd}/`) ? dir.slice(cwd.length + 1) : dir;
}

const KIND_WORD = { image: "Image", video: "Video", markdown: "Markdown", html: "Page" } as const;

/** the files a turn wrote that can be looked at, and the images it read */
export function OutputCards({ outputs }: { outputs: readonly FileMark[] }) {
  const scope = useChatScope();
  if (!scope) return null;
  return (
    <div className="mt-3 flex flex-wrap items-start gap-2" data-testid="outputs">
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

/** a changed file's diff against the last commit, read again when the file changes */
function ChangeDiff({ file, v }: { file: string; v: number }) {
  const [lines, setLines] = useState<string[] | string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: v is when to read it again
  useEffect(() => {
    let live = true;
    void api()
      .chatChangeDiff(file)
      .then((o) => live && setLines(o.ok ? o.value : o.error.message));
    return () => {
      live = false;
    };
  }, [file, v]);
  if (lines === undefined) return <Spinner />;
  if (typeof lines === "string") return <p className="text-fg-3">{lines}</p>;
  if (lines.length === 0) return <p className="text-fg-3">No change from the last commit.</p>;
  return <Diff lines={lines} className="max-h-none!" />;
}

/**
 * an image at the panel's width, and on a click at its own size, scrolling both ways, when that is
 * bigger. the spot clicked stays under the pointer
 */
function ImageFile({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const at = useRef<{ fx: number; fy: number; x: number; y: number }>(null);
  const [big, setBig] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  // only fitted is its width the panel's say
  const measure = (img: HTMLImageElement) => !zoomed && setBig(img.naturalWidth > img.clientWidth);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a zoom is when to move the scroll
  useLayoutEffect(() => {
    const img = ref.current;
    const box = img?.parentElement;
    if (!img || !box || !at.current) return;
    const r = img.getBoundingClientRect();
    box.scrollLeft += r.left + at.current.fx * r.width - at.current.x;
    box.scrollTop += r.top + at.current.fy * r.height - at.current.y;
  }, [zoomed]);
  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      className={cx(
        "mx-auto block",
        zoomed ? "max-w-none cursor-zoom-out" : cx("max-w-full", big && "cursor-zoom-in"),
      )}
      onLoad={(e) => measure(e.currentTarget)}
      onMouseEnter={(e) => measure(e.currentTarget)}
      onClick={(e) => {
        if (!big) return;
        const r = e.currentTarget.getBoundingClientRect();
        at.current = {
          fx: (e.clientX - r.left) / r.width,
          fy: (e.clientY - r.top) / r.height,
          x: e.clientX,
          y: e.clientY,
        };
        setZoomed(!zoomed);
      }}
      data-testid="viewer-image"
      data-zoomed={zoomed || undefined}
    />
  );
}

/** a file the viewer has open: drawn for what it is, and again whenever it changes on disk */
export function Viewer({
  file,
  diff,
  onList,
  onClose,
}: {
  file: string;
  /** what changed in it since the last commit, not the file itself */
  diff?: boolean;
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
          {diff && <span className="text-fg-3">Changes in </span>}
          <span className="font-medium text-fg">{nameOf(file)}</span>
          {whereOf(file, scope.base) && (
            <span className="text-sm text-fg-4"> · {whereOf(file, scope.base)}</span>
          )}
        </span>
        <IconButton label="Close" onClick={onClose} data-testid="viewer-close">
          <Icon name="x" size={12} />
        </IconButton>
      </div>
      {diff ? (
        <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="viewer-diff">
          <ChangeDiff file={file} v={v} />
        </div>
      ) : kind === "html" ? (
        // no allow-same-origin: an opaque origin, so the page reaches nothing of grove's
        <iframe
          key={v}
          title={nameOf(file)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={sessionUrl(HTML_SCHEME, scope.session, file, v)}
          className="page-frame min-h-0 w-full flex-1"
          data-testid="viewer-frame"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {kind === "image" ? (
            // another file is fitted again
            <ImageFile
              key={file}
              src={sessionUrl(FILE_SCHEME, scope.session, file, v)}
              alt={nameOf(file)}
            />
          ) : kind === "video" ? (
            // never plays on its own. as tall as the panel at most
            // biome-ignore lint/a11y/useMediaCaption: an agent's recording has no captions to give
            <video
              controls
              preload="metadata"
              src={sessionUrl(FILE_SCHEME, scope.session, file, v)}
              className="mx-auto block max-h-full max-w-full"
              data-testid="viewer-video"
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
  onChange,
}: {
  written: readonly string[];
  /** the transcript moved: a plan or an artifact may have come */
  rev: number;
  onClose: () => void;
  /** a changed file: its diff, in the viewer */
  onChange: (file: string) => void;
}) {
  const scope = useChatScope();
  const [listed, setListed] = useState<{ plans: string[]; artifacts: string[] }>();
  const [changes, setChanges] = useState<ChatChange[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev is when to look again
  useEffect(() => {
    void api()
      .chatFiles()
      .then(setListed)
      .catch(() => setListed({ plans: [], artifacts: [] }));
    void api()
      .chatChanges()
      .then(setChanges)
      .catch(() => setChanges([]));
  }, [rev]);
  const ins = changes.reduce((n, c) => n + (c.added ?? 0), 0);
  const del = changes.reduce((n, c) => n + (c.removed ?? 0), 0);
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
        {changes.length > 0 && (
          <div className="mb-3" data-testid="changes">
            <h3 className="flex items-center gap-2 px-2 py-1 text-sm font-medium text-fg-4">
              <span className="flex-1">Not committed</span>
              <DiffCount added={ins} removed={del} />
            </h3>
            {changes.map((c) => (
              <button
                key={c.path}
                type="button"
                title={c.path}
                data-testid="change-item"
                onClick={() => onChange(c.path)}
                className="fade flex w-full min-w-0 flex-col rounded-md px-2 py-1 text-left hover:bg-raised"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-fg">{nameOf(c.path)}</span>
                  {c.fresh ? (
                    <span className="shrink-0 text-sm text-fg-4">new</span>
                  ) : (
                    <DiffCount added={c.added} removed={c.removed} />
                  )}
                </span>
                {whereOf(c.path, scope.base) && (
                  <span className="truncate text-sm text-fg-4">{whereOf(c.path, scope.base)}</span>
                )}
              </button>
            ))}
          </div>
        )}
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
        {listed && changes.length === 0 && groups.every(([, f]) => f.length === 0) && (
          <p className="px-2 py-1 text-sm text-fg-4">Nothing written yet.</p>
        )}
      </div>
    </section>
  );
}
