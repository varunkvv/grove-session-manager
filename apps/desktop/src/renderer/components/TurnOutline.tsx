import { tokenize } from "@grove/core/pure";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConversationView } from "../../shared/ipc.ts";
import { filterOutline, outlineOf, outlineRows } from "../logic/conversation.ts";
import { cx, Highlighted } from "./ui.tsx";

const timeOf = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * every prompt of the conversation in one line each, newest at the bottom like the pane below it.
 * typing filters, the arrows pick, Enter goes there. the keys stay here: Escape closes this, not
 * the pane.
 */
export function TurnOutline({
  view,
  now,
  onJump,
  onClose,
}: {
  view: ConversationView;
  now: number;
  onJump: (n: number) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const items = useMemo(() => outlineOf(view), [view]);
  const tokens = useMemo(() => tokenize(filter), [filter]);
  const shown = useMemo(() => filterOutline(items, tokens), [items, tokens]);
  const rows = useMemo(() => outlineRows(shown, now), [shown, now]);
  // the picked prompt's turn. none picked is the newest, where the conversation is now.
  const [picked, setPicked] = useState<number | null>(null);
  const at = Math.max(
    0,
    picked === null ? shown.length - 1 : shown.findIndex((i) => i.n === picked),
  );
  const selected = shown[at];
  const list = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // a new filter starts from the newest again, at the bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: the filter is what resets it
  useLayoutEffect(() => {
    setPicked(null);
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filter]);

  useEffect(() => {
    if (selected === undefined) return;
    list.current?.querySelector(`[data-n="${selected.n}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  // a click anywhere else closes it, and still does what it was for
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (root.current?.contains(target) || target?.closest?.("[data-outline-toggle]")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  const move = (delta: number) => {
    const next = shown[Math.max(0, Math.min(shown.length - 1, at + delta))];
    if (next) setPicked(next.n);
  };

  return (
    <div
      ref={root}
      data-testid="turn-outline"
      className="absolute top-full right-3 z-30 mt-1 flex max-h-[min(60vh,28rem)] w-[min(28rem,calc(100%-1.5rem))] flex-col rounded-lg bg-overlay p-1.5 overlay-shadow"
    >
      <input
        autoFocus
        data-testid="outline-filter"
        aria-label="Filter prompts"
        aria-controls="turn-outline-list"
        aria-activedescendant={selected ? `outline-${selected.n}` : undefined}
        role="combobox"
        aria-expanded="true"
        spellCheck={false}
        autoComplete="off"
        placeholder="Filter prompts"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") move(1);
          else if (e.key === "ArrowUp") move(-1);
          else if (e.key === "PageDown") move(10);
          else if (e.key === "PageUp") move(-10);
          else if (e.key === "Enter") {
            if (selected) onJump(selected.n);
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
        className="mb-1 h-8 shrink-0 rounded-md bg-transparent px-2 text-body text-fg placeholder:text-fg-4 outline-none"
      />
      <div className="mb-1 h-px shrink-0 bg-line" role="separator" />
      <div
        ref={list}
        id="turn-outline-list"
        role="listbox"
        aria-label="Prompts"
        className="min-h-0 overflow-y-auto"
      >
        {shown.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-fg-3" data-testid="outline-empty">
            No prompt says that
          </p>
        )}
        {rows.map((row) =>
          row.type === "day" ? (
            <div
              key={`d:${row.label}`}
              className="px-2 pt-2 pb-1 text-meta font-medium tracking-wide text-fg-3"
              data-testid="outline-day"
            >
              {row.label}
            </div>
          ) : (
            <div
              key={row.item.n}
              id={`outline-${row.item.n}`}
              role="option"
              aria-selected={row.item.n === selected?.n}
              data-testid="outline-item"
              data-n={row.item.n}
              data-selected={row.item.n === selected?.n || undefined}
              onMouseEnter={() => setPicked(row.item.n)}
              onClick={() => onJump(row.item.n)}
              title={row.item.line}
              className={cx(
                "flex h-7 cursor-default items-center gap-3 rounded-md px-2 text-sm",
                row.item.n === selected?.n ? "bg-active text-fg" : "text-fg-2",
              )}
            >
              <span
                className={cx(
                  "min-w-0 flex-1 truncate",
                  row.item.kind === "command" && "font-mono text-meta",
                  row.item.kind === "task" && "text-fg-3",
                )}
              >
                <Highlighted text={row.item.line} tokens={tokens} />
              </span>
              <span className="shrink-0 font-mono text-meta tabular-nums text-fg-4">
                {timeOf(row.item.at)}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
