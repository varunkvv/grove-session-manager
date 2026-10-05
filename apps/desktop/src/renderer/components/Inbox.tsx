import { useEffect, useMemo, useRef } from "react";
import type { InboxRowView } from "../../shared/ipc.ts";
import { nextActiveKey } from "../logic/rows.ts";
import { projectRows } from "../logic/views.ts";
import { whoView } from "../logic/who.ts";
import { focusScreen, openRow, openWith, optionId, perform, review } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { CardPage } from "./CardPage.tsx";
import {
  Avatar,
  Button,
  ConclusionChip,
  cx,
  EscButton,
  Icon,
  KindLabel,
  kindWord,
  RuntimeChip,
  Time,
  useRowDoubleClick,
} from "./ui.tsx";

/** what Open in {editor} and a double-click go to */
const openSession = (row: InboxRowView) =>
  openWith(row.sessionKey, row.open, row.card?.id ?? row.title);

/** two lines: what it is and whose, then the summary at full width */
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
  const who = whoView(row.who);
  return (
    <li
      id={optionId(row.id)}
      role="option"
      aria-selected={active}
      aria-label={`${kindWord(row.kind)}: ${row.card?.id ?? ""} ${row.title}. ${row.summary}`}
      data-testid="inbox-row"
      data-kind={row.kind}
      data-card={row.card?.id}
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
        if (s.active.inbox !== row.id) s.set({ active: { ...s.active, inbox: row.id } });
      }}
    >
      <div className="flex h-5 items-center gap-3">
        <KindLabel kind={row.kind} className="w-[84px]" />
        <span className="min-w-0 flex-1 truncate text-fg-3" title={row.title}>
          {row.card && <span className="mr-1.5 tabular-nums text-fg-4">{row.card.id}</span>}
          {row.title}
        </span>
        {/* the buttons take its place under the mouse and on the keyboard's row */}
        <span className="flex shrink-0 items-center gap-3 group-hover:hidden group-data-[active]:hidden">
          {/* who and where give way to the title in a narrow list, beside the panel */}
          {/* avatar 16 + 6 + the name: `chat-features-35`, a real tab name, is 103.9 */}
          <span className="hidden w-[126px] min-w-0 items-center gap-1.5 @3xl:flex">
            {who && (
              <>
                <Avatar who={who} />
                {/* a session with no card is titled by its own name: the title already says it */}
                {(row.card || who.name !== row.title) && (
                  <span className="truncate text-fg-2">{who.name}</span>
                )}
              </>
            )}
          </span>
          <span className="hidden w-[80px] @3xl:block">
            {row.runtime && <RuntimeChip runtime={row.runtime} />}
          </span>
          <Time at={row.at} className="w-[60px] text-right" />
        </span>
        {/* a click in here is a button's, never the row's. 290 is the three cells it replaces
            (126 + 80 + 60 and two gaps), so the title of a wide row does not move. in a narrow
            list they are wider than the time: the title gives way, and Open drops the editor's name */}
        <span
          className="hidden shrink-0 items-center justify-end gap-1.5 self-start group-hover:flex group-data-[active]:flex @3xl:min-w-[290px]"
          onClick={(e) => e.stopPropagation()}
        >
          {row.sessionKey && row.open && (
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
          )}
          {row.reviewKeys.length > 0 && (
            <Button
              size="sm"
              tabIndex={-1}
              data-testid="inbox-review"
              onClick={() => void review(row.project, row.reviewKeys)}
            >
              <Icon name="check" size={10} />
              Reviewed
            </Button>
          )}
        </span>
      </div>
      {row.summary && (
        <p
          className="mt-0.5 line-clamp-2 pl-[18px] text-fg"
          title={row.summary}
          data-testid="inbox-summary"
        >
          {row.conclusionId && (
            <span className="mr-1.5 font-mono text-sm text-fg-4">{row.conclusionId}</span>
          )}
          {row.summary}
        </p>
      )}
    </li>
  );
}

