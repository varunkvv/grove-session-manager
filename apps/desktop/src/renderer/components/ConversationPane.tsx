import { tokenize, toolLabel } from "@grove/core/pure";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationTurn,
  ConversationView,
  DetailStep,
  Mark,
  SessionKey,
} from "../../shared/ipc.ts";
import {
  applyTurns,
  type ConversationLine,
  conversationLines,
  isStop,
  stepPrefix,
  workLine,
} from "../logic/conversation.ts";
import { itemOfStep, offsetLabel, runOfStep, runTargets } from "../logic/steps.ts";
import { focusSearch, openAgent, paneFocus } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Markdown } from "./Markdown.tsx";
import { Folded, LINE, Line, remember, ToolItem } from "./Steps.tsx";
import { cx, Highlighted, Icon } from "./ui.tsx";

/** the last look at each session, so going back to one draws it at once */
const conversations = new Map<SessionKey, ConversationView>();
/** a turn's work, once opened: a finished turn never changes */
const turnSteps = new Map<string, DetailStep[]>();
const MEMORY = 8;

/** the last reading of a session's conversation, if it has been on screen: the header's numbers */
export function lastConversation(key: SessionKey | null | undefined): ConversationView | null {
  return key ? (conversations.get(key) ?? null) : null;
}

/**
 * the session's own conversation on screen, read in main and sent over without its work. while it
 * is here, whatever the session writes arrives as it lands, at most four times a second.
 */
export function useFollowedConversation(
  /** null while something else is on screen: nothing is followed */
  key: SessionKey | null,
  find: string | undefined,
): {
  view: ConversationView | null;
  missing: boolean;
  found: { n: number; step?: number } | undefined;
} {
  const [view, setView] = useState<ConversationView | null>(
    key ? (conversations.get(key) ?? null) : null,
  );
  const [missing, setMissing] = useState(false);
  const [found, setFound] = useState<{ n: number; step?: number } | undefined>(undefined);
  // the search that led here counts when the session is opened, not as it is typed after
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let gen = -1;
    let current = conversations.get(key) ?? null;
    setView(current);
    setMissing(false);
    setFound(undefined);
    const show = (next: ConversationView) => {
      current = next;
      remember(conversations, key, next, MEMORY);
      setView(next);
    };
    const off = window.grove.on("conversation:turns", (p) => {
      if (cancelled || p.gen !== gen || p.key !== key || !current) return;
      show(applyTurns(current, p));
    });
    void window.grove
      .followConversation(key, find)
      .then((res) => {
        if (cancelled) return;
        setMissing(!res);
        if (!res) return;
        gen = res.gen;
        show(res.conversation);
        setFound(res.found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      off();
      void window.grove.followConversation(null).catch(() => {});
    };
  }, [key]);
  return { view, missing, found };
}

const timeOf = (ms: number | undefined) =>
  ms === undefined
    ? ""
    : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function estimate(line: ConversationLine | undefined): number {
  switch (line?.type) {
    case "day":
      return 30;
    case "prompt":
      return line.turn.prompt?.kind === "task"
        ? 34
        : Math.min(8, Math.ceil((line.turn.prompt?.text.length ?? 0) / 70) + 1) * LINE + 34;
    case "answer":
      return Math.ceil((line.turn.answer?.length ?? 0) / 75) * LINE + 24;
    case "mark":
      return line.mark.kind === "plan" ? 12 * LINE + 60 : 3 * LINE + 24;
    case "prose":
      return 3 * LINE + 12;
    case "output":
      return 4 * LINE + 16;
    case "compact":
      return 44;
    default:
      return 26;
  }
}

/**
 * a session read like a conversation, not a log: each turn is what was asked, one quiet line for
 * the work (open it for every step), and the answer. what was asked of the person and what they
 * said stays in sight. the list is virtual - the 107MB session has 556 turns.
 */
