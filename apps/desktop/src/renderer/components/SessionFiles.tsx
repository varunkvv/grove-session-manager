// a session's files under its row in the list: the chat's own list, compact. read when it opens,
// not kept: the list is asked again each time it is opened.
import { useEffect, useState } from "react";
import type { SessionKey } from "../../shared/ipc.ts";
import { type SessionFile, splitSessionFiles } from "../logic/sessionFiles.ts";
import { openChat } from "../state/actions.ts";
import { cx, DiffCount, Icon, Spinner } from "./ui.tsx";

/** the chevron on a row: opens its files under it. a click here is the chevron's, not the row's */
export function FilesChevron({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-expanded={open}
      aria-label={open ? "Hide files" : "Show files"}
      data-testid="session-files-toggle"
      className="fade flex size-4 shrink-0 items-center justify-center rounded text-fg-4 hover:text-fg"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon name="chevron" size={10} faint className={cx(open && "rotate-90")} />
    </button>
  );
}

/**
 * a session's files: its name, the edited ones with their counts above the read ones, which are
 * quieter. a click opens its chat window on that file
 */
export function SessionFiles({ session, title }: { session: SessionKey; title: string }) {
  const [files, setFiles] = useState<{ edited: SessionFile[]; read: SessionFile[] }>();
  useEffect(() => {
    let live = true;
    void window.grove
      .sessionFiles(session)
      .then(({ files, changes }) => live && setFiles(splitSessionFiles(files, changes)))
      .catch(() => live && setFiles({ edited: [], read: [] }));
    return () => {
      live = false;
    };
  }, [session]);
  // a click in here is the file's, never the row's: the row opens the session
  return (
    <div className="mt-1 pl-5" data-testid="session-files" onClick={(e) => e.stopPropagation()}>
      {!files ? (
        <Spinner size={10} />
      ) : files.edited.length + files.read.length === 0 ? (
        <p className="text-sm text-fg-4">Nothing written yet.</p>
      ) : (
        <>
          {files.edited.map((f) => (
            <button
              key={f.path}
              type="button"
              tabIndex={-1}
              title={f.path}
              data-testid="session-file"
              data-edited
              onClick={() => openChat(session, title, { file: f.path })}
              className="fade flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-raised"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{nameOf(f.path)}</span>
              {f.fresh ? (
                <span className="shrink-0 text-sm text-fg-4">new</span>
              ) : (
                <DiffCount added={f.added} removed={f.removed} />
              )}
            </button>
          ))}
          {files.read.map((f) => (
            <button
              key={f.path}
              type="button"
              tabIndex={-1}
              title={f.path}
              data-testid="session-file"
              onClick={() => openChat(session, title, { file: f.path })}
              className="fade flex w-full min-w-0 rounded px-1 py-0.5 text-left hover:bg-raised"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-fg-4">{nameOf(f.path)}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

const nameOf = (file: string) => file.slice(file.lastIndexOf("/") + 1);