/** a row with no card has no page to show: the row itself, with its summary whole */
function RowPanel({ row, onClose }: { row: InboxRowView; onClose: () => void }) {
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  const who = whoView(row.who);
  return (
    <div className="flex h-full flex-col" data-testid="row-panel">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <EscButton label="Close" onClick={onClose} />
        <KindLabel kind={row.kind} />
        <h2 className="min-w-0 flex-1 truncate font-semibold" title={row.title}>
          {row.title}
        </h2>
        {row.sessionKey && row.open && (
          <Button
            variant="primary"
            disabled={!!row.open.disabled}
            title={row.open.disabled}
            data-testid="panel-open"
            onClick={() => openSession(row)}
          >
            Open in {editor}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-10 py-7">
        <div className="flex h-5 items-center gap-3">
          {who && (
            <span className="flex min-w-0 items-center gap-1.5">
              <Avatar who={who} />
              {/* a session is titled by its own name: the header already says it */}
              {who.name !== row.title && <span className="truncate text-fg-2">{who.name}</span>}
            </span>
          )}
          {row.runtime && <RuntimeChip runtime={row.runtime} />}
          <Time at={row.at} />
        </div>
        <p
          className="selectable mt-3 whitespace-pre-wrap break-words text-fg"
          data-testid="panel-summary"
        >
          {row.summary}
        </p>
        <div className="mt-5 flex items-center gap-2">
          {row.reviewKeys.length > 0 && (
            <Button
              size="sm"
              data-testid="panel-review"
              onClick={() => void review(row.project, row.reviewKeys)}
            >
              <Icon name="check" size={10} />
              Reviewed
            </Button>
          )}
          {/* the conclusion with its why, its sources and the turn it was recorded in */}
          {row.conclusionId && <ConclusionChip id={row.conclusionId} />}
        </div>
      </div>
    </div>
  );
}

/**
 * the inbox screen (ui.md 4.1): this project's rows in main's order, Asked and Stopped first. a
 * click opens a row in the right half, beside the list
 */
export function Inbox() {
  const inbox = useStore((s) => s.inbox);
  const project = useStore((s) => s.project);
  // no row looks like the keyboard's until a key says so
  const active = useStore((s) => (s.keys ? s.active.inbox : null));
  const peek = useStore((s) => s.peek);
  const rows = useMemo(() => projectRows(inbox, project), [inbox, project]);
  const before = useRef<string[]>([]);
  const some = rows.length > 0;
  const open = rows.find((r) => r.id === peek);
  const pair = useRowDoubleClick(openSession);
  // the same as Escape
  const close = () => perform({ type: "close-panel" });

  // the list holds the keyboard: when the screen mounts, and when the first row arrives after it
  // (the record is read once the page is up). never from under a dialog or the palette
  useEffect(() => {
    const s = useStore.getState();
    if (some && !s.overlay && !s.dialog) focusScreen();
  }, [some]);

  // a row that left hands the keyboard to the one that took its place, and the panel with it
  useEffect(() => {
    const ids = rows.map((r) => r.id);
    const s = useStore.getState();
    const next = nextActiveKey(before.current, ids, s.active.inbox, false);
    // a closed panel stays closed: for a null, nextActiveKey answers the first row
    const peek = s.peek && nextActiveKey(before.current, ids, s.peek, false);
    before.current = ids;
    if (next !== s.active.inbox || peek !== s.peek) {
      s.set({ active: { ...s.active, inbox: next }, peek });
    }
  }, [rows]);

  // the list narrows when the panel opens and the rows above the open one grow: it stays on screen
  useEffect(() => {
    if (peek) document.getElementById(optionId(peek))?.scrollIntoView({ block: "nearest" });
  }, [peek]);

  return (
    <div className="flex h-full" {...pair.root}>
      {/* the gutter stays, so the column does not move when the list grows long enough to scroll.
          a container: a row hides its who and where cells when the list is narrow */}
      <div
        className="@container h-full min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        data-testid="inbox"
      >
        <div className="mx-auto max-w-[860px] px-4 pt-8 pb-16">
          <h1 className="sr-only">Inbox</h1>
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
                  key={r.id}
                  row={r}
                  active={r.id === active}
                  open={r.id === peek}
                  onClick={() => {
                    pair.clicked(r);
                    openRow(r);
                  }}
                />
              ))}
            </ul>
          ) : (
            <p className="py-28 text-center text-body text-fg" data-testid="inbox-empty">
              Nothing needs you.
            </p>
          )}
        </div>
      </div>
      {open && (
        <section
          aria-label={`${kindWord(open.kind)}: ${open.card?.id ?? open.title}`}
          className="h-full w-1/2 shrink-0 border-l border-line"
          data-testid="inbox-panel"
        >
          {open.card ? (
            <CardPage key={open.card.id} cardId={open.card.id} onClose={close} />
          ) : (
            <RowPanel row={open} onClose={close} />
          )}
        </section>
      )}
    </div>
  );
}
