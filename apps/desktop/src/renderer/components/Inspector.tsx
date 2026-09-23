import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionInspection, SessionKey, SessionRow } from "../../shared/ipc.ts";
import {
  type AgentListItem,
  agentDuration,
  agentLine,
  agentList,
  agentMeta,
  agentsSignature,
  agentTitle,
  type FanOut,
  fanOut,
  laneGeometry,
  type PaneLayout,
  paneLayout,
  sessionAgentSummary,
} from "../logic/inspector.ts";
import { agentIdOf, sessionKeyOf } from "../logic/rows.ts";
import { closeAgent, closeInspector, openAgent, paneFocus } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { AgentDetailView } from "./AgentDetail.tsx";
import { SessionsPane } from "./SessionsPane.tsx";
import { cx, Icon, IconButton } from "./ui.tsx";

/** the last look at each session, so coming back to one draws its numbers at once */
const inspections = new Map<SessionKey, SessionInspection>();

/**
 * what the session's agents' own transcripts say, fetched when the row is looked at and again
 * whenever its agents move. a moment's wait first: holding an arrow key down should not fold every
 * session it passes on the way.
 */
function useInspection(row: SessionRow | undefined): SessionInspection | null {
  const key = row?.key ?? null;
  const sig = agentsSignature(row?.agents);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key || !sig) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        void window.grove
          .inspectSession(key)
          .then((value) => {
            if (cancelled || !value) return;
            inspections.set(key, value);
            bump((n) => n + 1);
          })
          .catch(() => {});
      },
      inspections.has(key) ? 250 : 80,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, sig]);
  return key ? (inspections.get(key) ?? null) : null;
}

