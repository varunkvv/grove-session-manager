import {
  type CardDisplayStatus,
  formatRelativeTime,
  highlightRanges,
  type InboxKind,
  KIND_WORD,
  type Runtime,
} from "@grove/core/pure";
import type { ConclusionKind } from "@grove/record/types";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from "react";
import { agentHue, initials, type WhoView } from "../logic/who.ts";
import { useStore } from "../state/store.ts";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export type IconName =
  | "arrow-left"
  | "file"
  | "pr"
  | "split"
  | "verdict"
  | "branch"
  | "folder"
  | "plus"
  | "search"
  | "more"
  | "chevron"
  | "x"
  | "external"
  | "terminal"
  | "copy"
  | "reveal"
  | "settings"
  | "warning"
  | "check"
  | "archive"
  | "lanes"
  | "stop"
  | "moon";

const PATHS: Record<IconName, ReactNode> = {
  "arrow-left": <path d="M13 8H3M7 4 3 8l4 4" />,
  file: (
    <>
      <path d="M4.25 1.75h5l3 3v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" />
      <path d="M9.25 1.75v3h3M5.75 8.5h4.5M5.75 11h4.5" />
    </>
  ),
  pr: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2h-2M9 3 7.5 4.5 9 6" />
    </>
  ),
  // a decision: one way in, two ways out
  split: <path d="M8 14V9.5L3.5 5M8 9.5 12.5 5M3.5 8.25V5h3.25M12.5 8.25V5H9.25" />,
  // a verdict: something looked at and ruled on
  verdict: (
    <>
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.5" />
      <path d="m5.25 8.25 2 2 3.5-4" />
    </>
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
  more: (
    <>
      <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
      <circle cx="8" cy="8" r="0.6" fill="currentColor" />
      <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
    </>
  ),
  chevron: <path d="m6 4 4 4-4 4" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  external: (
    <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />
  ),
  terminal: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
      <path d="m4.5 6 2 2-2 2M8.5 10h3" />
    </>
  ),
  copy: (
    <>
      <rect x="5.25" y="5.25" width="8" height="8" rx="1.25" />
      <path d="M10.75 5.25V3.5c0-.7-.55-1.25-1.25-1.25H3.5c-.7 0-1.25.55-1.25 1.25v6c0 .7.55 1.25 1.25 1.25h1.75" />
    </>
  ),
  reveal: (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="1.75" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
    </>
  ),
  warning: <path d="M8 2.25 14.25 13H1.75L8 2.25ZM8 6.5v3M8 11.25v.01" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  archive: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="3.5" rx="1" />
      <path d="M3.25 6.25v6a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6M6.5 9h3" />
    </>
  ),
  // the inspector's own picture, small: agents as lanes on a clock
  lanes: <path d="M2.25 4.5h5M5.25 8h8.5M3.75 11.5h5.5" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  // background: the session keeps going while you look away
  moon: <path d="M12.75 9.75A5.25 5.25 0 0 1 6.25 3.25a5.25 5.25 0 1 0 6.5 6.5Z" />,
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

type ButtonVariant = "primary" | "secondary" | "ghost" | "accent" | "destructive";

const VARIANTS: Record<ButtonVariant, string> = {
  // the primary button is inverted neutral. the accent is kept for state, not for decoration.
  primary: "bg-fg text-canvas hover:opacity-90",
  secondary: "bg-raised text-fg border border-line-strong hover:bg-active",
  ghost: "text-fg-2 hover:bg-raised hover:text-fg",
  accent: "text-accent hover:bg-accent-soft",
  destructive: "bg-destructive text-fg hover:opacity-90",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "no-drag fade inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-6 px-2 text-sm" : "h-7 px-3 text-sm",
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
        "no-drag fade inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-raised hover:text-fg",
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
}: {
  value: T;
  /**
   * `short` is what a header too narrow for `label` shows. it needs an @container around it.
   * `count` sits after the label, in the accent while something in it is waiting on a person.
   */
  options: Array<{
    value: T;
    label: string;
    short?: string;
    disabled?: boolean;
    testId?: string;
    count?: number;
  }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="no-drag inline-flex rounded-md bg-raised p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={o.disabled}
          data-testid={o.testId}
          onClick={() => onChange(o.value)}
          className={cx(
            "fade h-6 max-w-44 truncate rounded-sm px-2.5 text-sm disabled:opacity-40",
            o.value === value ? "bg-active text-fg" : "text-fg-3 hover:text-fg-2",
          )}
        >
          {o.short ? (
            <>
              <span className="@max-xl:hidden">{o.label}</span>
              <span className="hidden @max-xl:inline">{o.short}</span>
            </>
          ) : (
            o.label
          )}
          {o.count ? (
            <span className="ml-1.5 tabular-nums text-accent" data-testid="scope-count">
              {o.count}
            </span>
          ) : null}
        </button>
      ))}
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
    if (open && !el.open) el.showModal();
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
      <span className="mb-1 block text-sm text-fg-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-meta text-fg-3">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "no-drag h-8 w-full rounded-md border border-line-strong bg-canvas px-2.5 text-body text-fg placeholder:text-fg-4 focus:border-fg-3";

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

