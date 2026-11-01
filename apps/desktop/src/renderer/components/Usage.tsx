import {
  formatMoney,
  formatRelativeTime,
  headlineLimit,
  type LimitSeverity,
  resetWords,
  type UsageLimits,
  usageModeOf,
} from "@grove/core/pure";
import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useState } from "react";
import type { UsageView } from "../../shared/ipc.ts";
import {
  type Bar,
  formatChange,
  formatShare,
  formatTime,
  formatValue,
  type ListRow,
  METRIC_WORDS,
  METRICS,
  type Metric,
  RANGES,
  type Range,
  type UsageModel,
  usageModel,
} from "../logic/usage.ts";
import { useStore } from "../state/store.ts";
import { cx, LimitBar, Segmented, SliceFill, SliceMark, StatTile } from "./ui.tsx";

/** main is asked again at most this often, however fast the sessions move */
const ASK_EVERY_MS = 3000;

/**
 * main's view, asked for while this screen is open on the API-equivalent and never otherwise: when
 * it opens, when the sessions move, and every half minute for the agents that are working. the
 * first count after an upgrade reads every transcript, so until it is through it is asked for
 * again and again
 */
function useUsage(enabled: boolean): UsageView | null {
  const [view, setView] = useState<UsageView | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let open = true;
    let asked = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      timer ??= setTimeout(ask, Math.max(0, ASK_EVERY_MS - (Date.now() - asked)));
    };
    const ask = async () => {
      timer = undefined;
      asked = Date.now();
      // main did not answer: what is on screen stays
      const next = await window.grove.usage().catch(() => null);
      if (!open || !next) return;
      setView(next);
      if (next.counted < next.total) soon();
    };
    void ask();
    const off = window.grove.on("sessions:changed", soon);
    const tick = setInterval(soon, 30_000);
    return () => {
      open = false;
      off();
      clearInterval(tick);
      clearTimeout(timer);
    };
  }, [enabled]);
  return view;
}

const sliceName = (m: UsageModel, key: string): string =>
  m.byProject.find((r) => r.key === key)?.name ?? key;

