import { formatDuration, formatRelativeTime, type LiveStatus, toolLabel } from "@grove/core/pure";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useRef, useState } from "react";
import type { SessionKey, SessionRow } from "../../shared/ipc.ts";
import { agentsChip, agentsCount, agentsTooltip } from "../logic/agents.ts";
import { backgroundTooltip, interruptedTooltip } from "../logic/background.ts";
import { agentName } from "../logic/inspector.ts";
import { type ListItem, NEEDS_YOU, needsYou } from "../logic/rows.ts";
import { usageChip, usageTooltip } from "../logic/usage.ts";
import { cx, Highlighted, Icon, Mono, NeedsPill } from "./ui.tsx";

const ROW = 56;
const HEADER = 30;
/** the soft tint behind the NEEDS_YOU group, and only there. one band, one pill - never louder */
const NEEDS_YOU_BAND = "bg-accent-band";
const NEEDS_YOU_TEXT = "text-accent";
/** an inbox row says what it is waiting for, so it has a line more than a list row */
const INBOX_ROW = 88;

export function optionId(key: SessionKey): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return `session-${(h >>> 0).toString(36)}`;
}

/**
 * what the session is doing now. everything asking for someone - permission, its turn, stopped -
 * is the same pill; running is quiet, and a turn someone already looked at says nothing at all.
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
  if (needsYou(live)) {
    return (
      <NeedsPill testId="live-badge" state={live.state} title={live.detail}>
        {label}
      </NeedsPill>
    );
  }
  // looked at but still asking (a permission prompt, a stop): said, not shouted
  return (
    <span
      data-testid="live-badge"
      data-state={live.state}
      title={live.detail}
      className={cx(
        "flex shrink-0 items-center gap-1.5 text-sm",
        live.state === "running" ? "text-fg-3" : "text-fg-2",
      )}
    >
      <span
        className={cx(
          "size-1.5 rounded-full",
          live.state === "running" ? "live-pulse bg-fg-3" : "bg-fg-3",
        )}
      />
      {label}
    </span>
  );
}

interface RowProps {
  row: SessionRow;
  /** in the band: the band already takes the row's side margin */
  inBand?: boolean;
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
        "fade group @container flex h-[52px] flex-col justify-center rounded-md px-3",
        !p.inBand && "mx-2",
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

/**
 * a running session's own conversation in the Agents scope, in an agent row's typography: working
 * right now, like the agents under the same header - its session is the second line
 */
const MainListRowView = memo(function MainListRowView(p: {
  id: string;
  row: SessionRow;
  tokens: readonly string[];
  active: boolean;
  now: number;
  index: number;
  total: number;
  onActivate: (key: SessionKey, el: HTMLElement) => void;
  onMenu: (key: SessionKey, el: HTMLElement) => void;
}) {
  const { row } = p;
  const since = row.live?.turnStart ?? row.live?.at;
  return (
    <div
      id={optionId(p.id)}
      role="option"
      aria-selected={p.active}
      aria-posinset={p.index + 1}
      aria-setsize={p.total}
      data-testid="agent-list-row"
      data-main
      data-state="running"
      data-active={p.active || undefined}
      onClick={(e) => p.onActivate(p.id, e.currentTarget)}
      onKeyDown={() => {}}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onMenu(p.id, e.currentTarget);
      }}
      className={cx(
        "fade mx-2 flex h-[52px] flex-col justify-center rounded-md px-3",
        p.active ? "bg-active" : "hover:bg-raised",
      )}
    >
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate font-medium text-fg">
          <Highlighted text="Main conversation" tokens={p.tokens} />
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-sm tabular-nums text-fg-2">
          <span className="live-pulse size-1.5 rounded-full bg-fg-3" />
          {since !== undefined ? formatDuration(p.now - since) : ""}
        </span>
      </div>
      <div className="flex items-baseline gap-3 text-sm text-fg-3">
        <span className="min-w-0 flex-1 truncate" data-testid="agent-list-second">
          <Highlighted text={row.title ?? "Untitled session"} tokens={p.tokens} />
        </span>
        <span className="shrink-0 text-fg-4">main</span>
      </div>
    </div>
  );
});

/** what the inbox shows for a session that stopped on words, when the hook's copy was cut */
const lastWords = new Map<string, string | null>();