/**
 * what asks for you, said the same way everywhere: accent words on the soft tint, with the dot.
 * the three states differ by the word, not the colour - all of them are asking.
 */
export function NeedsPill({
  children,
  title,
  testId,
  state,
}: {
  children: ReactNode;
  title?: string;
  testId?: string;
  state?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-state={state}
      data-needs-you
      title={title}
      className="flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2 text-sm text-accent tabular-nums"
    >
      <span className="size-1.5 rounded-full bg-accent" />
      {children}
    </span>
  );
}

/**
 * how an agent stands, in words, where a row keeps its time: `● Running 8m`, `Done 5m`. running is
 * the one with a dot, a failed one the only colour (an error is what the accent is for).
 */
export function AgentState({
  status,
  word,
  time,
  title,
}: {
  status: "running" | "done" | "failed" | "interrupted";
  word: string;
  time?: string;
  title?: string;
}) {
  return (
    <span
      data-testid="agent-state"
      data-status={status}
      title={title}
      className={cx(
        "flex shrink-0 items-center gap-1.5 text-sm tabular-nums",
        status === "running" ? "text-fg-2" : "text-fg-3",
      )}
    >
      {status === "running" && <span className="live-pulse size-1.5 rounded-full bg-fg-3" />}
      <span>
        <span className={cx(status === "failed" && "text-accent" /* an error */)}>{word}</span>
        {time ? ` ${time}` : ""}
      </span>
    </span>
  );
}

/**
 * the tree's one guide: a hairline down the indent, drawn by each row for its own height so a
 * scrolled or virtualised list never loses a piece. no elbows, no dots - a thread's rail. the
 * last row of a tree stops it level with its text.
 */
export function TreeRail({ x, end }: { x: number; end?: number }) {
  return (
    <span
      aria-hidden
      data-testid="tree-rail"
      className="pointer-events-none absolute top-0 w-px bg-line"
      style={{ left: x, bottom: end ?? 0 }}
    />
  );
}

// ---------- the project manager's primitives. a kind, a status and an avatar get their colour here
// and nowhere else: a screen passes a kind or a status, never a colour.

/** a tooltip-dated relative time: `3m ago`, core's words */
export function Time({ at, className }: { at: number; className?: string }) {
  const now = useStore((s) => s.now);
  return (
    <span
      className={cx("shrink-0 text-sm tabular-nums text-fg-4", className)}
      title={new Date(at).toLocaleString()}
    >
      {formatRelativeTime(at, now)}
    </span>
  );
}

type DiscKind = "asked" | "new" | "finished" | "stopped";

const DISC: Record<DiscKind, ReactNode> = {
  asked: <path d="M6.2 6.3a1.9 1.9 0 1 1 2.9 1.6c-.7.45-1.1.85-1.1 1.6M8 11.7v.01" />,
  new: <path d="M8 5v6M5 8h6" />,
  finished: <path d="m5 8.2 2.1 2.1L11 6" />,
  stopped: <rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.75" fill="black" />,
};

/**
 * a mask that keeps everything but the glyph, so the cut-out is a real hole that shows whatever is
 * behind it: white, the hover grey or the dark ground. white and black are mask luminance, not colours
 */
function Hole({ id, children }: { id: string; children: ReactNode }) {
  return (
    <mask id={id}>
      <rect width="16" height="16" fill="white" />
      <g fill="none" stroke="black" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </mask>
  );
}

/** ids must be unique per svg on the page, and some useId characters do not survive `url(#…)` */
const maskId = (prefix: string, id: string) => `${prefix}${id.replace(/[^\w-]/g, "")}`;

export function KindIcon({ kind, size = 12 }: { kind: DiscKind; size?: number }) {
  const id = maskId("k", useId());
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
      <Hole id={id}>{DISC[kind]}</Hole>
      <circle cx="8" cy="8" r="7" fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}

export type Kind = InboxKind | ConclusionKind;

const KINDS: Record<Kind, { word: string; tone: string; disc?: DiscKind; icon?: IconName }> = {
  asked: { word: KIND_WORD.asked, tone: "text-hue-orange", disc: "asked" },
  decided: { word: KIND_WORD.decided, tone: "text-hue-violet", icon: "split" },
  decision: { word: "Decision", tone: "text-hue-violet", icon: "split" },
  verdict: { word: KIND_WORD.verdict, tone: "text-hue-teal", icon: "verdict" },
  found: { word: KIND_WORD.found, tone: "text-hue-blue", icon: "search" },
  finding: { word: "Finding", tone: "text-hue-blue", icon: "search" },
  new: { word: KIND_WORD.new, tone: "text-fg-3", disc: "new" },
  finished: { word: KIND_WORD.finished, tone: "text-hue-green", disc: "finished" },
  stopped: { word: KIND_WORD.stopped, tone: "text-hue-red", disc: "stopped" },
};