/** the list and, beside it or over it, the inspector */
export function Workspace() {
  const open = useStore((s) => s.inspector !== null);
  const ref = useRef<HTMLDivElement>(null);
  // in the Agents scope a row is an agent, and selecting one opens the inspector on it
  const activeKey = useStore((s) => s.activeKey);
  useEffect(() => {
    const id = activeKey ? agentIdOf(activeKey) : null;
    if (!activeKey || !id) return;
    const detail = useStore.getState().inspector?.detail;
    const session = sessionKeyOf(activeKey);
    if (detail?.key !== session || detail.id !== id) openAgent(session, id);
  }, [activeKey]);
  const [layout, setLayout] = useState<PaneLayout>({ mode: "side", width: 440 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setLayout(paneLayout(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="relative flex h-full min-h-0 min-w-0 flex-1">
      <SessionsPane />
      {open && (
        <aside
          aria-label="Agents"
          data-testid="inspector"
          data-layout={layout.mode}
          style={{ width: layout.width }}
          className={cx(
            "flex h-full min-h-0 shrink-0 flex-col border-l border-line bg-canvas",
            layout.mode === "overlay" && "absolute top-0 right-0 bottom-0 z-20",
          )}
        >
          <InspectorBody />
        </aside>
      )}
    </div>
  );
}

function InspectorBody() {
  // the session on screen: the active row's, or the session of the active agent
  const activeKey = useStore((s) => (s.activeKey ? sessionKeyOf(s.activeKey) : null));
  const row = useStore((s) => s.sessions.find((r) => r.key === activeKey));
  const now = useStore((s) => s.now);
  const inspection = useInspection(row);
  // a second hand while anything is running, so the bars and the elapsed times move
  const running = row?.agents?.some((a) => a.state === "running") ?? false;
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const clock = running ? Math.max(now, tick) : now;
  // an agent's detail belongs to its session. moving to another row shows that row's list.
  const detail = useStore((s) => s.inspector?.detail ?? null);
  const set = useStore((s) => s.set);
  useEffect(() => {
    if (detail && detail.key !== activeKey) set({ inspector: { agent: null, detail: null } });
  }, [detail, activeKey, set]);

  return (
    <>
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-line pr-3 pl-5">
        <h2
          className="min-w-0 flex-1 truncate font-medium text-fg"
          data-testid="inspector-title"
          title={row?.title}
        >
          {row ? (row.title ?? "Untitled session") : "No session"}
        </h2>
        <IconButton label="Close (Esc)" onClick={closeInspector} data-testid="inspector-close">
          <Icon name="x" size={12} />
        </IconButton>
      </header>
      {row && activeKey ? (
        <SessionAgents key={activeKey} row={row} inspection={inspection} now={clock} />
      ) : (
        <Quiet>Select a session to see what its agents did.</Quiet>
      )}
    </>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="px-5 pt-4 text-sm text-fg-3" data-testid="inspector-empty">
      {children}
    </p>
  );
}

function SessionAgents({
  row,
  inspection,
  now,
}: {
  row: SessionRow;
  inspection: SessionInspection | null;
  now: number;
}) {
  const agents = row.agents ?? [];
  const inspectorAgent = useStore((s) => s.inspector?.agent ?? null);
  const detail = useStore((s) => s.inspector?.detail ?? null);
  const wantedStep = useStore((s) => s.inspector?.step);
  const set = useStore((s) => s.set);
  const [hovered, setHovered] = useState<string | null>(null);
  const items = useMemo(() => agentList(agents, inspection), [agents, inspection]);
  const picture = useMemo(() => fanOut(agents, inspection, now), [agents, inspection, now]);
  const ids = useMemo(() => items.flatMap((i) => (i.type === "agent" ? [i.id] : [])), [items]);
  const active = inspectorAgent && ids.includes(inspectorAgent) ? inspectorAgent : null;
  // the arrows move the keyboard's row. a click, Enter or a bar opens the agent.
  const move = (id: string) => set({ inspector: { agent: id, detail: null } });
  const open = (id: string) => openAgent(row.key, id);

  if (agents.length === 0) return <Quiet>No agents in this session.</Quiet>;

  if (detail && detail.key === row.key) {
    return (
      <AgentDetailView
        key={detail.id}
        sessionKey={row.key}
        agentId={detail.id}
        agent={agents.find((a) => a.id === detail.id)}
        count={agents.length}
        now={now}
        {...(wantedStep !== undefined ? { step: wantedStep } : {})}
        onBack={closeAgent}
        onOpen={open}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pt-3.5 pb-4">
        <p className="text-sm text-fg-3" data-testid="inspector-summary">
          {sessionAgentSummary(agents, inspection, now)}
        </p>
        <FanOutView picture={picture} lit={hovered ?? active} onHover={setHovered} onPick={open} />
      </div>
      <AgentListView
        items={items}
        ids={ids}
        inspection={inspection}
        now={now}
        active={active}
        lit={hovered}
        onHover={setHovered}
        onMove={move}
        onOpen={open}
      />
    </div>
  );
}

const TONE: Record<string, string> = {
  done: "bg-fg-4",
  running: "bg-fg-2",
  error: "bg-accent",
};
const TONE_LIT: Record<string, string> = {
  done: "bg-fg-2",
  running: "bg-fg",
  error: "bg-accent",
};

/**
 * one lane per agent from its start to its end, on the agents' own clock. the only picture in the
 * app, so it stays quiet: no colour but state, no labels but three ticks.
 */
function FanOutView({
  picture,
  lit,
  onHover,
  onPick,
}: {
  picture: FanOut;
  lit: string | null;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
}) {
  const { pitch, bar } = laneGeometry(picture.lanes);
  return (
    <div className="mt-3.5" data-testid="fan-out" data-lanes={picture.lanes}>
      <div className="relative" style={{ height: picture.lanes * pitch }}>
        {picture.bars.map((b) => (
          <button
            key={b.id}
            type="button"
            tabIndex={-1}
            aria-label="Agent"
            data-testid="fan-bar"
            data-tone={b.tone}
            onMouseEnter={() => onHover(b.id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onPick(b.id)}
            className="absolute flex items-center"
            style={{
              top: b.lane * pitch,
              height: pitch,
              left: `min(${b.left * 100}%, calc(100% - 6px))`,
              width: `max(6px, ${b.width * 100}%)`,
            }}
          >
            <span
              className={cx(
                "fade block w-full rounded-full",
                (lit === b.id ? TONE_LIT : TONE)[b.tone],
              )}
              style={{ height: bar }}
            />
            {/* a whole bar breathing is loud. only its live end does, like the row's dot. */}
            {b.tone === "running" && (
              <span
                className={cx(
                  "live-pulse absolute right-0 rounded-full",
                  lit === b.id ? "bg-fg" : "bg-fg-2",
                )}
                style={{ width: bar + 3, height: bar + 3, marginRight: -1 }}
              />
            )}
          </button>
        ))}
      </div>
      <div className="mt-2 h-px bg-line" />
      <div className="mt-1.5 flex justify-between font-mono text-meta text-fg-4">
        {picture.ticks.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: three fixed positions
          <span key={i}>{t}</span>
        ))}
      </div>
    </div>
  );
}

function AgentListView({
  items,
  ids,
  inspection,
  now,
  active,
  lit,
  onHover,
  onMove,
  onOpen,
}: {
  items: AgentListItem[];
  ids: string[];
  inspection: SessionInspection | null;
  now: number;
  active: string | null;
  lit: string | null;
  onHover: (id: string | null) => void;
  onMove: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    document.getElementById(`agent-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  // back from an agent, with the keyboard still in the pane
  useEffect(() => {
    if (paneFocus.pending) {
      paneFocus.pending = false;
      ref.current?.focus();
    }
  }, []);
  return (
    <div
      ref={ref}
      role="listbox"
      tabIndex={0}
      aria-label="Agents"
      aria-activedescendant={active ? `agent-${active}` : undefined}
      data-inspector-list
      data-testid="agent-list"
      className="min-h-0 flex-1 overflow-y-auto border-t border-line pt-2 pb-3 outline-none"
      onFocus={() => {
        setFocused(true);
        if (!active && ids[0]) onMove(ids[0]);
      }}
      onBlur={() => setFocused(false)}
      onKeyDown={(e) => {
        const at = active ? ids.indexOf(active) : -1;
        const go = (i: number) => {
          const id = ids[Math.max(0, Math.min(ids.length - 1, i))];
          if (id) onMove(id);
        };
        if (e.key === "ArrowDown") go(at + 1);
        else if (e.key === "ArrowUp") go(at - 1);
        else if (e.key === "Home") go(0);
        else if (e.key === "End") go(ids.length - 1);
        else if ((e.key === "Enter" || e.key === "ArrowRight") && active) onOpen(active);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item) =>
        item.type === "workflow" ? (
          <div
            key={item.id}
            role="presentation"
            data-testid="workflow-header"
            className="flex h-[30px] items-end px-5 pb-1.5 text-meta font-medium tracking-wide text-fg-3"
          >
            <span className="truncate">{item.label}</span>
          </div>
        ) : (
          <AgentRowView
            key={item.id}
            item={item}
            inspection={inspection}
            now={now}
            active={item.id === active}
            focused={focused}
            lit={item.id === lit}
            onHover={onHover}
            onPick={onOpen}
          />
        ),
      )}
    </div>
  );
}

function AgentRowView({
  item,
  inspection,
  now,
  active,
  focused,
  lit,
  onHover,
  onPick,
}: {
  item: Extract<AgentListItem, { type: "agent" }>;
  inspection: SessionInspection | null;
  now: number;
  active: boolean;
  /** the list has the keyboard. without it the active row is quieter, like an unfocused selection. */
  focused: boolean;
  lit: boolean;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
}) {
  const { agent, depth } = item;
  const stats = inspection?.agents[agent.id];
  const line = agentLine(agent, stats);
  const running = agent.state === "running";
  return (
    <div
      id={`agent-${agent.id}`}
      role="option"
      aria-selected={active}
      data-testid="agent-row"
      data-state={agent.state}
      data-active={active || undefined}
      onMouseEnter={() => onHover(agent.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onPick(agent.id)}
      className={cx(
        "fade mx-2 flex flex-col rounded-md py-2 pr-3",
        active && focused ? "bg-active" : active || lit ? "bg-raised" : "hover:bg-raised",
      )}
      style={{ paddingLeft: 12 + depth * 16 }}
    >
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate font-medium text-fg">
          {agentTitle(agent, stats)}
        </span>
        {running ? (
          <span className="flex shrink-0 items-center gap-1.5 text-sm tabular-nums text-fg-2">
            <span className="live-pulse size-1.5 rounded-full bg-fg-3" />
            {agentDuration(agent, stats, now)}
          </span>
        ) : (
          <span className="shrink-0 text-sm tabular-nums text-fg-3">
            {agentDuration(agent, stats, now)}
          </span>
        )}
      </div>
      <div className="truncate text-sm text-fg-3">{agentMeta(agent, stats)}</div>
      {line && (
        <div
          className={cx("truncate text-sm", line.tone === "error" ? "text-accent" : "text-fg-4")}
          data-testid="agent-line"
          title={line.text}
        >
          {line.text}
        </div>
      )}
    </div>
  );
}
