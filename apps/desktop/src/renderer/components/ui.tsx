import { highlightRanges } from "@grove/core/pure";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type IconName =
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
}: {
  name: IconName;
  size?: number;
  className?: string;
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
      className={cx("shrink-0", className)}
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
    <kbd className="rounded-sm border border-line-strong px-1 font-sans text-meta text-fg-3">
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