/** what a session is waiting on, in the words the inbox has room for */
function useAsk(row: SessionRow): { tool?: string; text: string } {
  const live = row.live;
  const cacheKey = `${row.key}\0${live?.at}`;
  const [fetched, setFetched] = useState<string | null | undefined>(lastWords.get(cacheKey));
  const wants = live?.state === "waiting" && !live.question && !live.source;
  useEffect(() => {
    if (!wants || lastWords.has(cacheKey)) return;
    let cancelled = false;
    void window.grove
      .lastWords(row.key)
      .then((said) => {
        lastWords.set(cacheKey, said);
        if (!cancelled) setFetched(said);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wants, cacheKey, row.key]);
  if (!live) return { text: "" };
  if (live.source === "agents") {
    return { text: `Blocked in the background${live.detail ? ` · ${live.detail}` : ""}` };
  }
  if (live.state === "permission") {
    // a tool and what it would act on, as a step line says it
    if (live.detail && live.target) return { tool: toolLabel(live.detail), text: live.target };
    return { text: live.detail ?? "Waiting for permission" };
  }
  if (live.state === "failed") return { text: live.detail ?? "Stopped on an API error" };
  return { text: live.question ?? fetched ?? live.detail ?? "Finished its turn" };
}

/**
 * a session asking for someone, in the Inbox: what it is waiting on, and both ways out always in
 * sight - a click reads it in the pane, the button goes to answer it
 */
const InboxRowView = memo(function InboxRowView(p: {
  row: SessionRow;
  tokens: readonly string[];
  active: boolean;
  now: number;
  index: number;
  total: number;
  openLabel: string;
  onSelect: (key: SessionKey) => void;
  onOpen: (key: SessionKey) => void;
  onMenu: (key: SessionKey, el: HTMLElement) => void;
}) {
  const { row } = p;
  const ask = useAsk(row);
  const agent = row.live?.agentId ? row.agents?.find((a) => a.id === row.live?.agentId) : undefined;
  return (
    <div
      id={optionId(row.key)}
      role="option"
      aria-selected={p.active}
      aria-posinset={p.index + 1}
      aria-setsize={p.total}
      data-testid="inbox-row"
      data-state={row.live?.state}
      data-active={p.active || undefined}
      onClick={(e) => {
        if (e.detail < 2) p.onSelect(row.key);
      }}
      onDoubleClick={() => p.onOpen(row.key)}
      onKeyDown={() => {}}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onMenu(row.key, e.currentTarget);
      }}
      className={cx(
        "fade @container mx-2 flex h-[80px] flex-col justify-center gap-0.5 rounded-md px-3",
        p.active ? "bg-active" : "hover:bg-raised",
      )}
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate font-medium text-fg">
          {row.title ? (
            <Highlighted text={row.title} tokens={p.tokens} />
          ) : (
            <span className="text-fg-3">Untitled session</span>
          )}
        </span>
        {row.live && <LiveBadge live={row.live} />}
        <span
          className="shrink-0 text-sm tabular-nums text-fg-3"
          title={row.live ? `Waiting since ${new Date(row.live.at).toLocaleString()}` : undefined}
          data-testid="inbox-waited"
        >
          {row.live ? formatDuration(Math.max(0, p.now - row.live.at)) : ""}
        </span>
        <button
          type="button"
          tabIndex={-1}
          data-testid="inbox-open"
          onClick={(e) => {
            e.stopPropagation();
            p.onOpen(row.key);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className="no-drag fade h-6 shrink-0 rounded-md border border-line-strong px-2 text-sm text-fg-2 hover:bg-raised hover:text-fg"
        >
          {p.openLabel}
        </button>
      </div>
      <div className="flex items-end gap-3 text-sm">
        <p
          className="line-clamp-2 min-w-0 flex-1 text-fg-2"
          data-testid="inbox-ask"
          title={ask.text}
        >
          {agent && <span className="text-fg-3">{agentName(agent)} · </span>}
          {ask.tool && <Mono className="mr-2 text-fg-3">{ask.tool}</Mono>}
          <Highlighted text={ask.text} tokens={p.tokens} />
        </p>
        <span className="flex shrink-0 items-baseline gap-2.5 text-fg-3">
          {row.gitBranch && (
            <span className="flex max-w-40 items-center gap-1 self-center @max-lg:hidden">
              <Icon name="branch" size={11} className="text-fg-4" />
              <Mono className="truncate">{row.gitBranch}</Mono>
            </span>
          )}
          {row.comboName ? (
            <span className="max-w-40 truncate text-fg-2">{row.comboName}</span>
          ) : (
            <Mono className="max-w-40 truncate" title={row.cwd}>
              {row.cwdBase ?? row.projectLabel}
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
  onSelect,
  onActivate,
  onOpen,
  onMenu,
  onInspect,
  onPageSize,
  editorLabel,
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
  /** where the first way in goes: the inbox's open button says it */
  editorLabel: string;
}) {
  // a session Claude Code's supervisor holds is answered where it runs
  const openLabelFor = (row: SessionRow) =>
    row.background?.held ? "Open in Terminal" : `Open in ${editorLabel}`;
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) =>
      items[i]?.type === "header" ? HEADER : items[i]?.type === "inbox" ? INBOX_ROW : ROW,
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
              {item.type === "header" && item.label === NEEDS_YOU ? (
                // the top of the band: what needs you sits apart from the rest of the day
                <div className={cx("mx-2 h-full rounded-t-md pt-1", NEEDS_YOU_BAND)}>
                  <div
                    role="presentation"
                    data-testid="needs-you-header"
                    className={cx(
                      "flex h-full items-end px-3 pb-1.5 text-meta font-medium tracking-wide",
                      NEEDS_YOU_TEXT,
                    )}
                  >
                    {item.label}
                    {item.count ? ` · ${item.count}` : ""}
                  </div>
                </div>
              ) : item.type === "header" ? (
                <div
                  role="presentation"
                  className="flex h-full items-end px-5 pb-1.5 text-meta font-medium tracking-wide text-fg-3"
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
              ) : item.type === "main" ? (
                <div className="flex h-full items-center">
                  <div className="min-w-0 flex-1">
                    <MainListRowView
                      id={item.id}
                      row={item.row}
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
              ) : item.type === "inbox" ? (
                <div className="flex h-full items-center">
                  <div className="min-w-0 flex-1">
                    <InboxRowView
                      row={item.row}
                      tokens={tokens}
                      active={item.id === activeKey}
                      now={now}
                      index={positions.get(item.id) ?? 0}
                      total={total}
                      openLabel={openLabelFor(item.row)}
                      onSelect={onSelect}
                      onOpen={onOpen}
                      onMenu={onMenu}
                    />
                  </div>
                </div>
              ) : (
                <div
                  className={cx(
                    "flex h-full items-center",
                    item.band && cx("mx-2", NEEDS_YOU_BAND, item.band === "last" && "rounded-b-md"),
                  )}
                  data-band={item.band}
                >
                  <div className="min-w-0 flex-1">
                    <SessionRowView
                      inBand={!!item.band}
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
