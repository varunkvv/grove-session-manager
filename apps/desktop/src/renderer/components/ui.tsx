import {
  formatRelativeTime,
  highlightRanges,
  KIND_WORD,
  type Recap,
  type Runtime,
} from "@grove/core/pure";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ProjectId } from "../../shared/ipc.ts";
import { projectHues, runningFor, type SessionState } from "../logic/views.ts";
import { optionId } from "../state/actions.ts";
import { useStore } from "../state/store.ts";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export type IconName =
  | "inbox"
  | "branch"
  | "folder"
  | "plus"
  | "search"
  | "chevron"
  | "x"
  | "warning"
  | "check";

const PATHS: Record<IconName, ReactNode> = {
  inbox: (
    <path d="M2.25 9.25 4.4 3.5h7.2l2.15 5.75v2.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-2.5ZM2.25 9.25h3.25a2.5 2.5 0 0 0 5 0h3.25" />
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-7 4" />
    </>
  ),
  folder: (
    <path d="M1.75 4.25c0-.55.45-1 1-1h3l1.5 1.5h6c.55 0 1 .45 1 1v6.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1v-8Z" />
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </>
  ),
  chevron: <path d="m6 4 4 4-4 4" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  warning: <path d="M8 2.25 14.25 13H1.75L8 2.25ZM8 6.5v3M8 11.25v.01" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
};

export function Icon({
  name,
  size = 14,
  className,
  faint,
}: {
  name: IconName;
  size?: number;
  className?: string;
  /** the icon grey: 3:1, never for words */
  faint?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("shrink-0", faint && "text-faint", className)}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className="spinner shrink-0 text-fg-3"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** local reads are fast, so most of the time nothing flashes */
export function Loading() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 300);
    return () => clearTimeout(t);
  }, []);
  if (!late) return null;
  return (
    <div className="flex justify-center pt-24" data-testid="loading">
      <Spinner />
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "quiet" | "link";
type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  // the accent: the one action a screen is for
  primary: "bg-accent-solid text-on-solid font-medium enabled:hover:opacity-90",
  // row actions
  secondary:
    "border border-line-strong bg-canvas text-fg-2 enabled:hover:bg-raised enabled:hover:text-fg",
  // Cancel, Start in the background
  ghost: "text-fg-2 enabled:hover:bg-raised enabled:hover:text-fg",
  // Edit project, Add folder…
  quiet: "text-fg-3 enabled:hover:bg-raised enabled:hover:text-fg",
  link: "font-medium text-accent enabled:hover:underline focus-visible:underline",
};
const SIZES: Record<ButtonSize, string> = {
  sm: "h-6 gap-1.5 px-2 text-sm",
  md: "h-7 gap-1.5 px-3 text-body",
  lg: "h-8 gap-1.5 px-3 text-body",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        // a disabled button keeps its pointer: its title says why, and a click stops on it
        "no-drag fade disabled:opacity-40",
        // a link sits in a line of prose: no height, no padding
        variant === "link"
          ? "inline p-0 align-baseline"
          : cx("inline-flex shrink-0 items-center justify-center rounded-md", SIZES[size]),
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        "no-drag fade inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-4 hover:bg-raised hover:text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-line-strong bg-canvas px-1 font-sans text-meta leading-none text-fg-4">
      {children}
    </kbd>
  );
}

/** the way out of a panel, with the key that does the same */
export function EscButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={onClick}
      data-testid="panel-close"
      className="no-drag fade flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-fg-3 hover:bg-raised hover:text-fg"
    >
      <Icon name="x" size={12} />
      <Kbd>esc</Kbd>
    </button>
  );
}

/**
 * a double-click on a row whose first click opens a panel. the panel takes half the screen and the
 * rows reflow, so the second click lands on whatever is under the pointer by then: the panel,
 * another row, a button, the list's scrollbar. the pair belongs to the row its first click was on:
 * that click remembers the row, and the second press opens that row's session wherever it lands.
 *
 * the second press, not `dblclick`: a press on a scrollbar is followed by no click and no
 * dblclick, and in a long list the scrollbar is what the middle of a row ends up under
 */
export function useRowDoubleClick<T>(run: (row: T) => void) {
  const first = useRef<T | null>(null);
  return {
    /** from the row's own click */
    clicked: (row: T) => {
      first.current = row;
    },
    /** for the element that holds the list and the panel */
    root: {
      onMouseDownCapture: (e: MouseEvent) => {
        if (e.detail === 2 && first.current) run(first.current);
      },
      onClickCapture: (e: MouseEvent) => {
        // 1 is a first click and 0 a key on a button: either starts over
        if (e.detail < 2) first.current = null;
        // the second click is nobody's
        else if (first.current) {
          e.stopPropagation();
          // a link in the panel would otherwise be followed
          e.preventDefault();
        }
      },
    },
  };
}

