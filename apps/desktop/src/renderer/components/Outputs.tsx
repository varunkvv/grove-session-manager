import { type FailingCheck, formatRelativeTime, prDetail } from "@grove/core/pure";
import { type ReactNode, useEffect, useState } from "react";
import type { OutputView, PrView } from "../../shared/ipc.ts";
import { cap, glyphOf, lookOf, type Section, sectionsOf, shortRepo } from "../logic/outputs.ts";
import { useTick } from "./Live.tsx";
import { cx, Icon, IconButton, OutputGlyph, PrGlyph } from "./ui.tsx";

const open = (url: string) => void window.grove.openExternal(url);

/** a failing PR's failed checks, asked for when it shows, again when its rollup moves */
function useFailingChecks(p: PrView): FailingCheck[] | undefined {
  const [checks, setChecks] = useState<FailingCheck[]>();
  const failing = p.state === "failing" && (p.rollup === "FAILURE" || p.rollup === "ERROR");
  // the rollup moving means other checks: it asks again. main keeps them by it
  // biome-ignore lint/correctness/useExhaustiveDependencies: p.rollup is the cache's key in main
  useEffect(() => {
    setChecks(undefined);
    if (!failing) return;
    let live = true;
    void window.grove.prChecks(p.url).then((c) => {
      if (live) setChecks(c);
    });
    return () => {
      live = false;
    };
  }, [p.url, p.rollup, failing]);
  return checks;
}

const KEY_TONE = { made: "text-fg-2", other: "text-fg-3", inherited: "text-fg-4" } as const;
const TITLE_TONE = { made: "text-fg", other: "text-fg-3", inherited: "text-fg-4" } as const;

/** a card row opens its url. a link with links inside it cannot be an <a> */
function CardLink({
  url,
  testId,
  state,
  children,
}: {
  url: string | undefined;
  testId: string;
  state?: string | undefined;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a link with links inside it cannot be an <a>
    <div
      role={url ? "link" : undefined}
      tabIndex={url ? 0 : undefined}
      data-testid={testId}
      data-state={state}
      title={url}
      onClick={() => url && open(url)}
      onKeyDown={(e) => {
        if (url && e.key === "Enter") open(url);
      }}
      className={cx("-mx-2 rounded-md px-2 py-1.5", url && "fade cursor-pointer hover:bg-raised")}
    >
      {children}
    </div>
  );
}

function PrRow({ p, now, tone }: { p: PrView; now: number; tone: Section["tone"] }) {
  const checks = useFailingChecks(p);
  const ago = (at: number) => formatRelativeTime(at, now);
  const d =
    p.state &&
    prDetail(
      {
        title: p.title ?? "",
        state: p.state,
        ...(p.review ? { review: p.review } : {}),
        ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
      },
      checks,
      ago,
    );
  return (
    <CardLink url={p.url} testId="card-pr" state={p.state}>
      <div className="flex min-w-0 items-center gap-1.5">
        <PrGlyph look={lookOf(p)} />
        <span className={cx("shrink-0 tabular-nums", KEY_TONE[tone])}>
          {shortRepo(p.repo)} #{p.number}
        </span>
        {p.title && <span className={cx("min-w-0 truncate", TITLE_TONE[tone])}>{p.title}</span>}
      </div>
      {d && (
        <p className="mt-0.5 text-sm text-fg-3">
          {d.words.join(" · ")}
          {d.checks.map((c, i) => (
            <span key={c.url ?? c.name}>
              {i === 0 ? " · " : ", "}
              {c.url ? (
                <button
                  type="button"
                  data-testid="card-pr-check"
                  className="fade text-danger hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (c.url) open(c.url);
                  }}
                >
                  {c.name}
                </button>
              ) : (
                <span className="text-danger">{c.name}</span>
              )}
            </span>
          ))}
          {d.more > 0 && ` +${d.more}`}
          {p.stale && p.checkedAt ? ` · as of ${ago(p.checkedAt)}` : d.updated && ` · ${d.updated}`}
        </p>
      )}
    </CardLink>
  );
}

/** anything but a PR: its key or title, then what was done, by whom, and when */
function OutputRow({ o, now, tone }: { o: OutputView; now: number; tone: Section["tone"] }) {
  const line = [o.verb, o.agent, formatRelativeTime(o.last, now)].filter(Boolean).join(" · ");
  return (
    <CardLink url={o.url} testId="card-output">
      <div className="flex min-w-0 items-center gap-1.5">
        <OutputGlyph kind={glyphOf(o.kind)} />
        {o.key ? (
          <>
            <span className={cx("shrink-0 tabular-nums", KEY_TONE[tone])}>{o.key}</span>
            {o.title && <span className={cx("min-w-0 truncate", TITLE_TONE[tone])}>{o.title}</span>}
          </>
        ) : (
          <span className={cx("min-w-0 truncate", TITLE_TONE[tone])}>
            {o.title ?? cap(o.label)}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-sm text-fg-3">{line}</p>
    </CardLink>
  );
}

/** an output list: by kind, made first, then updated and commented on, then a fork's copies */
export function OutputList({
  outputs,
  now,
}: {
  outputs: readonly OutputView[] | undefined;
  now: number;
}) {
  return sectionsOf(outputs).map((sec) => (
    <div key={`${sec.tone} ${sec.title}`} className="mt-1.5" data-tone={sec.tone}>
      <h4 className="text-meta text-fg-4">{sec.title}</h4>
      {sec.items.map((o, i) =>
        o.pr ? (
          <PrRow key={o.url} p={o.pr} now={now} tone={sec.tone} />
        ) : (
          <OutputRow key={o.url ?? `${o.key}${i}`} o={o} now={now} tone={sec.tone} />
        ),
      )}
    </div>
  ));
}

/** the session card's Outputs */
export function OutputSection({
  outputs,
  now,
}: {
  outputs: readonly OutputView[] | undefined;
  now: number;
}) {
  if (!outputs?.length) return null;
  return (
    <div data-testid="card-outputs">
      <h3 className="text-sm font-medium text-fg-4">Outputs</h3>
      <OutputList outputs={outputs} now={now} />
    </div>
  );
}

/** the chat's Outputs pane: the same list the session card has */
export function OutputsPane({
  outputs,
  onClose,
}: {
  outputs: readonly OutputView[] | undefined;
  onClose: () => void;
}) {
  const now = useTick(false);
  return (
    <section
      className="flex min-h-0 w-80 shrink-0 flex-col border-l border-line bg-chrome"
      data-testid="outputs-pane"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="flex-1 font-medium text-fg">Outputs</h2>
        <IconButton label="Close" onClick={onClose} data-testid="outputs-pane-close">
          <Icon name="x" size={12} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        <OutputList outputs={outputs} now={now} />
      </div>
    </section>
  );
}
