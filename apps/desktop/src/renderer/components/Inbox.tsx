import { useEffect, useMemo, useRef } from "react";
import type { InboxRowView } from "../../shared/ipc.ts";
import { nextActiveKey } from "../logic/rows.ts";
import { projectRows } from "../logic/views.ts";
import { whoView } from "../logic/who.ts";
import { focusScreen, openRow, openWith, optionId, review } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Avatar, Button, Icon, KindLabel, kindWord, RuntimeChip, Time } from "./ui.tsx";

/** two lines: what it is and whose, then the summary at full width */
function InboxRow({ row, active }: { row: InboxRowView; active: boolean }) {
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
      className="cv-row group fade relative border-b border-line px-3 py-2 hover:bg-raised data-[active]:bg-raised"
      onClick={() => openRow(row)}
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
        {/* invisible, not gone: it keeps its room and the buttons sit over it */}
        <span className="flex shrink-0 items-center gap-3 group-hover:invisible group-data-[active]:invisible">
          {/* avatar 16 + 6 + the name: `chat-features-35`, a real tab name, is 103.9 */}
          <span className="flex w-[126px] min-w-0 items-center gap-1.5">
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
          <span className="w-[80px]">{row.runtime && <RuntimeChip runtime={row.runtime} />}</span>
          <Time at={row.at} className="w-[60px] text-right" />
        </span>
        {/* a click in here is a button's, never the row's */}
        <span
          className="absolute top-2 right-3 hidden items-center gap-1.5 group-hover:flex group-data-[active]:flex"
          onClick={(e) => e.stopPropagation()}
        >
          {row.sessionKey && row.open && (
            <Button
              size="sm"
              tabIndex={-1}
              disabled={!!row.open.disabled}
              title={row.open.disabled}
              data-testid="inbox-open"
              onClick={() => openWith(row.sessionKey, row.open, row.card?.id ?? row.title)}
            >
              Open in {editor}
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

/** the inbox screen (ui.md 4.1): this project's rows in main's order, Asked and Stopped first */
export function Inbox() {
  const inbox = useStore((s) => s.inbox);
  const project = useStore((s) => s.project);
  // no row looks like the keyboard's until a key says so
  const active = useStore((s) => (s.keys ? s.active.inbox : null));
  const rows = useMemo(() => projectRows(inbox, project), [inbox, project]);
  const before = useRef<string[]>([]);
  const some = rows.length > 0;

  // the list holds the keyboard: when the screen mounts, and when the first row arrives after it
  // (the record is read once the page is up). never from under a dialog or the palette
  useEffect(() => {
    const s = useStore.getState();
    if (some && !s.overlay && !s.dialog) focusScreen();
  }, [some]);

  // a row that left hands the keyboard to the one that took its place
  useEffect(() => {
    const ids = rows.map((r) => r.id);
    const s = useStore.getState();
    const next = nextActiveKey(before.current, ids, s.active.inbox, false);
    before.current = ids;
    if (next !== s.active.inbox) s.set({ active: { ...s.active, inbox: next } });
  }, [rows]);

  return (
    // the gutter stays, so the column does not move when the list grows long enough to scroll
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]" data-testid="inbox">
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
              <InboxRow key={r.id} row={r} active={r.id === active} />
            ))}
          </ul>
        ) : (
          <p className="py-28 text-center text-body text-fg" data-testid="inbox-empty">
            Nothing needs you.
          </p>
        )}
      </div>
    </div>
  );
}