/** what a bar says when it is pointed at or has the keyboard: the period, its total, its split */
function BarTip({
  bar,
  model,
  metric,
  side,
}: {
  bar: Bar;
  model: UsageModel;
  metric: Metric;
  /** which side of its bar it sits on, so it never leaves the plot */
  side: CSSProperties;
}) {
  return (
    <div
      role="status"
      data-testid="bar-tip"
      className="overlay-shadow pointer-events-none absolute top-0 z-10 w-max max-w-[260px] min-w-[150px] rounded-md bg-overlay px-3 py-2"
      style={side}
    >
      <div className="text-meta text-fg-3">{bar.label}</div>
      <div className="font-semibold tabular-nums text-fg">
        {bar.total > 0 ? formatValue(bar.total, metric) : "No usage"}
      </div>
      {bar.segments.length > 1 && (
        <div className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
          {/* the bar from its top down */}
          {[...bar.segments].reverse().map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-sm">
              <SliceMark slice={s.slice} />
              <span className="min-w-0 flex-1 truncate text-fg-3">{sliceName(model, s.key)}</span>
              <span className="tabular-nums text-fg">{formatValue(s.value, metric)}</span>
            </div>
          ))}
        </div>
      )}
      {bar.segments.length === 1 && bar.segments[0] && (
        <div className="mt-0.5 flex items-center gap-2 text-sm text-fg-3">
          <SliceMark slice={bar.segments[0].slice} />
          <span className="truncate">{sliceName(model, bar.segments[0].key)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * the bars of the range, stacked by project. one stop for Tab, and the arrows walk the bars: a
 * bar the keyboard is on says what a pointed-at one does. the same numbers are a table for a
 * screen reader. every bar is keyed from the right, so today's is the same element in every
 * range and a new range moves the bars it shares with the last one instead of drawing them again
 */
function Chart({ model, metric, range }: { model: UsageModel; metric: Metric; range: Range }) {
  const [hot, setHot] = useState<number | null>(null);
  const { bars, ticks, stack } = model;
  const top = ticks.at(-1)?.value ?? 0;
  const at = hot !== null && hot < bars.length ? hot : null;
  const active = at !== null ? bars[at] : undefined;

  const onKey = (e: KeyboardEvent) => {
    const last = bars.length - 1;
    const to = {
      ArrowLeft: Math.max(0, (at ?? bars.length) - 1),
      ArrowRight: Math.min(last, (at ?? -1) + 1),
      Home: 0,
      End: last,
    }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      setHot(to);
    } else if (e.key === "Escape" && at !== null) {
      e.stopPropagation();
      setHot(null);
    }
  };

  return (
    <figure className="mt-6" data-testid="usage-chart" data-range={range} data-metric={metric}>
      <div className="flex">
        {/* the values of the lines, at the left */}
        <div className="relative w-14 shrink-0" aria-hidden="true">
          {ticks.map((t, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a line is its place on the axis
              key={i}
              className="grid-line absolute right-2 translate-y-1/2 text-meta tabular-nums text-fg-4"
              style={{ bottom: `${top > 0 ? (t.value / top) * 100 : 0}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div
          role="group"
          aria-label={`${METRIC_WORDS[metric].label} per ${range === "1Y" ? "week" : "day"}. Left and right arrows read each bar.`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: one stop for the whole chart, the arrows walk its bars
          tabIndex={0}
          className="relative h-[220px] min-w-0 flex-1 rounded-sm"
          data-testid="usage-plot"
          data-plot
          // the others step back from a bar that has something. an empty day has nothing to lead
          data-hot={(active && active.total > 0) || undefined}
          onKeyDown={onKey}
          // the keyboard arrives on today's bar: an active bar says where it is, like a list's row
          onFocus={() => setHot((h) => h ?? bars.length - 1)}
          onBlur={() => setHot(null)}
          onPointerLeave={() => setHot(null)}
        >
          {ticks.map((t, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a line is its place on the axis
              key={i}
              className={cx(
                "grid-line absolute inset-x-0 border-t",
                i === 0 ? "border-line-strong" : "border-line",
              )}
              style={{ bottom: `${top > 0 ? (t.value / top) * 100 : 0}%` }}
            />
          ))}
          <div className="absolute inset-0 flex">
            {bars.map((bar, i) => {
              const values = new Map(bar.segments.map((s) => [s.key, s.value]));
              const cap = bar.segments.at(-1)?.key;
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: counted from today, so a bar is the same element in every range
                  key={bars.length - 1 - i}
                  className="bar flex h-full min-w-0 flex-1 flex-col-reverse items-center"
                  data-testid="usage-bar"
                  data-on={at === i || undefined}
                  data-total={bar.total}
                  onPointerEnter={() => setHot(i)}
                >
                  {/* every bar draws every slice, so a part that empties shrinks to nothing in place */}
                  {stack.map(({ key, slice }) => {
                    const value = values.get(key) ?? 0;
                    return (
                      <SliceFill
                        key={key}
                        slice={slice}
                        // never wider than 24px, and the rest of its slot is air
                        className={cx(
                          "bar-part w-[62%] max-w-[24px] shrink-0",
                          // a 2px gap of the ground between two parts, and the top one's corners
                          value > 0 && key !== bar.segments[0]?.key && "border-b-2 border-canvas",
                          value > 0 && "min-h-[3px]",
                          key === cap && "rounded-t-sm",
                        )}
                        style={{ "--h": `${top > 0 ? (value / top) * 100 : 0}%` } as CSSProperties}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
          {active && at !== null && (
            <BarTip
              bar={active}
              model={model}
              metric={metric}
              side={
                at < bars.length / 2
                  ? { left: `calc(${((at + 1) / bars.length) * 100}% + 4px)` }
                  : { right: `calc(${((bars.length - at) / bars.length) * 100}% + 4px)` }
              }
            />
          )}
        </div>
      </div>
      {/* a few of the bars are named, so no two labels meet */}
      <div className="ml-14 flex pt-1.5" aria-hidden="true">
        {bars.map((bar, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: counted from today, like the bar over it
            key={bars.length - 1 - i}
            // the last label ends with the plot: a date is wider than a day's bar
            className={cx(
              "flex h-4 min-w-0 flex-1",
              i === bars.length - 1 && bars.length > 7 ? "justify-end" : "justify-center",
            )}
          >
            <span className="whitespace-nowrap text-meta text-fg-4">{bar.tick}</span>
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>
          {METRIC_WORDS[metric].label} per {range === "1Y" ? "week" : "day"}
        </caption>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.label}>
              <th scope="row">{bar.label}</th>
              <td>{formatValue(bar.total, metric)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

const LIST_BAR = "h-1.5 rounded-full transition-[width] duration-200 motion-reduce:transition-none";

/** a short list for the range and the metric: a name, a thin bar and the value, biggest first */
function Breakdown({
  title,
  rows,
  metric,
  testId,
}: {
  title: string;
  rows: ListRow[];
  metric: Metric;
  testId: string;
}) {
  return (
    <section className="min-w-0 flex-1" data-testid={testId}>
      <h2 className="mb-2 text-sm font-medium text-fg-3">{title}</h2>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2" data-testid="usage-row">
            {r.slice && <SliceMark slice={r.slice} />}
            <span className="w-[38%] min-w-0 shrink-0 truncate text-fg-2" title={r.name}>
              {r.name}
            </span>
            <span className="flex h-1.5 min-w-0 flex-1 items-center">
              {r.slice ? (
                <SliceFill
                  slice={r.slice}
                  className={cx(LIST_BAR, "min-w-[2px]")}
                  style={{ width: `${r.share * 100}%` }}
                />
              ) : (
                // a model has no colour of its own
                <span
                  className={cx(LIST_BAR, "min-w-[2px] bg-fg-4")}
                  style={{ width: `${r.share * 100}%` }}
                />
              )}
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums text-fg-2">
              {formatValue(r.value, metric)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Extra({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5 whitespace-nowrap" title={hint}>
      <dt className="text-fg-4">{label}</dt>
      <dd className="tabular-nums text-fg-2" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/** rounded down, as Claude Code's /usage says it: 99.6 is not yet 100 */
const percentWords = (p: number): string => `${Math.floor(p)}%`;
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** one limit: what it is, how much of it is used as a number and as a bar, and when it starts over */
function LimitCard({
  label,
  value,
  of,
  percent,
  severity,
  note,
  reset,
  testId,
}: {
  label: string;
  value: string;
  /** beside the value: what it is out of */
  of?: string;
  /** 0 to 100. null: no limit, and no bar */
  percent: number | null;
  severity: LimitSeverity;
  note?: string;
  /** the window started over since the fetch: its number is from before, so it is quiet and has no bar */
  reset?: boolean;
  testId: string;
}) {
  return (
    <div
      className="min-w-0 rounded-lg border border-line px-4 pt-3 pb-3.5"
      data-testid={testId}
      data-reset={reset || undefined}
    >
      <div className="truncate text-sm font-medium text-fg-3">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        {/* proportional figures, as a stat tile's */}
        <span
          className={cx("truncate text-figure font-semibold", reset ? "text-fg-4" : "text-fg")}
          data-testid="limit-value"
        >
          {value}
        </span>
        {of && <span className="shrink-0 text-sm tabular-nums text-fg-4">{of}</span>}
      </div>
      {percent !== null && !reset && (
        <LimitBar
          className="mt-2.5"
          percent={percent}
          severity={severity}
          label={of ? `${label}: ${value} ${of}` : `${label}: ${value}`}
        />
      )}
      <div
        className="mt-1.5 h-[18px] truncate text-sm tabular-nums text-fg-4"
        data-testid="limit-note"
      >
        {note}
      </div>
    </div>
  );
}

/**
 * the cost tile in account mode: what the account spent or how much of its limit is used, as Claude
 * Code last fetched it. a metered account has a monthly cap; a plan has windows, and the tighter open
 * one is shown with when it starts over. nothing fetched yet: a dash and where to get the numbers
 */
function accountCost(
  limits: UsageLimits | null,
  now: number,
): Omit<Parameters<typeof StatTile>[0], "selected" | "onSelect" | "testId"> {
  const head = headlineLimit(limits, now);
  const spend = limits?.spend;
  const age = limits ? `updated ${formatRelativeTime(limits.fetchedAt, now)}` : "";
  if (!limits || !head) {
    return {
      label: "Cost",
      value: "-",
      note: "Run /usage in Claude Code",
      hint: "Claude Code has not fetched your account's limits yet",
    };
  }
  if (spend && limits.kind === "metered") {
    return {
      label: "Spend this month",
      value: formatMoney(spend.used, spend.currency, spend.digits),
      note: [
        spend.limit === null
          ? "no limit"
          : `of ${formatMoney(spend.limit, spend.currency, spend.digits)} · ${percentWords(head.percent)}`,
        age,
      ]
        .filter(Boolean)
        .join(" · "),
      hint: `Your account's spend, as Claude Code last fetched it (${age})`,
      footer:
        spend.percent === null || spend.limit === null ? undefined : (
          <LimitBar
            className="mt-2.5"
            percent={spend.percent}
            severity={spend.severity}
            label={`Spend: ${formatMoney(spend.used, spend.currency, spend.digits)} of ${formatMoney(spend.limit, spend.currency, spend.digits)}`}
          />
        ),
    };
  }
  return {
    label: "Plan usage",
    value: percentWords(head.percent),
    note: [head.resetsAt === null ? head.label : resetWords(head.resetsAt, now), age]
      .filter(Boolean)
      .join(" · "),
    hint: `${head.label} as Claude Code last fetched it (${age})`,
    footer: (
      <LimitBar
        className="mt-2.5"
        percent={head.percent}
        severity={limits.windows.find((w) => w.label === head.label)?.severity ?? "normal"}
        label={`${head.label}: ${percentWords(head.percent)} used`}
      />
    ),
  };
}

/**
 * what the machine's agents used: three numbers for a range, and the one picked drawn as bars by
 * project. every transcript Claude Code has kept counts, and so does every one it has deleted
 * since grove first read it. nothing of that is shown anywhere else in the app. or, with Actual
 * picked, the account's own limits and what is used of them, which the menu bar says too
 */
export function Usage() {
  const projects = useStore((s) => s.projects);
  const limits = useStore((s) => s.limits);
  const saved = useStore((s) => s.settings?.usageMode);
  const mode = usageModeOf(saved, limits);
  // the transcripts are read in both modes: only the cost panel above the tiles changes with the toggle
  const view = useUsage(true);
  // the range ends today: a new day is a new last bar
  const today = useStore((s) => new Date(s.now).toDateString());
  const now = useStore((s) => s.now);
  const [range, setRange] = useState<Range>("1W");
  const [metric, setMetric] = useState<Metric>("cost");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `today` is when to count the days again
  const model = useMemo(
    () => view && usageModel(view, range, metric, projects, Date.now()),
    [view, range, metric, projects, today],
  );

  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]" data-testid="usage">
      <div className="mx-auto max-w-[920px] px-6 pt-8 pb-16">
        <div className="flex items-center gap-3">
          <h1 className="text-title font-semibold">Usage</h1>
          <button
            type="button"
            className="no-drag text-sm text-fg-3 hover:text-fg"
            onClick={() => useStore.getState().set({ dialog: { kind: "settings" } })}
            data-testid="usage-mode-change"
          >
            {mode === "actual" ? "Account limits and spend" : "API-equivalent cost"} · change in
            Settings
          </button>
          {view && view.counted < view.total && (
            <span className="text-sm tabular-nums text-fg-4" data-testid="usage-counting">
              Counting {view.counted} of {view.total} sessions
            </span>
          )}
          <span className="ml-auto" />
          <Segmented
            label="Range"
            size="sm"
            value={range}
            onChange={setRange}
            options={RANGES.map((r) => ({ value: r, label: r, testId: `range-${r}` }))}
          />
        </div>
        {mode === "actual" && limits && limits.windows.length > 0 && (
          <div className="mt-3 grid gap-3 min-[700px]:grid-cols-2" data-testid="actual">
            {limits.windows.map((w) => (
              <LimitCard
                key={w.key}
                testId={`limit-${w.key}`}
                label={w.label}
                value={percentWords(w.percent)}
                percent={w.percent}
                severity={w.severity}
                note={w.resetsAt === null ? undefined : capital(resetWords(w.resetsAt, now))}
                // the menu bar leaves such a window out too
                reset={w.resetsAt !== null && w.resetsAt <= now}
              />
            ))}
          </div>
        )}
        {model && (
          <>
            <div role="radiogroup" aria-label="What the chart measures" className="mt-5 flex gap-3">
              {METRICS.map((m) => {
                const tile = model.tiles[m];
                // the cost tile is the account's own numbers in account mode, and the rest stay the same
                const account = mode === "actual" && m === "cost" ? accountCost(limits, now) : null;
                return (
                  <StatTile
                    key={m}
                    label={account?.label ?? METRIC_WORDS[m].label}
                    hint={account?.hint ?? METRIC_WORDS[m].hint}
                    value={account?.value ?? formatValue(tile.total, m)}
                    note={
                      account
                        ? account.note
                        : tile.change === undefined
                          ? undefined
                          : `${formatChange(tile.change)} vs ${model.before}`
                    }
                    footer={account?.footer}
                    selected={m === metric}
                    onSelect={() => setMetric(m)}
                    testId={`tile-${m}`}
                  />
                );
              })}
            </div>
            {model.unpriced > 0 && (
              <p className="mt-2 text-sm text-fg-4" data-testid="usage-unpriced">
                {formatValue(model.unpriced, "tokens")} tokens on models with no known price are not
                in the cost.
              </p>
            )}
            {model.empty ? (
              <p
                className="mt-6 flex h-[242px] items-center justify-center text-fg-4"
                data-testid="usage-empty"
              >
                No usage in this range
              </p>
            ) : (
              <>
                <Chart model={model} metric={metric} range={range} />
                <div className="mt-8 flex flex-col gap-8 min-[1000px]:flex-row min-[1000px]:gap-10">
                  <Breakdown
                    title="By project"
                    rows={model.byProject}
                    metric={metric}
                    testId="by-project"
                  />
                  <Breakdown
                    title="By model"
                    rows={model.byModel}
                    metric={metric}
                    testId="by-model"
                  />
                </div>
                <dl
                  className="mt-8 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-4 text-sm"
                  data-testid="usage-extras"
                >
                  <Extra
                    testId="extra-sessions"
                    label="Sessions"
                    value={String(model.extras.sessions)}
                  />
                  <Extra
                    testId="extra-subagents"
                    label="Subagents"
                    value={String(model.extras.subagents)}
                  />
                  <Extra
                    testId="extra-cache"
                    label="Cache hit rate"
                    value={
                      model.extras.cacheHit === null ? "-" : formatShare(model.extras.cacheHit)
                    }
                    hint="Cache read tokens over every input token"
                  />
                  <Extra
                    testId="extra-peak"
                    label="Peak agents at once"
                    value={String(model.extras.peak)}
                    hint={
                      model.extras.peakDay
                        ? `The most agents working within the same five minutes, subagents counted: ${model.extras.peakDay}`
                        : undefined
                    }
                  />
                  <Extra
                    testId="extra-longest"
                    label="Longest run"
                    value={model.extras.longest > 0 ? formatTime(model.extras.longest) : "-"}
                    hint="The longest single turn: from one of your prompts to the last thing the agent did before your next, as working time"
                  />
                </dl>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
