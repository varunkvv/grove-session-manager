import { formatDuration, formatRelativeTime, type LiveStatus } from "@grove/core/pure";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useRef } from "react";
import type { SessionKey, SessionRow } from "../../shared/ipc.ts";
import { agentsChip, agentsCount, agentsTooltip } from "../logic/agents.ts";
import { backgroundTooltip, interruptedTooltip } from "../logic/background.ts";
import { agentName } from "../logic/inspector.ts";
import { type ListItem, NEEDS_YOU } from "../logic/rows.ts";
import { usageChip, usageTooltip } from "../logic/usage.ts";
import { cx, Highlighted, Icon, Mono } from "./ui.tsx";

const ROW = 56;
const HEADER = 30;

export function optionId(key: SessionKey): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return `session-${(h >>> 0).toString(36)}`;
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
  /** a click: read it in the pane */
  onSelect: (key: SessionKey) => void;
  /** a double-click, or the row's open button: go to it */
  onActivate: (key: SessionKey, el: HTMLElement) => void;
  onOpen: (key: SessionKey) => void;
  onMenu: (key: SessionKey, el: HTMLElement) => void;
  onInspect: (key: SessionKey, agent?: string) => void;
  /** the search found this session through one of its agents */
  agentHit?: string;
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
      onClick={(e) => {
        // the second click of a double-click is the double-click's
        if (e.detail < 2) p.onSelect(row.key);
      }}
      onDoubleClick={(e) => p.onActivate(row.key, e.currentTarget)}
      onKeyDown={() => {}}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onMenu(row.key, e.currentTarget);
      }}
      className={cx(
        // a container, so a row made narrow by the inspector beside it drops what matters least
        "fade group @container mx-2 flex h-[52px] flex-col justify-center rounded-md px-3",
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
        {/* the time keeps its room while the button sits over it, so nothing moves on hover. the
            room is at least the button's, or "now" would let it crowd what is beside it */}
        <span className="relative min-w-9 shrink-0 text-right">
          <span
            className={cx(
              "text-sm tabular-nums",
              p.now - row.activityMs < 60_000 ? "text-fg-2" : "text-fg-3",
              p.active ? "invisible" : "group-hover:invisible",
            )}
            title={new Date(row.activityMs).toLocaleString()}
          >
            {formatRelativeTime(row.activityMs, p.now)}
          </span>
          <button
            type="button"
            tabIndex={-1}
            data-testid="row-open"
            title="Open it where it runs - a double-click or ↵ does the same"
            onClick={(e) => {
              e.stopPropagation();
              p.onOpen(row.key);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className={cx(
              "fade absolute inset-y-0 right-0 items-center text-sm text-fg-2 hover:text-fg",
              p.active ? "flex" : "hidden group-hover:flex",
            )}
          >
            Open
          </button>
        </span>
      </div>
      <div className="flex items-baseline gap-3 text-sm text-fg-3">
        <span className="min-w-0 flex-1 truncate">
          {p.secondary && p.agentHit ? (
            // what an agent said: it opens that agent, at what matched
            <button
              type="button"
              tabIndex={-1}
              data-testid="row-agent-hit"
              className="fade max-w-full truncate text-left hover:text-fg-2"
              onClick={(e) => {
                e.stopPropagation();
                p.onInspect(row.key, p.agentHit);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <Highlighted text={p.secondary} tokens={p.tokens} />
            </button>
          ) : p.secondary ? (
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
          {/* quiet on purpose: not the inbox, not a notification. the action menu leads with the fix */}
          {row.interrupted && (
            <span
              data-testid="row-interrupted"
              data-why={row.interrupted.why}
              className="shrink-0 text-fg-3"
              title={interruptedTooltip(row.interrupted, p.now)}
            >
              Interrupted
            </span>
          )}
          {/* quiet like the agents chip: Claude Code's supervisor runs it, whatever it is doing */}
          {row.background && (
            <span
              data-testid="row-background"
              data-state={row.background.state}
              data-held={row.background.held || undefined}
              className="shrink-0 text-fg-3"
              title={backgroundTooltip(row.background)}
            >
              Background
            </span>
          )}
          {/* quiet: agents fanning out is the session working, not the session asking for anything */}
          {row.agents && row.agents.length > 0 && (
            <button
              type="button"
              tabIndex={-1}
              data-testid="row-agents"
              className="fade max-w-64 truncate text-fg-3 hover:text-fg-2"
              title={agentsTooltip(row.agents)}
              onClick={(e) => {
                // what the agents did, not what the row opens
                e.stopPropagation();
                p.onInspect(row.key);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <span className="@max-xl:hidden">{agentsChip(row.agents, p.now)}</span>
              <span className="hidden @max-xl:inline">{agentsCount(row.agents)}</span>
            </button>
          )}
          {row.usage && row.usage.length > 0 && (
            <Mono
              className="max-w-56 truncate text-fg-4 @max-2xl:hidden"
              title={usageTooltip(row.usage)}
            >
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
            <span className="flex max-w-52 items-center gap-1 self-center @max-lg:max-w-28">
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

/**
 * an agent in the Agents scope, in a session row's typography: what it was for and how long ago
 * (or, running, for how long), then the session it ran in and what kind of agent it is.
 */
const AgentRowView = memo(function AgentRowView(p: {
  item: Extract<ListItem, { type: "agent" }>;
  tokens: readonly string[];
  active: boolean;
  now: number;
  index: number;
  total: number;
  onActivate: (key: SessionKey, el: HTMLElement) => void;
  onMenu: (key: SessionKey, el: HTMLElement) => void;
}) {
  const { agent: a, row } = p.item;
  const running = a.state === "running";
  return (
    <div
      id={optionId(p.item.id)}
      role="option"
      aria-selected={p.active}
      aria-posinset={p.index + 1}
      aria-setsize={p.total}
      data-testid="agent-list-row"
      data-state={a.state}
      data-active={p.active || undefined}
      onClick={(e) => p.onActivate(p.item.id, e.currentTarget)}
      onKeyDown={() => {}}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onMenu(p.item.id, e.currentTarget);
      }}
      className={cx(
        "fade mx-2 flex h-[52px] flex-col justify-center rounded-md px-3",
        p.active ? "bg-active" : "hover:bg-raised",
      )}
    >
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate font-medium text-fg">
          <Highlighted text={agentName(a)} tokens={p.tokens} />
        </span>
        {running ? (
          <span className="flex shrink-0 items-center gap-1.5 text-sm tabular-nums text-fg-2">
            <span className="live-pulse size-1.5 rounded-full bg-fg-3" />
            {formatDuration(p.now - a.startedAt)}
          </span>
        ) : (
          <span
            className="shrink-0 text-sm tabular-nums text-fg-3"
            title={new Date(a.lastActivityAt).toLocaleString()}
          >
            {formatRelativeTime(a.lastActivityAt, p.now)}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-3 text-sm text-fg-3">
        <span className="min-w-0 flex-1 truncate" data-testid="agent-list-second">
          {/* found by what it said: that is the line worth reading. its session is in the pane. */}
          <Highlighted text={p.item.match ?? row.title ?? "Untitled session"} tokens={p.tokens} />
        </span>
        <span className="shrink-0 text-fg-4">
          <Highlighted
            text={a.agentType === "workflow-subagent" ? "workflow" : a.agentType}
            tokens={p.tokens}
          />
          {!running && ` · ${formatDuration(a.lastActivityAt - a.startedAt)}`}
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
  onSelect,
  onActivate,
  onOpen,
  onMenu,
  onInspect,
  onPageSize,
}: {
  items: ListItem[];
  tokens: readonly string[];
  activeKey: SessionKey | null;
  now: number;
  listId: string;
  total: number;
  onSelect: (key: SessionKey) => void;
  onActivate: (key: SessionKey, el: HTMLElement) => void;
  onOpen: (key: SessionKey) => void;
  onMenu: (key: SessionKey, el: HTMLElement) => void;
  onInspect: (key: SessionKey, agent?: string) => void;
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
    const index = items.findIndex((it) => it.type !== "header" && it.id === activeKey);
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
  for (const it of items) if (it.type !== "header") positions.set(it.id, ++rowIndex);

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
              ) : item.type === "agent" ? (
                <div className="flex h-full items-center">
                  <div className="min-w-0 flex-1">
                    <AgentRowView
                      item={item}
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
                      onSelect={onSelect}
                      onActivate={onActivate}
                      onOpen={onOpen}
                      onMenu={onMenu}
                      onInspect={onInspect}
                      {...(item.agent ? { agentHit: item.agent } : {})}
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
