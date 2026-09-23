import { formatRelativeTime, highlightRanges, type LiveStatus } from "@grove/core/pure";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, type ReactNode, useEffect, useRef } from "react";
import type { SessionKey, SessionRow } from "../../shared/ipc.ts";
import { agentsChip, agentsTooltip } from "../logic/agents.ts";
import { type ListItem, NEEDS_YOU } from "../logic/rows.ts";
import { usageChip, usageTooltip } from "../logic/usage.ts";
import { cx, Icon, Mono } from "./ui.tsx";

const ROW = 56;
const HEADER = 30;

export function optionId(key: SessionKey): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return `session-${(h >>> 0).toString(36)}`;
}

function Highlighted({ text, tokens }: { text: string; tokens: readonly string[] }) {
  const ranges = highlightRanges(text, tokens);
  if (ranges.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push(text.slice(at, start));
    out.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/**
 * what the session is doing now. only the states that ask something of a person take the accent;
 * running is quiet, and a turn someone already looked at says nothing at all.
 */
function LiveBadge({ live }: { live: LiveStatus }) {
  const label =
    live.state === "permission"
      ? "Needs permission"
      : live.state === "failed"
        ? "Stopped"
        : live.state === "running"
          ? "Running"
          : live.seen
            ? null
            : "Your turn";
  if (!label) return null;
  const loud = live.state === "permission" || live.state === "failed";
  return (
    <span
      data-testid="live-badge"
      data-state={live.state}
      title={live.detail}
      className={cx(
        "flex shrink-0 items-center gap-1.5 text-sm",
        loud ? "text-accent" : live.state === "running" ? "text-fg-3" : "text-fg-2",
      )}
    >
      <span
        className={cx(
          "size-1.5 rounded-full",
          loud ? "bg-accent" : live.state === "running" ? "live-pulse bg-fg-3" : "bg-fg-2",
        )}
      />
      {label}
    </span>
  );
}

interface RowProps {
  row: SessionRow;
  secondary: string;
  tokens: readonly string[];
  active: boolean;
  now: number;
  index: number;
  total: number;
  onActivate: (key: SessionKey, el: HTMLElement) => void;
  onMenu: (key: SessionKey, el: HTMLElement) => void;
}

const SessionRowView = memo(function SessionRowView(p: RowProps) {
  const { row } = p;
  const untitled = !row.title;
  return (
    <div
      id={optionId(row.key)}
      role="option"
      aria-selected={p.active}
      aria-posinset={p.index + 1}
      aria-setsize={p.total}
      data-testid="session-row"
      data-active={p.active || undefined}
      onClick={(e) => p.onActivate(row.key, e.currentTarget)}
      onKeyDown={() => {}}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onMenu(row.key, e.currentTarget);
      }}
      className={cx(
        "fade mx-2 flex h-[52px] flex-col justify-center rounded-md px-3",
        p.active ? "bg-active" : "hover:bg-raised",
      )}
    >
      <div className="flex items-baseline gap-3">
        <span
          className={cx("min-w-0 flex-1 truncate font-medium", untitled ? "text-fg-3" : "text-fg")}
        >
          {untitled ? "Untitled session" : <Highlighted text={row.title ?? ""} tokens={p.tokens} />}
        </span>
        {row.live && <LiveBadge live={row.live} />}
        <span
          className={cx(
            "shrink-0 text-sm tabular-nums",
            p.now - row.activityMs < 60_000 ? "text-fg-2" : "text-fg-3",
          )}
          title={new Date(row.activityMs).toLocaleString()}
        >
          {formatRelativeTime(row.activityMs, p.now)}
        </span>
      </div>
      <div className="flex items-baseline gap-3 text-sm text-fg-3">
        <span className="min-w-0 flex-1 truncate">
          {p.secondary ? (
            <Highlighted text={p.secondary} tokens={p.tokens} />
          ) : untitled ? (
            row.projectLabel
          ) : (
            " "
          )}
        </span>
        <span className="flex shrink-0 items-baseline gap-2.5">
          {/* an archived row only shows under `is:archived` or in "Needs you" - say which it is */}
          {row.archived && (
            <span data-testid="row-archived" className="shrink-0 text-fg-4">
              Archived
            </span>
          )}
          {/* quiet: agents fanning out is the session working, not the session asking for anything */}
          {row.agents && row.agents.length > 0 && (
            <span
              data-testid="row-agents"
              className="max-w-64 truncate text-fg-3"
              title={agentsTooltip(row.agents)}
            >
              {agentsChip(row.agents, p.now)}
            </span>
          )}
          {row.usage && row.usage.length > 0 && (
            <Mono className="max-w-56 truncate text-fg-4" title={usageTooltip(row.usage)}>
              <span data-testid="row-usage">
                <Highlighted text={usageChip(row.usage)} tokens={p.tokens} />
              </span>
            </Mono>
          )}
          {row.prNumber !== undefined && (
            <Mono className="text-fg-3">
              <Highlighted text={`#${row.prNumber}`} tokens={p.tokens} />
            </Mono>
          )}
          {row.gitBranch && (
            <span className="flex max-w-52 items-center gap-1 self-center">
              <Icon name="branch" size={11} className="text-fg-4" />
              <Mono className="truncate">
                <Highlighted text={row.gitBranch} tokens={p.tokens} />
              </Mono>
            </span>
          )}
          {/* a combo name, or the folder's basename. never a raw path - that lives in the tooltip. */}
          {row.comboName ? (
            <span className="max-w-40 truncate text-fg-2" data-testid="row-combo">
              <Highlighted text={row.comboName} tokens={p.tokens} />
            </span>
          ) : (
            <Mono className="max-w-40 truncate" title={row.cwd}>
              <Highlighted text={row.cwdBase ?? row.projectLabel} tokens={p.tokens} />
            </Mono>
          )}
        </span>
      </div>
    </div>
  );
});

