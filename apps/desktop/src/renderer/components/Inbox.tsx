import { useEffect, useMemo } from "react";
import type { InboxRowView } from "../../shared/ipc.ts";
import { focusScreen, openRow, openWith, optionId, perform, review } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { SessionPanel, useHandoff } from "./SessionPanel.tsx";
import {
  Button,
  cx,
  Icon,
  ProjectMark,
  RuntimeChip,
  Split,
  StateLabel,
  stateWord,
  Time,
  useRowDoubleClick,
} from "./ui.tsx";

/** what Open in {editor} and a double-click go to */
const openSession = (row: InboxRowView) => openWith(row.key, row.open, row.title);

/** two lines: which session and what it is at, then what it asks at full width */
function InboxRow({
  row,
  active,
  open,
  onClick,
}: {
  row: InboxRowView;
  active: boolean;
  /** it is the one in the panel */
  open: boolean;
  onClick: () => void;
}) {
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  return (
    <li
      id={optionId(row.sessionId)}
      role="option"
      aria-selected={active}
      aria-label={`${stateWord(row.kind)}: ${row.title}, in ${row.where}. ${row.summary}`}
      data-testid="inbox-row"
      data-kind={row.kind}
      data-id={row.sessionId}
      data-project={row.project}
      data-active={active || undefined}
      data-open={open || undefined}
      className={cx(
        "cv-row group fade border-b border-line px-3 py-2",
        // the open row is marked whoever moved last. hover and the keyboard's row are the lighter grey
        open ? "bg-active" : "hover:bg-raised data-[active]:bg-raised",
      )}
      onClick={onClick}
      // the row under the mouse is the one the next key acts on
      onMouseMove={() => {
        const s = useStore.getState();
        if (s.active.inbox !== row.sessionId) {
          s.set({ active: { ...s.active, inbox: row.sessionId } });
        }
      }}
    >
      <div className="flex h-5 items-center gap-3">
        <span className="min-w-0 flex-1 truncate font-medium text-fg" title={row.title}>
          {row.title}
        </span>
        <StateLabel state={row.kind} within="list" className="@xl:w-[128px]" />
        {/* the buttons take its place under the mouse and on the keyboard's row */}
        <span className="flex shrink-0 items-center gap-3 group-hover:hidden group-data-[active]:hidden">
          {/* where it is gives way to the title as the list narrows: first where it runs, then
              beside the panel the project's name. the project's colour stays */}
          <span className="flex min-w-0 items-center gap-1.5 @xl:w-[132px]" title={row.where}>
            <ProjectMark id={row.project} />
            <span className="hidden truncate text-fg-3 @xl:inline" data-testid="inbox-project">
              {row.where}
            </span>
          </span>
          <span className="hidden w-[80px] @3xl:block">
            <RuntimeChip runtime={row.runtime} />
          </span>
          <Time at={row.at} className="w-[60px] text-right" />
        </span>
        {/* a click in here is a button's, never the row's. 296 is the three cells it replaces (132
            + 80 + 60 and two gaps) and 204 the two of a list without the runtime, so the title of
            a row does not move. beside the panel they are wider than what they replace: the title
            gives way, and Open drops the editor's name */}
        <span
          className="hidden shrink-0 items-center justify-end gap-1.5 group-hover:flex group-data-[active]:flex @xl:min-w-[204px] @3xl:min-w-[296px]"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            size="sm"
            tabIndex={-1}
            disabled={!!row.open.disabled}
            title={row.open.disabled}
            data-testid="inbox-open"
            onClick={() => openSession(row)}
          >
            {/* one span: the button is a flex row, and two would get its gap between them */}
            <span>
              Open<span className="hidden @3xl:inline"> in {editor}</span>
            </span>
          </Button>
          <Button
            size="sm"
            tabIndex={-1}
            data-testid="inbox-dismiss"
            onClick={() => void review(row.project, row.reviewKeys)}
          >
            <Icon name="check" size={10} />
            Dismiss
          </Button>
        </span>
      </div>
      {row.summary && (
        <p
          className="mt-0.5 line-clamp-2 text-fg-2"
          title={row.summary}
          data-testid="inbox-summary"
        >
          {row.summary}
        </p>
      )}
    </li>
  );
}

/**
 * the inbox: every project's sessions that need the person, newest first, in main's order. a
 * click opens a session in the panel beside the list
 */
export function Inbox() {
  const rows = useStore((s) => s.inbox.rows);
  // no row looks like the keyboard's until a key says so
  const active = useStore((s) => (s.keys ? s.active.inbox : null));
  const peek = useStore((s) => s.peek);
  const ids = useMemo(() => rows.map((r) => r.sessionId), [rows]);
  const some = rows.length > 0;
  const open = rows.find((r) => r.sessionId === peek);
  const pair = useRowDoubleClick(openSession);

  // the list holds the keyboard: when the screen mounts, and when the first row arrives after it.
  // never from under a dialog or the palette
  useEffect(() => {
    const s = useStore.getState();
    if (some && !s.overlay && !s.dialog) focusScreen();
  }, [some]);
  useHandoff("inbox", ids);

  return (
    <Split
      testId="inbox"
      root={pair.root}
      label={open && `${stateWord(open.kind)}: ${open.title}`}
      panel={
        open && (
          <SessionPanel
            key={open.sessionId}
            session={open}
            project={open.project}
            state={open.kind}
            at={open.at}
            row={open}
            // the same as Escape
            onClose={() => perform({ type: "close-panel" })}
          />
        )
      }
    >
      {some ? (
        <ul
          role="listbox"
          aria-label="Inbox"
          tabIndex={0}
          data-list
          aria-activedescendant={active ? optionId(active) : undefined}
          className="border-t border-line"
        >
          {rows.map((r) => (
            <InboxRow
              key={r.sessionId}
              row={r}
              active={r.sessionId === active}
              open={r.sessionId === peek}
              onClick={() => {
                pair.clicked(r);
                openRow("inbox", r.sessionId);
              }}
            />
          ))}
        </ul>
      ) : (
        <p className="py-28 text-center text-body text-fg" data-testid="inbox-empty">
          Nothing needs you.
        </p>
      )}
    </Split>
  );
}
