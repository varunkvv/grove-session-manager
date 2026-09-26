import { toolLabel } from "@grove/core/pure";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { StepDetail } from "../../shared/ipc.ts";
import { offsetLabel, type StepItem, type ToolLine } from "../logic/steps.ts";
import { cx, Icon } from "./ui.tsx";

// the lines of work an agent did, or a session's turn: the same steps, drawn the same way in the
// agent detail and in the conversation

/** a line's height, and so the unit a folded block is measured in */
export const LINE = 20;

/** what opened steps read back, so opening one again draws it at once */
const stepBodies = new Map<string, StepDetail>();

export function remember<V>(map: Map<string, V>, key: string, value: V, max = 24): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * a block folded to so many lines, with "more" under it when there is more. the fold state lives
 * with the caller: a virtual list forgets whatever scrolls away.
 */
export function Folded({
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
export function Line({
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

export function ToolItem({
  item,
  body,
  start,
  live,
  open,
  cursor,
  focused,
  onClick,
  onCopy,
}: {
  item: Extract<StepItem, { type: "tool" }>;
  /** where an opened step reads its whole input and result from */
  body: (stepId: string) => { cacheKey: string; load: () => Promise<StepDetail | null> };
  /** the start its offset is counted from: the agent's, or the turn's */
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
      {open && <StepBody {...body(s.id)} onCopy={onCopy} />}
    </div>
  );
}

export const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** a path that runs out of room loses its folders, never its file name */
export function PathTarget({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span className="flex min-w-0" title={path}>
      <span className="truncate text-fg-3">{path.slice(0, cut)}</span>
      <span className="shrink-0">{path.slice(cut)}</span>
    </span>
  );
}

/** a step opened in place: its whole input and what came back, read from disk on the way */
export function StepBody({
  cacheKey,
  load,
  onCopy,
}: {
  cacheKey: string;
  load: () => Promise<StepDetail | null>;
  onCopy: (text: string | undefined, what: string) => void;
}) {
  const [body, setBody] = useState<StepDetail | null | undefined>(stepBodies.get(cacheKey));
  const ref = useRef<HTMLDivElement>(null);
  // opened near the bottom, it would unfold out of sight
  useEffect(() => {
    if (body !== undefined) ref.current?.scrollIntoView({ block: "nearest" });
  }, [body]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cache key names what load reads
  useEffect(() => {
    if (stepBodies.has(cacheKey)) return;
    let cancelled = false;
    void load()
      .then((value) => {
        if (cancelled) return;
        if (value) remember(stepBodies, cacheKey, value, 48);
        setBody(value);
      })
      .catch(() => !cancelled && setBody(null));
    return () => {
      cancelled = true;
    };
  }, [cacheKey]);
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

export function Part({
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