export function ConversationPane({
  sessionKey,
  view,
  missing,
  found,
  running,
  thinking,
  landAt,
}: {
  sessionKey: SessionKey;
  view: ConversationView | null;
  missing: boolean;
  found: { n: number; step?: number } | undefined;
  /** the session is in the middle of a turn: its last turn is live */
  running: boolean;
  thinking: boolean;
  /** a notification click landed here: back to the end, where the question is */
  landAt?: number | undefined;
}) {
  const now = useStore((s) => s.now);
  const toast = useStore((s) => s.toast);
  const query = useStore((s) => s.query);
  const tokens = useMemo(() => tokenize(query), [query]);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [closedLive, setClosedLive] = useState(false);
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [landedOn, setLandedOn] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // at the end, the list follows what the session writes. scrolling up stops that.
  const [atEnd, setAtEnd] = useState(true);
  const [tick, setTick] = useState(Date.now());
  const scroller = useRef<HTMLDivElement>(null);

  const lastN = view ? view.items.length - 1 : -1;
  const live = running && view?.items[lastN]?.kind === "turn" ? lastN : null;
  // a second hand for the live turn's running time
  useEffect(() => {
    if (live === null) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const clock = live !== null ? Math.max(now, tick) : now;

  // `loaded` is what says a fetched turn arrived in the cache
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const steps = useMemo(() => {
    const m = new Map<number, DetailStep[]>();
    for (const n of open) {
      const got = turnSteps.get(`${sessionKey}\0${n}`);
      if (got) m.set(n, got);
    }
    if (live !== null && view?.live?.n === live) m.set(live, view.live.steps);
    return m;
  }, [open, live, view, sessionKey, loaded]);

  // an opened turn's work is fetched once: a finished turn never changes
  useEffect(() => {
    let cancelled = false;
    for (const n of open) {
      const cacheKey = `${sessionKey}\0${n}`;
      if (n === live || turnSteps.has(cacheKey)) continue;
      void window.grove
        .conversationSteps(sessionKey, n)
        .then((got) => {
          if (cancelled || !got) return;
          remember(turnSteps, cacheKey, got, 64);
          setLoaded((x) => x + 1);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [open, live, sessionKey]);

  const lines = useMemo(
    () =>
      view
        ? conversationLines(view, {
            open,
            closedLive,
            steps,
            live,
            thinking,
            openRuns,
            now: clock,
          })
        : [],
    [view, open, closedLive, steps, live, thinking, openRuns, clock],
  );
  const stops = useMemo(() => lines.filter(isStop).map((l) => l.id), [lines]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => estimate(lines[i]),
    getItemKey: (i) => lines[i]?.id ?? i,
    overscan: 8,
  });

  useEffect(() => {
    if (paneFocus.pending) {
      paneFocus.pending = false;
      scroller.current?.focus();
    }
  }, []);

  // a landing on a session already on screen, scrolled somewhere else
  useEffect(() => {
    if (landAt) setAtEnd(true);
  }, [landAt]);

  // opened at the end, like a chat: the newest turn is where the session is now
  useEffect(() => {
    if (atEnd && lines.length > 0) virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
  }, [atEnd, lines, virtualizer]);

  // a search landed here: open the work it is in, then bring it into view
  const landed = useRef<string | null>(null);
  useEffect(() => {
    if (!found || !view) return;
    const want = `${found.n}:${found.step ?? ""}`;
    if (landed.current === want) return;
    setAtEnd(false);
    if (found.step !== undefined) {
      if (!open.has(found.n) && found.n !== live) {
        setOpen((s) => new Set([...s, found.n]));
        return;
      }
      const run = runOfStep(lines, found.step, stepPrefix(found.n));
      if (run && !openRuns.has(run)) {
        setOpenRuns((s) => new Set([...s, run]));
        return;
      }
      const at = itemOfStep(lines, found.step, stepPrefix(found.n));
      if (at < 0) return;
      landed.current = want;
      const id = lines[at]?.id ?? null;
      setCursor(id);
      setLandedOn(id);
      virtualizer.scrollToIndex(at, { align: "center" });
      return;
    }
    const at = lines.findIndex((l) => l.type !== "day" && "turn" in l && l.turn.n === found.n);
    if (at < 0) return;
    landed.current = want;
    const id = lines[at]?.id ?? null;
    setCursor(id);
    setLandedOn(id);
    virtualizer.scrollToIndex(at, { align: "start" });
  }, [found, view, lines, open, openRuns, live, virtualizer]);

  const flip = useCallback(
    <T,>(set: (f: (s: ReadonlySet<T>) => ReadonlySet<T>) => void, v: T) =>
      set((s) => {
        const next = new Set(s);
        if (next.has(v)) next.delete(v);
        else next.add(v);
        return next;
      }),
    [],
  );

  const toggleWork = (turn: ConversationTurn) => {
    if (turn.n === live) setClosedLive((c) => !c);
    else flip(setOpen, turn.n);
  };

  const act = (line: ConversationLine | undefined) => {
    if (!line) return;
    if (line.type === "work") toggleWork(line.turn);
    else if (line.type === "run") flip(setOpenRuns, line.id);
    else if (line.type === "tool") {
      // an Agent call goes to the agent it started, in the Agents view
      if (line.step.agentId) openAgent(sessionKey, line.step.agentId, { focus: focused });
      else if (!line.step.server) flip(setExpanded, line.id);
    } else if (line.type === "prompt") flip(setUnfolded, line.id);
  };

  const copy = (text: string | undefined, what: string) => {
    if (!text) return;
    void window.grove.copyText(text).then((res) => {
      if (res.ok) toast({ level: "info", title: `${what} copied` });
    });
  };

  const renderLine = (line: ConversationLine): ReactNode => {
    const isCursor = cursor === line.id;
    switch (line.type) {
      case "day":
        return (
          <div
            className="flex h-[30px] items-end px-5 pb-1.5 text-meta font-medium tracking-wide text-fg-3"
            data-testid="day-header"
          >
            {line.label}
          </div>
        );
      case "prompt":
        return (
          <PromptBlock
            id={line.id}
            turn={line.turn}
            tokens={tokens}
            cursor={isCursor}
            focused={focused}
            open={unfolded.has(line.id)}
            onToggle={() => flip(setUnfolded, line.id)}
            onCopy={() => copy(line.turn.prompt?.text, "Prompt")}
          />
        );
      case "work":
        return (
          <div
            id={`line-${line.id}`}
            role="option"
            aria-selected={isCursor}
            data-testid="work-line"
            data-open={line.open || undefined}
            data-live={line.live || undefined}
            data-cursor={isCursor || undefined}
            onClick={() => {
              setCursor(line.id);
              toggleWork(line.turn);
            }}
            className={cx(
              "fade mx-2 mt-1 flex h-[26px] items-center gap-2 rounded-md px-3 text-sm text-fg-3",
              isCursor && focused ? "bg-active" : isCursor ? "bg-raised" : "hover:bg-raised",
            )}
          >
            <Icon
              name="chevron"
              size={10}
              className={cx("fade text-fg-4", line.open && "rotate-90")}
            />
            <span className="min-w-0 flex-1 truncate">{workLine(line.turn, clock, line.live)}</span>
            {line.live && <span className="live-pulse size-1.5 shrink-0 rounded-full bg-fg-3" />}
          </div>
        );
      case "loading":
        return <p className="py-1 pl-10 text-sm text-fg-4">Reading…</p>;
      case "run":
        return (
          <Line
            id={`line-${line.id}`}
            testId="step-run"
            cursor={isCursor}
            focused={focused}
            nested
            onClick={() => {
              setCursor(line.id);
              act(line);
            }}
            name={`${toolLabel(line.name)} ×${line.steps.length}`}
            target={<span className="text-fg-3">{runTargets(line.steps)}</span>}
            offset={offsetLabel(line.steps[0]?.at ?? 0, line.turn.startedAt)}
            chevron={line.open ? "open" : "closed"}
          />
        );
      case "tool":
        return (
          <div className="pl-4">
            <ToolItem
              item={line}
              body={(stepId) => ({
                cacheKey: `${sessionKey}\0${stepId}`,
                load: () => window.grove.conversationStep(sessionKey, stepId),
              })}
              start={line.turn.startedAt}
              live={line.turn.n === live && line.step.durationMs === undefined}
              open={expanded.has(line.id)}
              cursor={isCursor || landedOn === line.id}
              focused={focused}
              onClick={() => {
                setCursor(line.id);
                act(line);
              }}
              onCopy={copy}
            />
          </div>
        );
      case "prose":
        return (
          <div
            className={cx(
              "py-1.5 pr-5",
              landedOn === line.id ? "mx-2 rounded-md bg-raised pl-10" : "pl-12",
            )}
            data-testid="work-prose"
            data-kind={line.step.kind}
          >
            <Folded
              lines={8}
              open={unfolded.has(line.id)}
              onToggle={() => flip(setUnfolded, line.id)}
            >
              <Markdown
                text={line.step.text}
                marks={tokens}
                className={cx("max-w-[68ch]", line.step.kind === "thinking" && "text-fg-3")}
              />
            </Folded>
          </div>
        );
      case "message":
        return (
          <Line
            name=""
            nested
            target={
              <span className="text-fg-3">
                {line.step.interrupted ? "Interrupted" : line.step.text}
              </span>
            }
            offset={offsetLabel(line.step.at, line.turn.startedAt)}
          />
        );
      case "mark":
        return (
          <MarkBlock
            mark={line.mark}
            tokens={tokens}
            open={unfolded.has(line.id)}
            onToggle={() => flip(setUnfolded, line.id)}
          />
        );
      case "answer":
        return (
          <div className="group flex items-start gap-3 pt-2.5 pr-5 pb-1 pl-5" data-testid="answer">
            <div className="min-w-0 flex-1">
              <Markdown
                text={line.turn.answer ?? ""}
                marks={tokens}
                className="md-answer max-w-[68ch]"
              />
            </div>
            <Gutter>
              <CopyButton onClick={() => copy(line.turn.answer, "Answer")} />
            </Gutter>
          </div>
        );
      case "output":
        return (
          <div className="px-5 pt-2 pb-1" data-testid="command-output">
            <Folded
              lines={12}
              open={unfolded.has(line.id)}
              onToggle={() => flip(setUnfolded, line.id)}
            >
              <pre className="selectable font-mono text-meta whitespace-pre-wrap break-words text-fg-2">
                {line.turn.output || "(no output)"}
              </pre>
            </Folded>
          </div>
        );
      case "status":
        return (
          <p
            className={cx(
              "px-5 pt-1.5 pb-1 text-sm",
              line.tone === "error" ? "text-accent" : "text-fg-3",
            )}
            data-testid="turn-status"
            data-tone={line.tone}
          >
            {line.text}
          </p>
        );
      case "compact":
        return (
          <Divider
            divider={line.divider}
            open={unfolded.has(line.id)}
            onToggle={() => flip(setUnfolded, line.id)}
          />
        );
    }
  };

  if (missing && !view) {
    return (
      <p className="px-5 pt-4 text-sm text-fg-3" data-testid="conversation-gone">
        Claude Code deletes transcripts after 30 days
      </p>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        role="listbox"
        tabIndex={0}
        aria-label="Conversation"
        aria-activedescendant={cursor ? `line-${cursor}` : undefined}
        data-inspector-list
        data-testid="conversation"
        data-turns={view?.turns}
        className="min-h-0 flex-1 overflow-y-auto pt-1 pb-8 outline-none"
        onScroll={(e) => {
          const el = e.currentTarget;
          const end = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (end !== atEnd) setAtEnd(end);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            focusSearch(false);
            return;
          }
          const at = cursor ? stops.indexOf(cursor) : -1;
          const go = (i: number) => {
            const id = stops[Math.max(0, Math.min(stops.length - 1, i))];
            if (!id) return;
            setCursor(id);
            setAtEnd(false);
            const index = lines.findIndex((l) => l.id === id);
            if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
          };
          if (e.key === "ArrowDown") go(at < 0 ? stops.length - 1 : at + 1);
          else if (e.key === "ArrowUp") go(at < 0 ? stops.length - 1 : at - 1);
          else if (e.key === "Home") go(0);
          else if (e.key === "End") go(stops.length - 1);
          else if (e.key === "Enter" || e.key === "ArrowRight")
            act(lines.find((l) => l.id === cursor));
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {view && (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const line = lines[v.index];
              if (!line) return null;
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
                  {renderLine(line)}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {live !== null && !atEnd && (
        <button
          type="button"
          data-testid="jump-live"
          onClick={() => setAtEnd(true)}
          className="fade absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center rounded-full border border-line-strong bg-canvas px-3 text-sm text-fg-2 hover:text-fg"
        >
          Jump to live ↓
        </button>
      )}
    </div>
  );
}

/**
 * the right-hand column every block of the conversation shares: a prompt's time, a quiet copy.
 * prompts and answers end on the same edge because of it.
 */
function Gutter({ children }: { children?: ReactNode }) {
  return <div className="flex w-11 shrink-0 flex-col items-end gap-1 pt-0.5">{children}</div>;
}

function CopyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fade hidden rounded-sm px-1 text-meta text-fg-3 group-hover:block hover:bg-raised hover:text-fg-2"
    >
      Copy
    </button>
  );
}

/**
 * what the person asked: a raised block with the words as they typed them, never rendered as
 * markdown. a slash command is its command in mono. a background task finishing is not the person
 * at all, so it is one quiet line.
 */
function PromptBlock({
  id,
  turn,
  tokens,
  cursor,
  focused,
  open,
  onToggle,
  onCopy,
}: {
  id: string;
  turn: ConversationTurn;
  tokens: readonly string[];
  cursor: boolean;
  focused: boolean;
  open: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const prompt = turn.prompt;
  if (!prompt) return null;
  if (prompt.kind === "task") {
    return (
      <div
        id={`line-${id}`}
        role="option"
        aria-selected={cursor}
        data-testid="prompt"
        data-kind="task"
        data-cursor={cursor || undefined}
        className={cx(
          "fade mx-2 mt-3 flex items-start gap-3 rounded-md px-3",
          cursor && focused ? "bg-active" : cursor && "bg-raised",
        )}
      >
        <p className="min-w-0 flex-1 truncate py-1.5 text-sm text-fg-3" title={prompt.text}>
          {prompt.status && prompt.status !== "completed"
            ? `Background task ${prompt.status}`
            : "Background task finished"}{" "}
          · <Highlighted text={prompt.text} tokens={tokens} />
        </p>
        <span className="shrink-0 pt-1.5 font-mono text-meta tabular-nums text-fg-4">
          {timeOf(prompt.at)}
        </span>
      </div>
    );
  }
  return (
    <div
      id={`line-${id}`}
      role="option"
      aria-selected={cursor}
      data-testid="prompt"
      data-kind={prompt.kind}
      data-cursor={cursor || undefined}
      className="group flex items-start gap-3 pt-4 pr-5 pl-5"
    >
      <div
        className={cx(
          "fade min-w-0 flex-1 rounded-md px-3 py-2",
          cursor && focused ? "bg-active" : "bg-raised",
        )}
      >
        <Folded lines={8} open={open} onToggle={onToggle}>
          <p
            className={cx(
              "selectable whitespace-pre-wrap break-words text-fg",
              prompt.kind === "command" && "font-mono text-meta",
            )}
          >
            <Highlighted text={prompt.text} tokens={tokens} />
          </p>
        </Folded>
        {(prompt.images || prompt.plan) && (
          <div className="mt-1.5 flex gap-2 text-meta text-fg-3">
            {prompt.images ? (
              <span
                className="rounded-sm border border-line-strong px-1.5"
                data-testid="prompt-images"
              >
                {prompt.images} {prompt.images === 1 ? "image" : "images"}
              </span>
            ) : null}
            {prompt.plan && <span data-testid="prompt-plan">plan mode</span>}
          </div>
        )}
      </div>
      <div className="flex w-11 shrink-0 flex-col items-end gap-1 pt-2">
        <span className="font-mono text-meta tabular-nums text-fg-4">{timeOf(prompt.at)}</span>
        <CopyButton onClick={onCopy} />
      </div>
    </div>
  );
}

/** what was asked of the person, and what they said: always in sight */
function MarkBlock({
  mark,
  tokens,
  open,
  onToggle,
}: {
  mark: Mark;
  tokens: readonly string[];
  open: boolean;
  onToggle: () => void;
}) {
  if (mark.kind === "said") {
    // the person's words too, but said into a turn under way: quieter than a prompt, and saying so
    return (
      <div className="flex items-start gap-3 pt-2 pr-5 pl-5" data-testid="mark" data-kind="said">
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-meta text-fg-3">While it worked</p>
          <div className="rounded-md bg-raised px-3 py-1.5">
            <p className="selectable whitespace-pre-wrap break-words text-sm text-fg">
              <Highlighted text={mark.text} tokens={tokens} />
            </p>
          </div>
        </div>
        <span className="w-11 shrink-0 pt-6 text-right font-mono text-meta tabular-nums text-fg-4">
          {timeOf(mark.at)}
        </span>
      </div>
    );
  }
  if (mark.kind === "question") {
    return (
      <div className="px-5 pt-2.5 pb-1" data-testid="mark" data-kind="question">
        {mark.questions.map((q, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: questions are fixed once asked
          <div key={i} className={cx(i > 0 && "mt-2")}>
            <p className="text-meta text-fg-3">{q.header ?? "Asked"}</p>
            <p className="max-w-[68ch] text-fg-2">
              <Highlighted text={q.question} tokens={tokens} />
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-fg" data-testid="picked">
              {q.picked ? (
                <>
                  <Icon name="check" size={11} className="text-fg-3" />
                  <Highlighted text={q.picked} tokens={tokens} />
                </>
              ) : (
                <span className="text-fg-3">{mark.declined ? "Not answered" : "Waiting"}</span>
              )}
            </p>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      className="px-5 pt-2.5 pb-1"
      data-testid="mark"
      data-kind="plan"
      data-outcome={mark.outcome}
    >
      <p className="mb-1 text-meta text-fg-3">
        Plan
        {mark.outcome === "approved"
          ? " · approved"
          : mark.outcome === "rejected"
            ? " · turned down"
            : ""}
      </p>
      <div className="border-l border-line-strong pl-3" data-testid="plan-text">
        <Folded lines={12} open={open} onToggle={onToggle}>
          <Markdown text={mark.text} marks={tokens} className="max-w-[68ch]" />
        </Folded>
      </div>
      {mark.said && (
        <div className="mt-2 flex items-start gap-3">
          <div className="min-w-0 flex-1 rounded-md bg-raised px-3 py-1.5" data-testid="plan-said">
            <p className="selectable whitespace-pre-wrap break-words text-fg">
              <Highlighted text={mark.said} tokens={tokens} />
            </p>
          </div>
          <span className="w-11 shrink-0" />
        </div>
      )}
    </div>
  );
}

/** `── compacted · 1.0M → 25k tokens ──── more`: what came before was summarised */
function Divider({
  divider,
  open,
  onToggle,
}: {
  divider: Extract<ConversationLine, { type: "compact" }>["divider"];
  open: boolean;
  onToggle: () => void;
}) {
  const k = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
  const tokens =
    divider.preTokens !== undefined && divider.postTokens !== undefined
      ? ` · ${k(divider.preTokens)} → ${k(divider.postTokens)} tokens`
      : divider.preTokens !== undefined
        ? ` · ${k(divider.preTokens)} tokens`
        : "";
  return (
    <div className="px-5 pt-5 pb-2" data-testid="compaction">
      <div className="flex items-center gap-3 text-meta text-fg-3">
        <span className="h-px w-5 bg-line" />
        <span className="shrink-0">
          {divider.trigger === "manual" ? "compacted with /compact" : "compacted"}
          {tokens}
        </span>
        <span className="h-px flex-1 bg-line" />
        {divider.summary && (
          <button
            type="button"
            data-testid="compaction-more"
            onClick={onToggle}
            className="fade shrink-0 hover:text-fg-2"
          >
            {open ? "less" : "more"}
          </button>
        )}
      </div>
      {open && divider.summary && (
        <div className="mt-2 border-l border-line pl-3" data-testid="compaction-summary">
          <Markdown text={divider.summary} className="max-w-[68ch] text-fg-3" />
        </div>
      )}
    </div>
  );
}