/**
 * a list screen and the row that is open in it. the list keeps the left and scrolls by itself, the
 * panel takes the right half behind a line. the list is a container: a row drops its where cells
 * as it narrows, and beside the panel its state is the mark alone. `root` is what
 * `useRowDoubleClick` gives
 */
export function Split({
  panel,
  label,
  testId,
  root,
  from,
  children,
}: {
  /** what is open, or nothing */
  panel: ReactNode;
  label?: string;
  /** the list's scroller */
  testId?: string;
  root: ReturnType<typeof useRowDoubleClick>["root"];
  /** what the list was narrowed by. a new one starts it over from its top */
  from?: string;
  children: ReactNode;
}) {
  const peek = useStore((s) => s.peek);
  const scroller = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `from` is when, not what
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [from]);
  const shown = !!panel;
  // the list narrows when the panel opens and the rows above the open one grow: it stays on
  // screen. a landing names the row before its list has arrived, so this waits for the panel
  useEffect(() => {
    if (peek && shown)
      document.getElementById(optionId(peek))?.scrollIntoView({ block: "nearest" });
  }, [peek, shown]);
  return (
    <div className="flex h-full" {...root}>
      {/* the gutter stays, so the column does not move when the list grows long enough to scroll */}
      <div
        ref={scroller}
        className="@container h-full min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        data-scroller
        data-testid={testId}
      >
        <div className="mx-auto max-w-[860px] px-4 pt-8 pb-16">{children}</div>
      </div>
      {panel && (
        <section
          aria-label={label}
          className="h-full w-1/2 shrink-0 border-l border-line"
          data-testid="panel"
        >
          {panel}
        </section>
      )}
    </div>
  );
}