/** the kind's word, for aria labels */
export const kindWord = (kind: Kind): string => KINDS[kind].word;

/** only the icon takes the hue. the word stays grey */
export function KindLabel({
  kind,
  className,
  iconSize = 12,
}: {
  kind: Kind;
  className?: string;
  iconSize?: number;
}) {
  const k = KINDS[kind];
  return (
    <span
      data-testid="kind"
      data-kind={kind}
      className={cx("inline-flex shrink-0 items-center gap-1.5 text-fg-2", className)}
    >
      <span className={cx("flex", k.tone)}>
        {k.disc ? (
          <KindIcon kind={k.disc} size={iconSize} />
        ) : (
          k.icon && <Icon name={k.icon} size={iconSize} />
        )}
      </span>
      {k.word}
    </span>
  );
}

export const STATUS_LABEL: Record<CardDisplayStatus, string> = {
  waiting: "In progress, waiting on you",
  stopped: "Stopped",
  in_progress: "In progress",
  todo: "Todo",
  done: "Done",
  canceled: "Canceled",
};

const ring = (tone: string) => (
  <circle cx="7" cy="7" r="5.5" fill="none" className={tone} strokeWidth="1.5" />
);

/** waiting and in progress share a shape and differ by colour: their groups and the header say it in words */
export function StatusIcon({ status, size = 14 }: { status: CardDisplayStatus; size?: number }) {
  const id = maskId("s", useId());
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      className="shrink-0"
      aria-hidden="true"
      data-testid="status-icon"
      data-status={status}
    >
      {status === "done" && (
        <>
          <Hole id={id}>
            <path d="M4.3 7.2 6.2 9l3.5-3.8" />
          </Hole>
          <circle cx="7" cy="7" r="6" className="fill-hue-green" mask={`url(#${id})`} />
        </>
      )}
      {status === "todo" && ring("stroke-faint")}
      {status === "in_progress" && (
        <>
          {ring("stroke-hue-yellow")}
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7Z" className="fill-hue-yellow" />
        </>
      )}
      {status === "waiting" && (
        <>
          {ring("stroke-hue-orange")}
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7Z" className="fill-hue-orange" />
        </>
      )}
      {status === "stopped" && (
        <>
          {ring("stroke-hue-red")}
          <rect x="4.75" y="4.75" width="4.5" height="4.5" rx="0.75" className="fill-hue-red" />
        </>
      )}
      {status === "canceled" && (
        <>
          {ring("stroke-faint")}
          <path
            d="m4.6 9.4 4.8-4.8"
            fill="none"
            className="stroke-faint"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

/** written out whole: tailwind only emits the classes it can see */
const AGENT_FILL = [
  "bg-agent-1",
  "bg-agent-2",
  "bg-agent-3",
  "bg-agent-4",
  "bg-agent-5",
  "bg-agent-6",
  "bg-agent-7",
  "bg-agent-8",
  "bg-agent-9",
];

/** the person is a grey Y. an agent's fill is hashed from its session id, which outlives its name */
export function Avatar({ who, size = 16 }: { who: WhoView; size?: 16 | 18 | 20 }) {
  const person = who.kind === "person";
  return (
    <span
      aria-hidden="true"
      data-testid="avatar"
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none tracking-[0.01em]",
        person ? "bg-agent-you text-fg-2" : cx(AGENT_FILL[agentHue(who.id) - 1], "text-on-solid"),
      )}
      style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.42)) }}
    >
      {person ? "Y" : initials(who.name)}
    </span>
  );
}

/** in your inbox, or waiting on you. role img because biome refuses aria-label on a bare span */
export function Dot({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      data-testid="dot"
      className="size-1.5 shrink-0 rounded-full bg-accent"
    />
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

export function GroveMark({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="4.6" cy="6" r="3" />
      <circle cx="11.4" cy="6" r="3" />
      <circle cx="8" cy="11.4" r="3" />
    </svg>
  );
}

/**
 * a record file edited by hand or cut short. the readers show what they could read and never throw,
 * so it is a warning, not an error. `count` is for a row, where main sends a number
 */
export function ProblemMark({
  problems,
  file,
  count,
}: {
  problems?: string[];
  file?: string;
  count?: number;
}) {
  if (!problems?.length && !count) return null;
  const title = problems?.length
    ? `Grove read what it could${file ? ` from ${file}` : ""}: ${problems.join("; ")}.`
    : `Grove read ${count} of its files with problems. Open it to see which.`;
  return (
    <span
      role="img"
      aria-label="Read with problems"
      title={title}
      data-testid="problem"
      className="inline-flex shrink-0 text-waiting"
    >
      <Icon name="warning" size={12} />
    </span>
  );
}

/**
 * the one popover shape: the switcher and the palette. no keys here: the global handler knows an
 * overlay is open from the store
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
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        className={cx(
          "fixed z-50 rounded-lg border border-line-strong bg-overlay overlay-shadow",
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
