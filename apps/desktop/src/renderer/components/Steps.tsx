import { shortPath, toolLabel } from "@grove/core/pure";
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
import { useStore } from "../state/store.ts";
import { Markdown } from "./Markdown.tsx";
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
  body: (stepId: string) => {
    cacheKey: string;
    load: () => Promise<StepDetail | null>;
    /** where the session ran: a file it touched is said from there */
    cwd?: string | undefined;
  };
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
  cwd,
  onCopy,
}: {
  cacheKey: string;
  load: () => Promise<StepDetail | null>;
  cwd?: string | undefined;
  onCopy: (text: string | undefined, what: string) => void;
}) {
  const [body, setBody] = useState<StepDetail | null | undefined>(stepBodies.get(cacheKey));
  const [arrived, setArrived] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // opened near the bottom, it would unfold out of sight. only when it has just been read: a body
  // drawn again from the cache (scrolled back into a virtual list, or the list put back as it was)
  // must not move the list
  useEffect(() => {
    if (arrived) ref.current?.scrollIntoView({ block: "nearest" });
  }, [arrived]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cache key names what load reads
  useEffect(() => {
    if (stepBodies.has(cacheKey)) return;
    let cancelled = false;
    void load()
      .then((value) => {
        if (cancelled) return;
        if (value) remember(stepBodies, cacheKey, value, 48);
        setBody(value);
        setArrived(true);
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
        <RichBody body={body} cwd={cwd} onCopy={onCopy} />
      )}
    </div>
  );
}

/**
 * what a tool did, drawn as what it is: a diff, a command and its output, a checklist, a question
 * with its options, a plan. anything else is its input and its result. the json input is always one
 * quiet click away.
 */
function RichBody({
  body,
  cwd,
  onCopy,
}: {
  body: StepDetail;
  cwd?: string | undefined;
  onCopy: (text: string | undefined, what: string) => void;
}) {
  const home = useStore((s) => s.env?.home);
  const [raw, setRaw] = useState(false);
  const rich =
    !!body.diffs?.length || !!body.bash || !!body.todos || !!body.questions || !!body.plan;
  const failedResult = body.isError && body.result !== undefined && !body.bash;
  return (
    <>
      {body.diffs?.map((d) => (
        // one file is the file on the step's own line: it needs no name of its own
        <DiffView
          key={d.path}
          diff={d}
          named={(body.diffs?.length ?? 0) > 1 || !!d.created}
          cwd={cwd}
          home={home}
        />
      ))}
      {body.bash && <BashView bash={body.bash} failed={!!body.isError} />}
      {body.todos && <TodoView todos={body.todos} />}
      {body.questions && <QuestionsView questions={body.questions} />}
      {body.plan && (
        <div className="py-1" data-testid="step-plan">
          <Markdown text={body.plan} className="max-w-[68ch]" />
        </div>
      )}
      {!rich && <Part label="Input" text={body.input} onCopy={() => onCopy(body.input, "Input")} />}
      {(!rich || failedResult) && body.result !== undefined && (
        <Part
          label={body.isError ? "Result, an error" : "Result"}
          text={body.result || "(empty)"}
          onCopy={() => onCopy(body.result, "Result")}
          testId="step-result"
        />
      )}
      {body.persisted && (
        <p className="py-1 text-meta text-fg-3" data-testid="step-persisted">
          Too big for the transcript: Claude Code saved the whole of it to{" "}
          <span className="selectable font-mono break-all text-fg-2">
            {shortPath(body.persisted, cwd, home)}
          </span>
        </p>
      )}
      {body.truncated && <p className="pt-1 text-meta text-fg-4">Cut at 200,000 characters.</p>}
      {rich && (
        <div className="flex gap-3 pt-1 text-meta text-fg-4">
          <button
            type="button"
            data-testid="step-raw"
            onClick={() => setRaw((r) => !r)}
            className="fade hover:text-fg-2"
          >
            {raw ? "Hide input" : "Input"}
          </button>
          <button
            type="button"
            onClick={() => onCopy(body.input, "Input")}
            className="fade hover:text-fg-2"
          >
            Copy input
          </button>
        </div>
      )}
      {rich && raw && (
        <pre className="selectable mt-1 max-h-64 overflow-auto font-mono text-meta whitespace-pre-wrap break-words text-fg-3">
          {body.input}
        </pre>
      )}
    </>
  );
}

type Diff = NonNullable<StepDetail["diffs"]>[number];

/**
 * a unified diff, from Claude Code's own patch: line numbers old and new, and the added and
 * removed lines on a low tint. text in spans - never parsed as anything
 */
function DiffView({
  diff,
  named,
  cwd,
  home,
}: {
  diff: Diff;
  named: boolean;
  cwd: string | undefined;
  home: string | undefined;
}) {
  const path = shortPath(diff.path, cwd, home);
  const cut = path.lastIndexOf("/") + 1;
  return (
    <div className="py-1" data-testid="step-diff">
      {named && (
        <p className="flex min-w-0 items-baseline gap-2 pb-1 font-mono text-meta" title={diff.path}>
          <span className="truncate text-fg-3">{path.slice(0, cut)}</span>
          <span className="shrink-0 text-fg-2">{path.slice(cut)}</span>
          {diff.created && <span className="shrink-0 font-sans text-fg-4">new file</span>}
        </p>
      )}
      <div className="selectable max-h-96 overflow-auto rounded-sm border border-line font-mono text-meta">
        {diff.hunks.map((h, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a patch's hunks never move
          <Hunk key={i} hunk={h} first={i === 0} />
        ))}
      </div>
    </div>
  );
}

function Hunk({ hunk, first }: { hunk: Diff["hunks"][number]; first: boolean }) {
  let oldN = hunk.oldStart;
  let newN = hunk.newStart;
  return (
    <>
      {!first && (
        <div className="border-t border-line px-2 text-fg-4" aria-hidden="true">
          ⋯
        </div>
      )}
      {hunk.lines.map((line, i) => {
        const mark = line[0];
        const added = mark === "+";
        const removed = mark === "-";
        const a = added ? "" : String(oldN);
        const b = removed ? "" : String(newN);
        // "\\ No newline at end of file" is about the line before it, and counts as neither
        if (mark !== "\\") {
          if (!removed) newN++;
          if (!added) oldN++;
        }
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of a hunk never move
            key={i}
            data-diff={added ? "add" : removed ? "del" : undefined}
            className={cx("flex", added && "bg-diff-add", removed && "bg-diff-del")}
          >
            <span className="w-9 shrink-0 pr-1 text-right text-fg-4 select-none">{a}</span>
            <span className="w-9 shrink-0 pr-1 text-right text-fg-4 select-none">{b}</span>
            <span className="w-4 shrink-0 text-center text-fg-3 select-none">
              {added || removed ? mark : ""}
            </span>
            <span className="min-w-0 flex-1 pr-2 whitespace-pre-wrap break-words text-fg-2">
              {line.slice(1) || " "}
            </span>
          </div>
        );
      })}
    </>
  );
}

/** `$ command`, what it printed, and what it printed on stderr - the one colour a failure takes */
function BashView({ bash, failed }: { bash: NonNullable<StepDetail["bash"]>; failed: boolean }) {
  const errorTone = failed ? "text-accent" : "text-fg-2";
  return (
    <div className="py-1 font-mono text-meta" data-testid="step-bash">
      {bash.command && (
        <p className="selectable pb-1 whitespace-pre-wrap break-words text-fg-2">
          <span className="text-fg-4 select-none">$ </span>
          {bash.command}
        </p>
      )}
      {bash.stdout && (
        <pre
          className="selectable max-h-72 overflow-auto whitespace-pre-wrap break-words text-fg-2"
          data-testid="step-stdout"
        >
          {bash.stdout}
        </pre>
      )}
      {bash.stderr.trim() && (
        <pre
          className={cx(
            "selectable mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words",
            errorTone,
          )}
          data-testid="step-stderr"
          data-error={failed || undefined}
        >
          {bash.stderr}
        </pre>
      )}
      {!bash.stdout && !bash.stderr.trim() && <p className="text-fg-4">(no output)</p>}
      {(bash.exit || bash.interrupted || bash.background) && (
        <p className="pt-1 font-sans text-meta text-fg-3">
          {[
            bash.exit,
            bash.interrupted && "interrupted",
            bash.background && `went on in the background as ${bash.background}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

const TODO_MARK: Record<string, string> = { completed: "✓", in_progress: "●" };

function TodoView({ todos }: { todos: NonNullable<StepDetail["todos"]> }) {
  return (
    <ul className="py-1 text-sm" data-testid="step-todos">
      {todos.map((t, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: a list as it was written
          key={i}
          data-status={t.status}
          className={cx(
            "flex items-baseline gap-2",
            t.status === "completed"
              ? "text-fg-3"
              : t.status === "in_progress"
                ? "text-fg"
                : "text-fg-2",
          )}
        >
          <span className="w-3 shrink-0 text-center text-fg-4">{TODO_MARK[t.status] ?? "○"}</span>
          <span className="min-w-0">{t.content}</span>
        </li>
      ))}
    </ul>
  );
}

/** every question with every option, and what was picked */
function QuestionsView({ questions }: { questions: NonNullable<StepDetail["questions"]> }) {
  return (
    <div className="py-1 text-sm" data-testid="step-questions">
      {questions.map((q, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: questions are fixed once asked
        <div key={i} className={cx(i > 0 && "mt-2")}>
          {q.header && <p className="text-meta text-fg-3">{q.header}</p>}
          <p className="text-fg-2">{q.question}</p>
          <ul className="mt-0.5">
            {q.options.map((o) => (
              <li
                key={o}
                className={cx(
                  "flex items-baseline gap-2",
                  o === q.picked ? "text-fg" : "text-fg-3",
                )}
                data-picked={o === q.picked || undefined}
              >
                <span className="w-3 shrink-0 text-center text-fg-4">
                  {o === q.picked ? "✓" : "·"}
                </span>
                {o}
              </li>
            ))}
            {q.picked && !q.options.includes(q.picked) && (
              <li className="flex items-baseline gap-2 text-fg" data-picked>
                <span className="w-3 shrink-0 text-center text-fg-4">✓</span>
                {q.picked}
              </li>
            )}
          </ul>
        </div>
      ))}
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