export function SessionList({
  items,
  tokens,
  activeKey,
  now,
  listId,
  total,
  onActivate,
  onMenu,
  onPageSize,
}: {
  items: ListItem[];
  tokens: readonly string[];
  activeKey: SessionKey | null;
  now: number;
  listId: string;
  total: number;
  onActivate: (key: SessionKey, el: HTMLElement) => void;
  onMenu: (key: SessionKey, el: HTMLElement) => void;
  onPageSize: (rows: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (items[i]?.type === "header" ? HEADER : ROW),
    getItemKey: (i) => items[i]?.id ?? i,
    overscan: 12,
  });

  // off-screen options are not in the DOM, so scroll first and let aria-activedescendant follow
  useEffect(() => {
    if (!activeKey) return;
    const index = items.findIndex((it) => it.type === "row" && it.id === activeKey);
    if (index >= 0) virtualizer.scrollToIndex(index <= 1 ? 0 : index, { align: "auto" });
  }, [activeKey, items, virtualizer]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const report = () => onPageSize(Math.max(1, Math.floor(el.clientHeight / ROW)));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onPageSize]);

  let rowIndex = -1;
  const positions = new Map<string, number>();
  for (const it of items) if (it.type === "row") positions.set(it.id, ++rowIndex);

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto pb-3"
      data-testid="session-scroller"
    >
      <div
        id={listId}
        role="listbox"
        aria-label="Sessions"
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const item = items[v.index];
          if (!item) return null;
          return (
            <div
              key={v.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: v.size,
                transform: `translateY(${v.start}px)`,
              }}
            >
              {item.type === "header" ? (
                <div
                  role="presentation"
                  data-testid={item.label === NEEDS_YOU ? "needs-you-header" : undefined}
                  className={cx(
                    "flex h-full items-end px-5 pb-1.5 text-meta font-medium tracking-wide",
                    item.label === NEEDS_YOU ? "text-accent" : "text-fg-3",
                  )}
                >
                  {item.label}
                </div>
              ) : (
                <div className="flex h-full items-center">
                  <div className="min-w-0 flex-1">
                    <SessionRowView
                      row={item.row}
                      secondary={item.secondary}
                      tokens={tokens}
                      active={item.id === activeKey}
                      now={now}
                      index={positions.get(item.id) ?? 0}
                      total={total}
                      onActivate={onActivate}
                      onMenu={onMenu}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
