import { formatDuration } from "@grove/core/pure";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationView,
  MainStats,
  SessionAction,
  SessionInspection,
  SessionKey,
  SessionRow,
} from "../../shared/ipc.ts";
import { conversationMeta, openLabel, spanLabel } from "../logic/conversation.ts";
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
  MAIN_ID,
  mainLine,
  mainMeta,
  PANE_MIN,
  type PaneLayout,
  paneLayout,
  paneWidth,
  sessionAgentSummary,
} from "../logic/inspector.ts";
import { agentIdOf, sessionKeyOf, splitQuery } from "../logic/rows.ts";
import {
  activateDefault,
  agentHit,
  closeAgent,
  closeInspector,
  focusSearch,
  openAgent,
  openMenu,
  paneFocus,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { AgentDetailView } from "./AgentDetail.tsx";
import {
  ConversationPane,
  lastConversation,
  useFollowedConversation,
} from "./ConversationPane.tsx";
import { SessionsPane } from "./SessionsPane.tsx";
import { Button, cx, Icon, IconButton, Segmented } from "./ui.tsx";

/** the last look at each session, so coming back to one draws its numbers at once */
const inspections = new Map<SessionKey, SessionInspection>();

/**
 * what the session's agents' own transcripts say, fetched when the row is looked at and again
 * whenever its agents move. a moment's wait first: holding an arrow key down should not fold every
 * session it passes on the way.
 */
function useInspection(row: SessionRow | undefined): SessionInspection | null {
  const key = row?.key ?? null;
  // the session's own row moves with its transcript: what it is doing now is part of the look
  const sig = row?.agents?.length
    ? `${agentsSignature(row.agents)}|${row.activityMs}|${row.live?.state}`
    : "";
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
/** where the width someone dragged the pane to is kept. per machine, and it can be refused. */
const WIDTH_KEY = "grove.paneWidth";

function savedWidth(): number | undefined {
  try {
    const n = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function saveWidth(width: number | undefined): void {
  try {
    if (width === undefined) window.localStorage.removeItem(WIDTH_KEY);
    else window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // private storage off: the width lasts until the window closes
  }
}

export function Workspace() {
  const open = useStore((s) => s.inspector !== null);
  const view = useStore((s) => s.inspector?.view);
  const ref = useRef<HTMLDivElement>(null);
  // in the Agents scope a row is an agent, and selecting one opens the inspector on it
  const activeKey = useStore((s) => s.activeKey);
  // a search that found a session through one of its agents: with the pane open, it shows that
  // agent at what matched
  const deep = useStore((s) => s.deep);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new search answer is what moves it
  useEffect(() => {
    if (!activeKey) return;
    const id = agentIdOf(activeKey);
    const session = sessionKeyOf(activeKey);
    const detail = useStore.getState().inspector?.detail;
    if (id) {
      const hit = agentHit(session);
      if (detail?.key !== session || detail.id !== id) {
        openAgent(session, id, hit && hit.agent === id ? { find: hit.find } : {});
      }
      return;
    }
    const hit = agentHit(session);
    // the arrows keep the view: an agent is only brought up where agents are on screen
    if (!hit || useStore.getState().inspector?.view !== "agents") return;
    if (detail?.key !== session || detail.id !== hit.agent) {
      openAgent(session, hit.agent, { find: hit.find });
    }
  }, [activeKey, deep]);
  const [available, setAvailable] = useState(0);
  const [wanted, setWanted] = useState<number | undefined>(savedWidth);
  const dragged = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setAvailable(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout: PaneLayout = available
    ? paneLayout(available, wanted)
    : { mode: "side", width: PANE_MIN };
  return (
    <div ref={ref} className="relative flex h-full min-h-0 min-w-0 flex-1">
      <SessionsPane />
      {open && (
        <aside
          aria-label="Session"
          data-testid="inspector"
          data-layout={layout.mode}
          data-view={view}
          style={{ width: layout.width }}
          className={cx(
            "flex h-full min-h-0 shrink-0 flex-col border-l border-line bg-canvas",
            // over the list, not beside it: one position or the other, never both classes
            layout.mode === "overlay" ? "absolute top-0 right-0 bottom-0 z-20" : "relative",
          )}
        >
          {layout.mode === "side" && (
            <DragEdge
              onDrag={(x) => {
                const right = ref.current?.getBoundingClientRect().right ?? x;
                dragged.current = paneWidth(available, right - x);
                setWanted(dragged.current);
              }}
              onDone={() => saveWidth(dragged.current)}
              onReset={() => {
                saveWidth(undefined);
                setWanted(undefined);
              }}
            />
          )}
          <InspectorBody />
        </aside>
      )}
    </div>
  );
}

/**
 * the pane's left edge: drag it to make the pane wider or narrower, double-click it to go back to
 * half. a hairline stays a hairline - only the cursor says it can be moved.
 */
function DragEdge({
  onDrag,
  onDone,
  onReset,
}: {
  onDrag: (clientX: number) => void;
  onDone: () => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Pane width"
      data-testid="pane-edge"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (dragging) onDrag(e.clientX);
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        onDone();
      }}
      onDoubleClick={onReset}
      className={cx(
        "no-drag fade absolute top-0 bottom-0 -left-[3px] z-10 w-[6px] cursor-col-resize",
        dragging && "bg-line-strong",
      )}
    />
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
  // and the keyboard's row in the agents list is that session's too: another row starts at the top
  const shownFor = useRef(activeKey);
  useEffect(() => {
    const inspector = useStore.getState().inspector;
    const moved = shownFor.current !== activeKey;
    shownFor.current = activeKey;
    if (!inspector) return;
    if (detail && detail.key !== activeKey) {
      set({ inspector: { ...inspector, agent: null, detail: null } });
    } else if (moved && inspector.agent !== null && !detail) {
      set({ inspector: { ...inspector, agent: null } });
    }
  }, [detail, activeKey, set]);
  // a session with no agents has only its conversation to show, whatever the arrows kept
  const view = useStore((s) => s.inspector?.view ?? "conversation");
  const agentCount = row?.agents?.length ?? 0;
  const shown = view === "agents" && agentCount > 0 ? "agents" : "conversation";
  // a search that led here: the conversation opens where it matched
  const query = useStore((s) => splitQuery(s.query).text);
  const conversation = useFollowedConversation(
    shown === "conversation" && row ? row.key : null,
    query || undefined,
  );

  // thinking is hidden until asked for, like in an agent's detail. it stays asked for across rows.
  const [thinking, setThinking] = useState(false);
  const busy = row?.live?.state === "running";
  const landAt = useStore((s) => s.inspector?.landAt);

  return (
    <>
      <PaneHeader row={row} head={conversation.view ?? lastConversation(row?.key)} />
      {row && activeKey && (agentCount > 0 || shown === "conversation") && (
        <div className="flex h-10 shrink-0 items-center gap-3 px-5 pt-2" data-testid="pane-toolbar">
          {agentCount > 0 && (
            <Segmented
              label="Show"
              value={shown}
              onChange={(v) => {
                const inspector = useStore.getState().inspector;
                if (inspector) set({ inspector: { ...inspector, view: v, detail: null } });
                // like the scope switch: the keyboard stays with the list, and Tab goes into the pane
                focusSearch(false);
              }}
              options={[
                { value: "conversation", label: "Conversation", testId: "view-conversation" },
                { value: "agents", label: `Agents ${agentCount}`, testId: "view-agents" },
              ]}
            />
          )}
          {shown === "conversation" && (
            <button
              type="button"
              data-testid="toggle-thinking"
              aria-pressed={thinking}
              onClick={() => setThinking((t) => !t)}
              className="fade ml-auto text-sm text-fg-3 hover:text-fg-2"
            >
              {thinking ? "hide thinking" : "show thinking"}
            </button>
          )}
        </div>
      )}
      {!row || !activeKey ? (
        <Quiet>Select a session to read it.</Quiet>
      ) : shown === "agents" ? (
        <SessionAgents key={activeKey} row={row} inspection={inspection} now={clock} />
      ) : (
        <ConversationPane
          key={activeKey}
          sessionKey={activeKey}
          view={conversation.view}
          missing={conversation.missing}
          found={conversation.found}
          running={busy}
          thinking={thinking}
          landAt={landAt}
        />
      )}
    </>
  );
}

/**
 * the session on screen, in a row's two lines: its title, then where it ran and how much it did.
 * the open button goes where Enter would, without asking first unless going would interrupt it.
 */
function PaneHeader({ row, head }: { row: SessionRow | undefined; head: ConversationView | null }) {
  const editorLabel = useStore((s) => s.editor?.label ?? "the editor");
  const offer = useFirstOffer(row);
  return (
    <header className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-line pr-3 pl-5">
      <div className="min-w-0 flex-1">
        <h2
          className="truncate font-medium text-fg"
          data-testid="inspector-title"
          title={row?.title}
        >
          {row ? (row.title ?? "Untitled session") : "No session"}
        </h2>
        {row && (
          <p className="truncate text-sm text-fg-3" data-testid="pane-meta">
            {conversationMeta(row, head)}
          </p>
        )}
      </div>
      {row && (
        <>
          <Button
            variant="ghost"
            size="sm"
            data-testid="pane-open"
            disabled={offer ? !offer.enabled : false}
            onClick={() => void activateDefault(row.key)}
          >
            {openLabel(offer, editorLabel)}
          </Button>
          <IconButton
            label="Actions (⌘K)"
            data-testid="pane-actions"
            onClick={() => void openMenu(row.key)}
          >
            <Icon name="more" size={14} />
          </IconButton>
        </>
      )}
      <IconButton label="Close (Esc)" onClick={closeInspector} data-testid="inspector-close">
        <Icon name="x" size={12} />
      </IconButton>
    </header>
  );
}

/** the first enabled offer for this session: what the open button runs */
function useFirstOffer(row: SessionRow | undefined): SessionAction | undefined {
  const [offer, setOffer] = useState<SessionAction | undefined>(undefined);
  const key = row?.key;
  // held, cut off or neither changes which offer comes first
  const state = `${row?.background?.held}:${row?.interrupted?.why}:${row?.comboRelation}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the state string is what moves it
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void window.grove
      .sessionActions(key)
      .then((actions) => {
        if (!cancelled) setOffer(actions.find((a) => a.enabled) ?? actions[0]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, state]);
  return offer;
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
  const find = useStore((s) => s.inspector?.find);
  const from = useStore((s) => s.inspector?.from);
  const set = useStore((s) => s.set);
  const [hovered, setHovered] = useState<string | null>(null);
  const mainRunning = row.live?.state === "running";
  const items = useMemo(() => agentList(agents, inspection), [agents, inspection]);
  const picture = useMemo(
    () => fanOut(agents, inspection, now, mainRunning),
    [agents, inspection, now, mainRunning],
  );
  const ids = useMemo(
    () => items.flatMap((i) => (i.type === "agent" || i.type === "main" ? [i.id] : [])),
    [items],
  );
  const active = inspectorAgent && ids.includes(inspectorAgent) ? inspectorAgent : null;
  // the arrows move the keyboard's row. a click, Enter or a bar opens the agent - or, for the
  // session's own row, its conversation
  const move = (id: string) => set({ inspector: { view: "agents", agent: id, detail: null } });
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
        fromConversation={from === "conversation"}
        now={now}
        {...(wantedStep !== undefined ? { step: wantedStep } : {})}
        {...(find ? { find } : {})}
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
        sessionKey={row.key}
        row={row}
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
  const lanes = picture.lanes + (picture.main ? 1 : 0);
  const { pitch, bar } = laneGeometry(lanes);
  const top = picture.main ? pitch : 0;
  const mainLit = lit === MAIN_ID;
  return (
    <div className="mt-3.5" data-testid="fan-out" data-lanes={picture.lanes}>
      <div className="relative" style={{ height: lanes * pitch }}>
        {picture.main && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Main conversation"
            data-testid="fan-main"
            data-running={picture.main.running || undefined}
            onMouseEnter={() => onHover(MAIN_ID)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onPick(MAIN_ID)}
            className="absolute inset-x-0 top-0"
            style={{ height: pitch }}
          >
            {picture.main.segments.map((g, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: a turn's place on the axis
                key={i}
                data-testid="fan-main-turn"
                className={cx(
                  "fade absolute rounded-full",
                  mainLit ? "bg-fg-2" : picture.main?.running ? "bg-fg-3" : "bg-fg-4",
                )}
                style={{
                  top: (pitch - bar) / 2,
                  height: bar,
                  left: `min(${g.left * 100}%, calc(100% - 3px))`,
                  width: `max(3px, ${g.width * 100}%)`,
                }}
              />
            ))}
          </button>
        )}
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
              top: top + b.lane * pitch,
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

/** how long a row has to stay in sight to count as looked at: scrolling past is not looking */
const SEEN_MS = 600;

function AgentListView({
  sessionKey,
  row,
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
  sessionKey: SessionKey;
  row: SessionRow;
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
  // finished agents on screen get a line saying what they found - asked once, for what is seen
  // biome-ignore lint/correctness/useExhaustiveDependencies: new rows are new things to watch
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const inSight = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.agentId;
          if (!id) continue;
          if (e.isIntersecting) inSight.add(id);
          else inSight.delete(id);
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (inSight.size > 0) void window.grove.agentsSeen(sessionKey, [...inSight]);
        }, SEEN_MS);
      },
      { root, threshold: 0.6 },
    );
    for (const el of root.querySelectorAll('[data-agent-id][data-state="done"]')) io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
  }, [sessionKey, items]);

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
        item.type === "main" ? (
          inspection?.main && (
            <MainRowView
              key={item.id}
              main={inspection.main}
              row={row}
              now={now}
              active={active === MAIN_ID}
              focused={focused}
              lit={lit === MAIN_ID}
              onHover={onHover}
              onPick={onOpen}
            />
          )
        ) : item.type === "workflow" ? (
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

/**
 * the session itself, as the first of its agents, in an agent row's typography: what it is,
 * how long it has gone on (or, running, this turn), and what it is doing or said last
 */
function MainRowView({
  main,
  row,
  now,
  active,
  focused,
  lit,
  onHover,
  onPick,
}: {
  main: MainStats;
  row: SessionRow;
  now: number;
  active: boolean;
  focused: boolean;
  lit: boolean;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
}) {
  const running = row.live?.state === "running";
  const turnStart = row.live?.turnStart ?? row.live?.at;
  const line = mainLine(main, running);
  return (
    <div
      id={`agent-${MAIN_ID}`}
      role="option"
      aria-selected={active}
      data-testid="main-row"
      data-state={running ? "running" : "done"}
      data-active={active || undefined}
      onMouseEnter={() => onHover(MAIN_ID)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onPick(MAIN_ID)}
      className={cx(
        "fade mx-2 flex flex-col rounded-md py-2 pr-3 pl-3",
        active && focused ? "bg-active" : active || lit ? "bg-raised" : "hover:bg-raised",
      )}
    >
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate font-medium text-fg">Main conversation</span>
        {running && turnStart !== undefined ? (
          <span className="flex shrink-0 items-center gap-1.5 text-sm tabular-nums text-fg-2">
            <span className="live-pulse size-1.5 rounded-full bg-fg-3" />
            {formatDuration(now - turnStart)}
          </span>
        ) : main.startedAt !== undefined && main.lastAt !== undefined ? (
          <span className="shrink-0 text-sm tabular-nums text-fg-3">
            {spanLabel(main.lastAt - main.startedAt)}
          </span>
        ) : null}
      </div>
      <div className="truncate text-sm text-fg-3">{mainMeta(main)}</div>
      {line && (
        <div className="truncate text-sm text-fg-4" data-testid="agent-line" title={line}>
          {line}
        </div>
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
      data-agent-id={agent.id}
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
