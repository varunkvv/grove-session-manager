import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type DayRange,
  dayRange,
  FAMILY_WORD,
  type OutputGlyphKind,
  rangeLabel,
  SHORTCUTS,
  type Shortcut,
  shortcutRange,
  startOfDay,
} from "../logic/outputs.ts";
import { CheckBox, cx, Icon, OutputGlyph } from "./ui.tsx";

const buttonClass = (on: boolean) =>
  cx(
    "fade flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm",
    on
      ? "border-line-strong bg-raised text-fg"
      : "border-line text-fg-3 hover:border-line-strong hover:text-fg",
  );

/** a button and the popover under it: Esc or a click outside closes it */
function Dropdown({
  label,
  testId,
  button,
  after,
  on,
  children,
}: {
  label: string;
  testId: string;
  /** what the button says */
  button: ReactNode;
  /** beside the button, outside its click: the chips of what is picked */
  after?: ReactNode;
  on: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={box} className="no-drag relative flex items-center gap-1.5">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        data-testid={testId}
        onClick={() => setOpen(!open)}
        className={buttonClass(on || open)}
      >
        {button}
        <Icon name="chevron" size={9} className={open ? "-rotate-90" : "rotate-90"} faint />
      </button>
      {after}
      {open && (
        <div
          role="dialog"
          aria-label={label}
          data-testid={`${testId}-popover`}
          className="absolute top-full left-0 z-30 mt-1.5 rounded-lg border border-line-strong bg-overlay overlay-shadow"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function SelectedChips({
  names,
  onRemove,
}: {
  names: Array<{ key: string; name: string }>;
  onRemove: (key: string) => void;
}) {
  const more = names.length - 2;
  return (
    <>
      {names.slice(0, 2).map((n) => (
        <span
          key={n.key}
          data-testid="outputs-chip"
          className="flex h-6 max-w-32 items-center gap-1 rounded-md bg-raised pr-1 pl-2 text-sm text-fg-2"
        >
          <span className="truncate">{n.name}</span>
          <button
            type="button"
            aria-label={`Remove ${n.name}`}
            onClick={() => onRemove(n.key)}
            className="fade flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-4 hover:text-fg"
          >
            <Icon name="x" size={9} />
          </button>
        </span>
      ))}
      {more > 0 && <span className="text-sm text-fg-4">+{more}</span>}
    </>
  );
}

interface Option {
  key: string;
  name: string;
  n: number;
  mark?: ReactNode;
}

/** a multi-select: rows with a box and a count that stay open as they are toggled */
function MultiSelect({
  label,
  testId,
  options,
  picked,
  onChange,
}: {
  label: string;
  testId: string;
  options: Option[];
  picked: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (k: string) =>
    onChange(picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k]);
  return (
    <Dropdown
      label={label}
      testId={testId}
      on={picked.length > 0}
      button={
        <>
          {label}
          {picked.length > 0 && <span className="text-fg-4 tabular-nums">{picked.length}</span>}
        </>
      }
      after={
        <SelectedChips
          names={picked.map((k) => ({ key: k, name: options.find((o) => o.key === k)?.name ?? k }))}
          onRemove={toggle}
        />
      }
    >
      {() => (
        <div className="w-60 p-1">
          <div className="max-h-72 overflow-y-auto">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={picked.includes(o.key)}
                data-testid={`${testId}-${o.key}`}
                onClick={() => toggle(o.key)}
                className="fade flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-raised"
              >
                <CheckBox checked={picked.includes(o.key)} />
                {o.mark && (
                  <span className="flex h-5 shrink-0 items-center text-fg-3">{o.mark}</span>
                )}
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                <span className="text-sm text-fg-4 tabular-nums">{o.n}</span>
              </button>
            ))}
          </div>
          {picked.length > 0 && (
            <div className="mt-1 border-t border-line px-1 pt-1">
              <button
                type="button"
                data-testid={`${testId}-clear`}
                onClick={() => onChange([])}
                className="fade h-7 rounded-md px-2 text-sm text-fg-3 hover:bg-raised hover:text-fg"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </Dropdown>
  );
}

const WEEK = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

/** a month's days as local day starts */
const monthDays = (year: number, month: number): number[] =>
  Array.from({ length: new Date(year, month + 1, 0).getDate() }, (_, i) =>
    new Date(year, month, i + 1).getTime(),
  );

function WhenPicker({
  range,
  now,
  onChange,
  close,
}: {
  range: DayRange;
  now: number;
  onChange: (r: DayRange) => void;
  close: () => void;
}) {
  const start = new Date(range.from ?? now);
  const [view, setView] = useState({ y: start.getFullYear(), m: start.getMonth() });
  // the first click of a pair, waiting for its second
  const [pending, setPending] = useState<number | undefined>();
  const move = (by: number) => {
    const d = new Date(view.y, view.m + by, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };
  const click = (day: number) => {
    onChange(dayRange(pending ?? day, day));
    setPending(pending === undefined ? day : undefined);
  };
  const pick = (name: Shortcut) => {
    onChange(shortcutRange(name, now));
    close();
  };
  const set = range.from !== undefined && range.to !== undefined;
  return (
    <div className="flex">
      <div
        className="flex w-36 flex-col border-r border-line p-1"
        role="group"
        aria-label="Shortcuts"
      >
        {SHORTCUTS.map((s) => {
          const r = shortcutRange(s.value, now);
          const on = r.from === range.from && r.to === range.to;
          return (
            <button
              key={s.value}
              type="button"
              data-testid={`outputs-when-${s.value}`}
              aria-pressed={on}
              onClick={() => pick(s.value)}
              className={cx(
                "fade h-8 rounded-md px-2 text-left text-body hover:bg-raised",
                on ? "bg-raised text-fg" : "text-fg-2",
              )}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      <div className="w-[17.5rem] p-2">
        <div className="flex items-center justify-between pb-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => move(-1)}
            className="fade flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-raised hover:text-fg"
          >
            <Icon name="chevron" size={10} className="rotate-180" />
          </button>
          <span className="text-body font-medium text-fg" aria-live="polite">
            {MONTH.format(new Date(view.y, view.m, 1))}
          </span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => move(1)}
            className="fade flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-raised hover:text-fg"
          >
            <Icon name="chevron" size={10} />
          </button>
        </div>
        <div className="grid grid-cols-7 text-center text-sm text-fg-4">
          {WEEK.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: seven fixed columns, two of them T and two S
            <span key={i} className="flex h-7 items-center justify-center">
              {w}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5" data-testid="outputs-days">
          {monthDays(view.y, view.m).map((day) => {
            const inside = set && day >= (range.from ?? 0) && day <= (range.to ?? 0);
            const end = set && (day === range.from || day === startOfDay(range.to ?? 0));
            return (
              <button
                key={day}
                type="button"
                data-testid="outputs-day"
                data-day={day}
                // the 1st sits under its weekday, the blanks before it are the grid's
                style={
                  new Date(day).getDate() === 1
                    ? { gridColumnStart: new Date(day).getDay() + 1 }
                    : undefined
                }
                aria-pressed={inside}
                aria-label={new Date(day).toDateString()}
                onClick={() => click(day)}
                className={cx(
                  "fade h-8 rounded-md text-sm tabular-nums",
                  end
                    ? "bg-active font-semibold text-fg outline outline-1 outline-line-strong"
                    : inside
                      ? "bg-raised text-fg"
                      : cx("hover:bg-raised", set ? "text-fg-4" : "text-fg"),
                  day === startOfDay(now) && "font-semibold",
                )}
              >
                {new Date(day).getDate()}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export interface OutputFiltersProps {
  projects: Array<{ name: string; n: number }>;
  families: Array<{ glyph: OutputGlyphKind; n: number }>;
  picked: { projects: readonly string[]; kinds: readonly OutputGlyphKind[] };
  range: DayRange;
  now: number;
  onProjects: (next: string[]) => void;
  onKinds: (next: OutputGlyphKind[]) => void;
  onRange: (r: DayRange) => void;
}

/** the Outputs screen's bar: Project and Kind multi-selects and a date range. one line, wraps when narrow */
export function OutputFilters(p: OutputFiltersProps) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="outputs-filters">
      {p.projects.length > 1 && (
        <MultiSelect
          label="Project"
          testId="outputs-project"
          options={p.projects.map((x) => ({ key: x.name, name: x.name, n: x.n }))}
          picked={p.picked.projects}
          onChange={p.onProjects}
        />
      )}
      {p.families.length > 1 && (
        <MultiSelect
          label="Kind"
          testId="outputs-kind"
          options={p.families.map((f) => ({
            key: f.glyph,
            name: FAMILY_WORD[f.glyph],
            n: f.n,
            mark: <OutputGlyph kind={f.glyph} />,
          }))}
          picked={p.picked.kinds}
          onChange={(next) => p.onKinds(next as OutputGlyphKind[])}
        />
      )}
      <Dropdown
        label="When"
        testId="outputs-when"
        on={p.range.from !== undefined}
        button={rangeLabel(p.range)}
      >
        {(close) => <WhenPicker range={p.range} now={p.now} onChange={p.onRange} close={close} />}
      </Dropdown>
    </div>
  );
}
