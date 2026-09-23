import { toolLabel } from "@grove/core/pure";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AgentDetail, SessionAgent, SessionKey, StepDetail } from "../../shared/ipc.ts";
import {
  type DetailItem,
  detailItems,
  detailMeta,
  hasThinking,
  itemOfStep,
  offsetLabel,
  runOfStep,
  runTargets,
  type ToolLine,
} from "../logic/agentDetail.ts";
import { activate, paneFocus } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Markdown } from "./Markdown.tsx";
import { cx, Icon } from "./ui.tsx";

/** the last look at each agent, so going back to one draws it at once */
const details = new Map<string, AgentDetail>();
const steps = new Map<string, StepDetail>();
const LINE = 20;
/** an agent that died on an error: the only colour the detail has */
const errorLine = "mt-1 line-clamp-2 text-sm text-accent";

function remember<V>(map: Map<string, V>, key: string, value: V, max = 24): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * the agent on screen, read in main and sent over as lines, never raw json. while it is here,
 * whatever it writes arrives as it lands: every step from the first one that changed, at most
 * four times a second.
 */
function useFollowedAgent(
  key: SessionKey,
  id: string,
  find: string | undefined,
): { detail: AgentDetail | null; missing: boolean; found: number | undefined } {
  const cacheKey = `${key}\0${id}`;
  const [detail, setDetail] = useState<AgentDetail | null>(details.get(cacheKey) ?? null);
  const [missing, setMissing] = useState(false);
  const [found, setFound] = useState<number | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let gen = -1;
    let current = details.get(cacheKey) ?? null;
    const show = (next: AgentDetail) => {
      current = next;
      remember(details, cacheKey, next);
      setDetail(next);
    };
    const off = window.grove.on("agent:steps", (p) => {
      if (cancelled || p.gen !== gen || p.key !== key || p.id !== id || !current) return;
      // the head comes whole: a field it no longer has (a result that turned back into a step)
      // must not survive from the last one
      show({
        key,
        id,
        ...(current.prompt !== undefined ? { prompt: current.prompt } : {}),
        ...p.head,
        steps: [...current.steps.filter((s) => s.n < p.from), ...p.steps],
      });
    });
    void window.grove
      .followAgent(key, id, find)
      .then((res) => {
        if (cancelled) return;
        setMissing(!res);
        if (!res) return;
        gen = res.gen;
        show(res.detail);
        setFound(res.found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      off();
      void window.grove.followAgent(key, null).catch(() => {});
    };
  }, [key, id, cacheKey, find]);
  return { detail, missing, found };
}

/** what an agent is called: what its parent said it was for, else what it was asked */
function titleOf(agent: SessionAgent | undefined, detail: AgentDetail | null): string {
  if (agent?.description) return agent.description;
  const asked = detail?.prompt?.split("\n").find((l) => l.trim());
  return asked?.trim() ?? agent?.agentType ?? "Agent";
}

