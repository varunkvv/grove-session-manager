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
  type MouseEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ArtifactView, ProjectId } from "../../shared/ipc.ts";
import { artifactName, cardTitle } from "../logic/views.ts";
import { agentHue, initials, type WhoView } from "../logic/who.ts";
import { openArtifact, openCard, openConclusion } from "../state/actions.ts";
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
  | "chevron"
  | "x"
  | "external"
  | "warning"
  | "check";

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
  chevron: <path d="m6 4 4 4-4 4" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  external: (
    <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />
  ),
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

/** the way out of a page or a panel, with the key that does the same */
export function EscButton({ label, onClick }: { label: "Back" | "Close"; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      data-testid={label === "Back" ? "back" : "panel-close"}
      className="no-drag fade flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-fg-3 hover:bg-raised hover:text-fg"
    >
      <Icon name={label === "Back" ? "arrow-left" : "x"} size={12} />
      <Kbd>esc</Kbd>
    </button>
  );
}

/**
 * a double-click on a row whose first click opens a panel. the panel takes half the screen and the
 * rows reflow, so the second click lands on whatever is under the pointer by then: the panel,
 * another row, a button. the pair belongs to the row its first click was on: that click remembers
 * the row, the second is nobody's wherever it lands, and the double-click runs for that row
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
      onClickCapture: (e: MouseEvent) => {
        // 1 is a first click and 0 a key on a button: either starts over
        if (e.detail < 2) first.current = null;
        else if (first.current) {
          e.stopPropagation();
          // a link in the panel would otherwise be followed
          e.preventDefault();
        }
      },
      onDoubleClick: () => {
        if (first.current) run(first.current);
      },
    },
  };
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

// ---------- a kind, a status and an avatar get their colour here and nowhere else: a screen passes
// a kind or a status, never a colour.

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
    : `Grove read its files with ${count === 1 ? "1 problem" : `${count} problems`}. Open it to see which.`;
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

// ---------- chips: a button that sits in a line of prose. a click never reaches the row it is in

const CHIP =
  "no-drag fade mx-0.5 inline-flex h-5 max-w-full items-center gap-1 rounded-sm border border-line-strong bg-raised px-1.5 align-bottom text-sm leading-none text-fg hover:bg-active";

/** a control inside a list row is not a tab stop. in a thread and the side panel it is */
const chipProps = (inRow: boolean | undefined, run: () => void) => ({
  type: "button" as const,
  className: CHIP,
  tabIndex: inRow ? -1 : undefined,
  onClick: (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    run();
  },
});

/** an id the record does not have stays plain text */
export function CardChip({
  cardId,
  withTitle,
  inRow,
}: {
  cardId: string;
  withTitle?: boolean;
  inRow?: boolean;
}) {
  const card = useStore((s) =>
    s.project ? s.records[s.project]?.cards.find((c) => c.id === cardId) : undefined,
  );
  if (!card) return <>{cardId}</>;
  return (
    <button
      {...chipProps(inRow, () => openCard(card.id))}
      title={`${card.id} ${card.title}`}
      data-testid="card-chip"
      data-id={card.id}
    >
      <StatusIcon status={card.status} size={11} />
      <span className="min-w-0 truncate whitespace-nowrap font-medium tabular-nums">{card.id}</span>
      {withTitle && <span className="truncate text-fg-3">{cardTitle(card)}</span>}
    </button>
  );
}

export function ConclusionChip({ id, inRow }: { id: string; inRow?: boolean }) {
  const c = useStore((s) =>
    s.project ? s.records[s.project]?.conclusions.find((x) => x.id === id) : undefined,
  );
  if (!c) return <>{id}</>;
  return (
    <button
      {...chipProps(inRow, () => openConclusion(c.id))}
      title={`${c.id} ${c.what}`}
      data-testid="conclusion-chip"
      data-id={c.id}
    >
      <span
        className={cx("font-mono text-meta", c.superseded ? "text-fg-4 line-through" : "text-fg-2")}
      >
        {c.id}
      </span>
    </button>
  );
}

const ARTIFACT_ICON: Record<ArtifactView["type"], IconName> = {
  file: "file",
  branch: "branch",
  pr: "pr",
  link: "external",
};

export function FileChip({ artifact, project }: { artifact: ArtifactView; project: ProjectId }) {
  return (
    <button
      {...chipProps(false, () => void openArtifact(project, artifact))}
      title={artifact.ref}
      data-testid="file-chip"
    >
      <Icon name={ARTIFACT_ICON[artifact.type]} size={10} faint />
      <span className="min-w-0 truncate">{artifactName(artifact)}</span>
    </button>
  );
}