/** the only places monospace is allowed: paths, branches, SHAs and commands */
export function Mono({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cx("font-mono text-meta", className)}>
      {children}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
  disabled,
}: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean; testId?: string }>;
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
  /** the whole group */
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cx(
        "no-drag inline-flex shrink-0 rounded-md border border-line-strong bg-raised p-0.5 text-sm",
        disabled && "opacity-60",
      )}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled || o.disabled}
            data-testid={o.testId}
            onClick={() => onChange(o.value)}
            className={cx(
              "fade rounded-sm",
              // a disabled group is dimmed whole, once
              !disabled && "disabled:opacity-40",
              size === "md" ? "h-[26px] px-3" : "h-[22px] px-2",
              checked
                ? "bg-canvas font-medium outline outline-1 outline-line-strong"
                : !disabled && "hover:text-fg",
              checked && !disabled ? "text-fg" : "text-fg-3",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** neutral on purpose: the accent is for state that needs attention, and a preference is not that */
export function Switch({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={cx(
        "no-drag fade relative h-4 w-7 shrink-0 rounded-full",
        checked ? "bg-fg-2" : "bg-line-strong",
      )}
    >
      <span
        className={cx(
          "fade absolute top-0.5 h-3 w-3 rounded-full bg-canvas",
          checked ? "left-3.5" : "left-0.5",
        )}
      />
    </button>
  );
}

/** native <dialog>: focus trap, Escape and the backdrop come from the platform */
export function Modal({
  open,
  onClose,
  title,
  width = 560,
  children,
  footer,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // showModal hands the keyboard to the first focusable, the close button. a dialog says where
      // it starts instead
      el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      data-testid={testId}
      aria-label={title}
      style={{ width }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="flex max-h-[calc(100vh-80px)] flex-col">
        <header className="flex items-center justify-between px-5 pt-4 pb-3">
          <h2 className="text-title font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <Icon name="x" />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </dialog>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-sm text-fg-4">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "no-drag h-8 w-full rounded-md border border-line-strong bg-canvas px-2.5 text-body text-fg placeholder:text-fg-4";

/**
 * a select the way the other fields look. `appearance: none` takes the platform's arrow away, and
 * without one a select reads as a text field - so it gets the app's own chevron back.
 */
export function Select({
  className,
  wrapClassName,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { wrapClassName?: string }) {
  return (
    <div className={cx("relative", wrapClassName)}>
      <select className={cx(inputClass, "pr-7", className)} {...rest}>
        {children}
      </select>
      <Icon
        name="chevron"
        size={10}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rotate-90 text-fg-3"
      />
    </div>
  );
}

/** text with the search's words marked, the same way everywhere a query is shown */
export function Highlighted({ text, tokens }: { text: string; tokens: readonly string[] }) {
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

// ---------- colour means something, and is given here and nowhere else: a screen passes a state,
// a project or a count, never a colour.

/**
 * a tooltip-dated relative time: `3m ago`, core's words. with `since`, how long something has been
 * going on: `for 12m`
 */
export function Time({ at, since, className }: { at: number; since?: number; className?: string }) {
  const now = useStore((s) => s.now);
  return (
    <span
      className={cx("shrink-0 text-sm tabular-nums text-fg-4", className)}
      title={new Date(since ?? at).toLocaleString()}
    >
      {since === undefined ? formatRelativeTime(at, now) : runningFor(since, now)}
    </span>
  );
}

type Glyph = Exclude<SessionState, "working">;

const GLYPH: Record<Glyph, ReactNode> = {
  permission: <path d="M8 4.5v4.2M8 11.4v.01" />,
  turn: <path d="M6.2 6.3a1.9 1.9 0 1 1 2.9 1.6c-.7.45-1.1.85-1.1 1.6M8 11.7v.01" />,
  failed: <path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" />,
  stopped: <rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.75" fill="black" />,
};

/**
 * a disc with its glyph cut out of it. the mask keeps everything but the glyph, so the cut-out is
 * a real hole that shows whatever is behind it: white, the hover grey or the dark ground. white
 * and black are mask luminance, not colours
 */
function Disc({ glyph, size }: { glyph: Glyph; size: number }) {
  // ids must be unique per svg on the page, and some useId characters do not survive `url(#…)`
  const id = `g${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
      <mask id={id}>
        <rect width="16" height="16" fill="white" />
        <g
          fill="none"
          stroke="black"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {GLYPH[glyph]}
        </g>
      </mask>
      <circle cx="8" cy="8" r="7" fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}

/** one colour per state, everywhere it shows: the mark takes the hue, the word its 4.5:1 twin */
const STATES: Record<SessionState, { word: string; mark: string; tone: string }> = {
  permission: { word: KIND_WORD.permission, mark: "text-hue-orange", tone: "text-waiting" },
  turn: { word: KIND_WORD.turn, mark: "text-accent", tone: "text-accent" },
  failed: { word: KIND_WORD.failed, mark: "text-hue-red", tone: "text-danger" },
  stopped: { word: KIND_WORD.stopped, mark: "text-hue-red", tone: "text-danger" },
  working: { word: "Working", mark: "text-hue-green", tone: "text-working" },
};

/** the state's word, for aria labels */
export const stateWord = (state: SessionState): string => STATES[state].word;

/** where the word gives way to its mark alone: a list beside the panel, the head of a narrow panel */
const WORD = { list: "hidden @xl:inline", panel: "hidden @md:inline" };

/** what a session is at */
export function StateLabel({
  state,
  within,
  className,
}: {
  state: SessionState;
  within: keyof typeof WORD;
  className?: string;
}) {
  const s = STATES[state];
  return (
    <span
      data-testid="state"
      data-state={state}
      title={s.word}
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium",
        s.tone,
        className,
      )}
    >
      <span className={cx("flex size-3 items-center justify-center", s.mark)}>
        {state === "working" ? (
          // a running session breathes
          <span className="live-pulse size-2 rounded-full bg-hue-green" />
        ) : (
          <Disc glyph={state} size={12} />
        )}
      </span>
      <span className={WORD[within]}>{s.word}</span>
    </span>
  );
}

/** written out whole: tailwind only emits the classes it can see */
const PROJECT_FILL = [
  "bg-project-1",
  "bg-project-2",
  "bg-project-3",
  "bg-project-4",
  "bg-project-5",
  "bg-project-6",
  "bg-project-7",
  "bg-project-8",
  "bg-project-9",
];

/** a project's own colour, beside its name wherever a row says which project it is */
export function ProjectMark({ id }: { id: ProjectId }) {
  const hue = useStore((s) => projectHues(s.projects).get(id)) ?? 1;
  return (
    <span
      aria-hidden="true"
      data-testid="project-mark"
      data-hue={hue}
      className={cx("size-2 shrink-0 rounded-[2px]", PROJECT_FILL[hue - 1])}
    />
  );
}

/** how many sessions need the person: filled, so it is found in a column of names */
function CountPill({ n, testId }: { n: number; testId?: string }) {
  if (n <= 0) return null;
  return (
    <span
      data-testid={testId}
      className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent-solid px-1.5 text-meta font-semibold leading-none tabular-nums text-on-solid"
    >
      {n}
    </span>
  );
}

/** a row of the sidebar. the one on screen is tinted with the accent, not grey */
export function SideItem({
  selected,
  mark,
  label,
  count,
  onClick,
  onDoubleClick,
  testId,
  id,
}: {
  selected: boolean;
  /** an icon, or a project's mark */
  mark: ReactNode;
  label: string;
  count: number;
  onClick: () => void;
  /** a project's: a new session in it. the first click of the two has already gone to it */
  onDoubleClick?: () => void;
  testId: string;
  id?: string;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      title={onDoubleClick ? `${label} - double-click for a new session` : label}
      data-testid={testId}
      data-id={id}
      data-count={count}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cx(
        "no-drag fade flex h-7 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-body",
        selected ? "bg-accent-soft font-medium text-fg" : "text-fg-2 hover:bg-active hover:text-fg",
      )}
    >
      <span className="flex w-3.5 shrink-0 justify-center">{mark}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <CountPill n={count} testId="count" />
    </button>
  );
}

const RECAP_ROWS: ReadonlyArray<[keyof Recap, string]> = [
  ["goal", "Goal"],
  ["done", "Done"],
  ["state", "Now"],
  ["needs", "Needs you"],
];

/**
 * what a session was for and where it stands: the one tinted surface of the panel, so it is what
 * the eye lands on. the lines are plain text on purpose. a model wrote them from an agent's
 * output, so they are never markdown and never a link
 */
export function RecapBlock({ lines }: { lines: Recap }) {
  return (
    <dl
      data-testid="recap"
      className="selectable space-y-1.5 rounded-lg bg-accent-soft px-3 py-2.5 @md:px-4 @md:py-3"
    >
      {RECAP_ROWS.map(([key, label]) => (
        // the label runs into its line in a narrow panel, where every row of text counts, and
        // has a column of its own once there is room
        <div key={key} className="@md:grid @md:grid-cols-[72px_1fr] @md:gap-x-3">
          <dt
            className={cx(
              "mr-2 inline text-sm font-medium @md:mr-0 @md:block",
              // what is asked of the person is the accent's, like Your turn
              key === "needs" ? "text-accent" : "text-fg-3",
            )}
          >
            {label}
          </dt>
          <dd data-testid={`recap-${key}`} className="inline break-words text-fg @md:block">
            {lines[key]}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const RUNTIME_WORD: Record<Exclude<Runtime, "vscode">, string> = {
  terminal: "Terminal",
  background: "Background",
  // claude -p runs and SDK apps: no window to land in
  elsewhere: "Headless",
  closed: "Closed",
};

export function RuntimeChip({ runtime }: { runtime: Runtime }) {
  const editor = useStore((s) => s.editor?.label ?? "Editor");
  return (
    <span
      data-testid="runtime-chip"
      data-runtime={runtime}
      className="inline-flex h-[18px] shrink-0 items-center whitespace-nowrap rounded-sm border border-line-strong bg-raised px-1.5 text-meta leading-none text-fg-3"
    >
      {runtime === "vscode" ? editor : RUNTIME_WORD[runtime]}
    </span>
  );
}

/**
 * the one popover shape: the switcher and the palette. no keys here: the global handler knows an
 * overlay is open from the store.
 *
 * both layers are `no-drag`. app-region is inherited, and the switcher's overlay is drawn inside the
 * top bar: left alone it is a window drag region, where macOS takes a click as the start of a drag
 */
export function Overlay({
  open,
  onClose,
  style,
  className,
  testId,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** fixed position of the panel. the caller measures its anchor */
  style: CSSProperties;
  className?: string;
  testId: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div
        className="no-drag fixed inset-0 z-40"
        onMouseDown={onClose}
        data-testid="overlay-backdrop"
      />
      <div
        className={cx(
          "no-drag fixed z-50 rounded-lg border border-line-strong bg-overlay overlay-shadow",
          className,
        )}
        style={style}
        data-testid={testId}
      >
        {children}
      </div>
    </>
  );
}

/** a row inside an Overlay. `data-active` is the keyboard's row */
export const menuItemClass =
  "fade flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-body text-fg-2 data-[active]:bg-raised data-[active]:text-fg";