export function AgentDetailView({
  sessionKey,
  agentId,
  agent,
  count,
  now,
  step,
  find,
  onBack,
  onOpen,
}: {
  sessionKey: SessionKey;
  agentId: string;
  agent: SessionAgent | undefined;
  /** how many agents the session has: the way back says so */
  count: number;
  now: number;
  /** a step to bring into view once it is there */
  step?: number;
  /** the search that led here. main says which step matched it. */
  find?: string;
  onBack: () => void;
  onOpen: (agentId: string) => void;
}) {
  const running = agent?.state === "running";
  const { detail, missing, found } = useFollowedAgent(sessionKey, agentId, find);
  const wanted = step ?? found;
  const toast = useStore((s) => s.toast);
  const [thinking, setThinking] = useState(false);
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  // where a search landed: marked like an active row, so the eye finds what matched
  const [landedOn, setLandedOn] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // at the end of a running agent, the steps follow what it writes. scrolling up stops that.
  const [live, setLive] = useState(step === undefined && !find);
  // a hairline under the pinned head, once there is something scrolled beneath it
  const [under, setUnder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () => (detail ? detailItems(detail, { thinking, openRuns, running }) : []),
    [detail, thinking, openRuns, running],
  );
  const stops = useMemo(
    () => items.filter((i) => i.type === "tool" || i.type === "run").map((i) => i.id),
    [items],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => estimate(items[i]),
    getItemKey: (i) => items[i]?.id ?? i,
    overscan: 10,
  });

  useEffect(() => {
    if (paneFocus.pending) {
      paneFocus.pending = false;
      scroller.current?.focus();
    }
  }, []);

  const following = running && live && !!detail;
  useEffect(() => {
    if (following && items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    }
  }, [following, items, virtualizer]);

  // a search hit lands on its step: open the run it is folded into, then bring it into view
  const landed = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (wanted === undefined || landed.current === wanted || !detail) return;
    const run = runOfStep(items, wanted);
    if (run && !openRuns.has(run)) {
      setOpenRuns((s) => new Set([...s, run]));
      return;
    }
    const at = itemOfStep(items, wanted);
    if (at < 0) return;
    landed.current = wanted;
    const id = items[at]?.id ?? null;
    setCursor(id);
    setLandedOn(id);
    virtualizer.scrollToIndex(at, { align: "center" });
  }, [wanted, detail, items, openRuns, virtualizer]);

  const toggle = useCallback((set: typeof setExpanded, id: string) => {
    set((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const act = (item: DetailItem | undefined) => {
    if (!item) return;
    if (item.type === "run") toggle(setOpenRuns, item.id);
    else if (item.type === "tool") {
      if (item.step.agentId) onOpen(item.step.agentId);
      else if (!item.step.server) toggle(setExpanded, item.id);
    }
  };

  const copy = (text: string | undefined, what: string) => {
    if (!text) return;
    void window.grove.copyText(text).then((res) => {
      if (res.ok) toast({ level: "info", title: `${what} copied` });
    });
  };

  const renderItem = (item: DetailItem): ReactNode => {
    switch (item.type) {
      case "head":
        return (
          <div className="px-5 pt-1 pb-3" data-testid="agent-head">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {detail?.result && (
                <Action onClick={() => copy(detail.result, "Result")} testId="copy-result">
                  Copy result
                </Action>
              )}
              {detail?.prompt && (
                <Action onClick={() => copy(detail.prompt, "Prompt")} testId="copy-prompt">
                  Copy prompt
                </Action>
              )}
              <Action
                onClick={() =>
                  void window.grove.reveal({ kind: "agent", key: sessionKey, agentId })
                }
                testId="reveal-agent"
              >
                Show in Finder
              </Action>
              <Action onClick={() => void activate(sessionKey)} testId="open-session">
                Open session
              </Action>
            </div>
          </div>
        );
      case "label":
        return (
          <div className="flex h-[30px] items-end justify-between px-5 pb-1.5 text-meta font-medium tracking-wide text-fg-3">
            <span>{item.label}</span>
            {item.id === "l:steps" && hasThinking(detail) && (
              <button
                type="button"
                data-testid="toggle-thinking"
                onClick={() => setThinking((t) => !t)}
                className="fade font-normal tracking-normal hover:text-fg-2"
              >
                {thinking ? "hide thinking" : "show thinking"}
              </button>
            )}
          </div>
        );
      case "result":
      case "asked":
        return (
          <div className="px-5 pb-3" data-testid={`agent-${item.type}`}>
            <Folded
              lines={item.type === "result" ? 12 : 3}
              open={unfolded.has(item.id)}
              onToggle={() => toggle(setUnfolded, item.id)}
            >
              <Markdown text={item.text} />
            </Folded>
          </div>
        );
      case "quiet":
        return <p className="px-5 py-1 text-sm text-fg-3">{item.text}</p>;
      case "prose":
        return (
          <div
            className={cx(
              "py-1.5",
              landedOn === item.id ? "mx-2 rounded-md bg-raised px-3" : "px-5",
            )}
            data-testid="agent-prose"
            data-kind={item.step.kind}
            data-landed={landedOn === item.id || undefined}
          >
            <Folded
              lines={8}
              open={unfolded.has(item.id)}
              onToggle={() => toggle(setUnfolded, item.id)}
            >
              <Markdown
                text={item.step.text}
                className={cx("max-w-[68ch]", item.step.kind === "thinking" && "text-fg-3")}
              />
            </Folded>
          </div>
        );
      case "message":
        return item.step.interrupted ? (
          <Line
            name=""
            target={<span className="text-fg-3">Interrupted</span>}
            offset={offsetLabel(item.step.at, detail?.startedAt)}
          />
        ) : (
          <div className="px-5 py-1.5" data-testid="agent-message">
            <p className="text-meta text-fg-3">Sent to it</p>
            <Markdown text={item.step.text} className="max-w-[68ch]" />
          </div>
        );
      case "run":
        return (
          <Line
            testId="step-run"
            cursor={cursor === item.id}
            focused={focused}
            onClick={() => {
              setCursor(item.id);
              act(item);
            }}
            name={`${toolLabel(item.name)} ×${item.steps.length}`}
            target={<span className="text-fg-3">{runTargets(item.steps)}</span>}
            offset={offsetLabel(item.steps[0]?.at ?? 0, detail?.startedAt)}
            chevron={item.open ? "open" : "closed"}
          />
        );
      case "tool":
        return (
          <ToolItem
            item={item}
            sessionKey={sessionKey}
            agentId={agentId}
            start={detail?.startedAt}
            live={running && item.step.durationMs === undefined}
            open={expanded.has(item.id)}
            cursor={cursor === item.id || landedOn === item.id}
            focused={focused}
            onClick={() => {
              setCursor(item.id);
              act(item);
            }}
            onCopy={copy}
          />
        );
    }
  };

  const lastTool = detail?.steps.findLast((st) => st.kind === "tool");
  const doing =
    agent?.summary ??
    (lastTool?.kind === "tool" ? `${toolLabel(lastTool.name)} ${lastTool.target}`.trim() : null) ??
    agent?.lastTool ??
    "Starting";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="agent-detail">
      <div className="flex h-10 shrink-0 items-center px-3">
        <button
          type="button"
          data-testid="agent-back"
          onClick={onBack}
          className="fade flex items-center gap-1 rounded-md px-2 py-1 text-sm text-fg-3 hover:bg-raised hover:text-fg-2"
        >
          <Icon name="chevron" size={11} className="rotate-180" />
          {count} {count === 1 ? "agent" : "agents"}
        </button>
      </div>
      {/* who it is and what it is doing stay in sight, wherever the steps are scrolled to */}
      <div
        className={cx(
          "fade shrink-0 border-b px-5 pb-2",
          under ? "border-line" : "border-transparent",
        )}
      >
        <h3
          className="truncate text-title font-medium text-fg"
          data-testid="agent-title"
          title={titleOf(agent, detail)}
        >
          {titleOf(agent, detail)}
        </h3>
        {detail && (
          <p className="mt-0.5 truncate text-sm text-fg-3" data-testid="agent-meta">
            {detailMeta(agent, detail, now)}
          </p>
        )}
        {running && (
          <p className="mt-1 flex items-center gap-2 text-sm text-fg-2" data-testid="agent-now">
            <span className="live-pulse size-1.5 shrink-0 rounded-full bg-fg-3" />
            <span className="min-w-0 flex-1 truncate">{doing}</span>
          </p>
        )}
        {detail?.error && (
          <p className={errorLine} data-testid="agent-error" data-error title={detail.error}>
            {detail.error}
          </p>
        )}
        {detail?.interrupted && !running && <p className="mt-1 text-sm text-fg-3">Interrupted</p>}
      </div>
      <div
        ref={scroller}
        role="listbox"
        tabIndex={0}
        aria-label="Steps"
        aria-activedescendant={cursor ? `step-${cursor}` : undefined}
        data-inspector-list
        data-testid="agent-steps"
        className="min-h-0 flex-1 overflow-y-auto pb-6 outline-none"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (atEnd !== live) setLive(atEnd);
          if (el.scrollTop > 0 !== under) setUnder(el.scrollTop > 0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            onBack();
            return;
          }
          const at = cursor ? stops.indexOf(cursor) : -1;
          const go = (i: number) => {
            const id = stops[Math.max(0, Math.min(stops.length - 1, i))];
            if (!id) return;
            setCursor(id);
            const index = items.findIndex((it) => it.id === id);
            if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
          };
          if (e.key === "ArrowDown") go(at + 1);
          else if (e.key === "ArrowUp") go(at < 0 ? stops.length - 1 : at - 1);
          else if (e.key === "Home") go(0);
          else if (e.key === "End") go(stops.length - 1);
          else if (e.key === "Enter" || e.key === "ArrowRight")
            act(items.find((i) => i.id === cursor));
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {missing && !detail ? (
          <p className="px-5 pt-2 text-sm text-fg-3" data-testid="agent-gone">
            Claude Code deletes transcripts after 30 days
          </p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const item = items[v.index];
              if (!item) return null;
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  {renderItem(item)}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {running && !live && detail && (
        <button
          type="button"
          data-testid="jump-live"
          onClick={() => setLive(true)}
          className="fade absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center rounded-full border border-line-strong bg-canvas px-3 text-sm text-fg-2 hover:text-fg"
        >
          Jump to live ↓
        </button>
      )}
    </div>
  );
}

function estimate(item: DetailItem | undefined): number {
  switch (item?.type) {
    case "head":
      return 30;
    case "label":
      return 30;
    case "result":
      return 12 * LINE + 40;
    case "asked":
      return 3 * LINE + 40;
    case "prose":
      return 3 * LINE + 12;
    case "message":
      return 60;
    default:
      return 26;
  }
}

function Action({
  children,
  onClick,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="fade text-fg-3 hover:text-fg-2"
    >
      {children}
    </button>
  );
}

/**
 * a block folded to so many lines, with "more" under it when there is more. the fold state lives
 * with the caller: a virtual list forgets whatever scrolls away.
 */
function Folded({
  lines,
  open,
  onToggle,
  children,
}: {
  lines: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [cut, setCut] = useState<number | null>(null);
  const max = lines * LINE;
  useLayoutEffect(() => {
    const el = box.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    // only a folded block can say whether it is cut. an open one keeps what it last knew.
    const check = () => {
      if (open) return;
      const cutOff = el.scrollHeight > max + 2;
      setOver(cutOff);
      // end on the last whole block that fits - a paragraph under a table would otherwise be
      // sliced through a line. when even the first block is too tall, the line clamp ends it.
      let fits = 0;
      for (const child of el.querySelector(".md")?.children ?? []) {
        const bottom = (child as HTMLElement).offsetTop + (child as HTMLElement).offsetHeight;
        if (bottom <= max) fits = Math.max(fits, bottom);
      }
      setCut(cutOff && fits >= max * 0.4 ? fits : null);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, max]);
  return (
    <div>
      <div
        ref={box}
        className={cx("relative", !open && "fold")}
        style={
          {
            "--fold-lines": lines,
            ...(!open && cut !== null ? { maxHeight: cut } : {}),
          } as CSSProperties
        }
      >
        <div>{children}</div>
      </div>
      {over && (
        <button
          type="button"
          data-testid="fold-toggle"
          onClick={onToggle}
          className="fade mt-1 text-sm text-fg-3 hover:text-fg-2"
        >
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
}

/** one step, one quiet line: the tool in a fixed mono column, what it was about, when */
function Line({
  name,
  target,
  offset,
  failure,
  live,
  link,
  chevron,
  cursor,
  focused,
  nested,
  onClick,
  testId,
  id,
}: {
  name: string;
  target: ReactNode;
  offset: string;
  failure?: string;
  live?: boolean;
  link?: boolean;
  chevron?: "open" | "closed";
  cursor?: boolean;
  focused?: boolean;
  nested?: boolean;
  onClick?: () => void;
  testId?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={!!cursor}
      data-testid={testId}
      data-cursor={cursor || undefined}
      onClick={onClick}
      className={cx(
        "fade mx-2 flex h-[26px] items-center gap-3 rounded-md pr-3",
        nested ? "pl-7" : "pl-3",
        cursor && focused ? "bg-active" : cursor ? "bg-raised" : onClick && "hover:bg-raised",
      )}
    >
      <span className="flex w-[72px] shrink-0 items-center gap-1 truncate font-mono text-meta text-fg-3">
        {name}
        {chevron && (
          <Icon
            name="chevron"
            size={9}
            className={cx("text-fg-4", chevron === "open" && "rotate-90")}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-fg-2">{target}</span>
      {link && <span className="shrink-0 text-sm text-fg-3">→</span>}
      {failure && (
        <span className="shrink-0 text-meta text-accent" data-testid="step-error">
          {failure}
        </span>
      )}
      {live && <span className="live-pulse size-1.5 shrink-0 rounded-full bg-fg-3" />}
      <span className="shrink-0 font-mono text-meta tabular-nums text-fg-4">{offset}</span>
    </div>
  );
}

function ToolItem({
  item,
  sessionKey,
  agentId,
  start,
  live,
  open,
  cursor,
  focused,
  onClick,
  onCopy,
}: {
  item: Extract<DetailItem, { type: "tool" }>;
  sessionKey: SessionKey;
  agentId: string;
  start: number | undefined;
  live: boolean;
  open: boolean;
  cursor: boolean;
  focused: boolean;
  onClick: () => void;
  onCopy: (text: string | undefined, what: string) => void;
}) {
  const s: ToolLine = item.step;
  return (
    <div data-testid="step" data-failed={s.failure ? true : undefined}>
      <Line
        id={`step-${item.id}`}
        name={toolLabel(s.name)}
        target={
          FILE_TOOLS.has(s.name) && s.target.includes("/") ? (
            <PathTarget path={s.target} />
          ) : (
            s.target || <span className="text-fg-4">{s.server ? "server tool" : ""}</span>
          )
        }
        offset={offsetLabel(s.at, start)}
        failure={s.failure}
        live={live}
        link={!!s.agentId}
        nested={item.nested}
        cursor={cursor}
        focused={focused}
        onClick={onClick}
      />
      {open && <StepBody sessionKey={sessionKey} agentId={agentId} stepId={s.id} onCopy={onCopy} />}
    </div>
  );
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** a path that runs out of room loses its folders, never its file name */
function PathTarget({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span className="flex min-w-0" title={path}>
      <span className="truncate text-fg-3">{path.slice(0, cut)}</span>
      <span className="shrink-0">{path.slice(cut)}</span>
    </span>
  );
}

/** a step opened in place: its whole input and what came back, read from disk on the way */
function StepBody({
  sessionKey,
  agentId,
  stepId,
  onCopy,
}: {
  sessionKey: SessionKey;
  agentId: string;
  stepId: string;
  onCopy: (text: string | undefined, what: string) => void;
}) {
  const cacheKey = `${sessionKey}\0${agentId}\0${stepId}`;
  const [body, setBody] = useState<StepDetail | null | undefined>(steps.get(cacheKey));
  const ref = useRef<HTMLDivElement>(null);
  // opened near the bottom, it would unfold out of sight
  useEffect(() => {
    if (body !== undefined) ref.current?.scrollIntoView({ block: "nearest" });
  }, [body]);
  useEffect(() => {
    if (steps.has(cacheKey)) return;
    let cancelled = false;
    void window.grove
      .agentStep(sessionKey, agentId, stepId)
      .then((value) => {
        if (cancelled) return;
        if (value) remember(steps, cacheKey, value, 48);
        setBody(value);
      })
      .catch(() => !cancelled && setBody(null));
    return () => {
      cancelled = true;
    };
  }, [sessionKey, agentId, stepId, cacheKey]);
  return (
    <div ref={ref} className="mr-5 mb-2 ml-8 border-l border-line pl-3" data-testid="step-body">
      {body === undefined ? (
        <p className="py-1 text-sm text-fg-3">Reading…</p>
      ) : body === null ? (
        <p className="py-1 text-sm text-fg-3">Nothing to show - the transcript has moved on.</p>
      ) : (
        <>
          <Part label="Input" text={body.input} onCopy={() => onCopy(body.input, "Input")} />
          {body.result !== undefined && (
            <Part
              label={body.isError ? "Result, an error" : "Result"}
              text={body.result || "(empty)"}
              onCopy={() => onCopy(body.result, "Result")}
              testId="step-result"
            />
          )}
          {body.truncated && <p className="pt-1 text-meta text-fg-4">Cut at 200,000 characters.</p>}
        </>
      )}
    </div>
  );
}

function Part({
  label,
  text,
  onCopy,
  testId,
}: {
  label: string;
  text: string;
  onCopy: () => void;
  testId?: string;
}) {
  return (
    <div className="py-1" data-testid={testId}>
      <div className="flex items-center justify-between text-meta text-fg-3">
        <span>{label}</span>
        <button type="button" onClick={onCopy} className="fade hover:text-fg-2">
          Copy
        </button>
      </div>
      <pre className="selectable mt-0.5 max-h-64 overflow-auto font-mono text-meta whitespace-pre-wrap break-words text-fg-2">
        {text}
      </pre>
    </div>
  );
}
