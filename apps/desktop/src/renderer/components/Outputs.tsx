import {
  type FailingCheck,
  formatRelativeTime,
  PR_STATE_WORD,
  type PrCheck,
  type PrInfo,
  type PrReviewer,
  prDetail,
} from "@grove/core/pure";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { OutputView, PrView } from "../../shared/ipc.ts";
import {
  cap,
  detailOf,
  glyphOf,
  lookOf,
  type Mark,
  markOf,
  ordered,
  type Section,
  sectionsOf,
  shortKey,
  shortRepo,
} from "../logic/outputs.ts";
import { useTick } from "./Live.tsx";
import {
  Button,
  CheckDot,
  cx,
  Icon,
  IconButton,
  Menu,
  type MenuItem,
  OutputGlyph,
  PrGlyph,
  PrWords,
  Spinner,
} from "./ui.tsx";

const open = (url: string) => void window.grove.openExternal(url);
const stop = (e: MouseEvent) => e.stopPropagation();

/** the menu's rows: what it made, then what it only updated or commented on, below a line, dimmed */
function menuItems(m: Mark): MenuItem[] {
  const item = (o: OutputView, i: number, dim: boolean, divider: boolean): MenuItem => ({
    key: String(i),
    label: `${shortKey(o)}${o.title ? ` ${o.title}` : ""}`,
    description: detailOf(o),
    mark: <OutputGlyph kind={glyphOf(o.kind)} {...(o.pr ? { look: lookOf(o.pr) } : {})} />,
    ...(dim ? { dim, divider } : {}),
  });
  return [
    ...m.made.map((o, i) => item(o, i, false, false)),
    ...m.other.map((o, i) => item(o, m.made.length + i, true, i === 0 && m.made.length > 0)),
  ];
}

/**
 * a row's outputs: the glyph and the key of the one, or the glyph of the latest it made and a
 * count. one opens its url, several open a menu of them. `label` hides the words as the list
 * narrows. a fork's copies never count
 */
export function OutputMark({
  outputs,
  label,
  className,
  onOpenPr,
  pressed,
}: {
  outputs: readonly OutputView[] | undefined;
  /** classes for the words beside the glyph */
  label?: string;
  className?: string;
  /** given: a click on a PR is this (the chat's PR pane), not github */
  onOpenPr?: () => void;
  /** its pane is open */
  pressed?: boolean;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const m = markOf(outputs);
  if (!m) return null;
  const list = [...m.made, ...m.other];
  const go = (o: OutputView) => {
    if (o.pr && onOpenPr) onOpenPr();
    else if (o.url) open(o.url);
  };
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        title={list
          .map((o) => [o.key ?? cap(o.label), o.title, o.verb].filter(Boolean).join(" · "))
          .join("\n")}
        data-testid="output-mark"
        data-glyph={m.glyph}
        data-state={m.single?.pr?.state ?? (m.single ? "one" : "several")}
        {...(onOpenPr ? { "aria-pressed": !!pressed } : {})}
        className={cx(
          "no-drag fade -mr-1 inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-sm tabular-nums hover:bg-active hover:text-fg",
          m.look?.done ? "text-fg-4" : "text-fg-3",
          pressed && "bg-raised text-fg",
          className,
        )}
        onClick={(e) => {
          e.stopPropagation();
          if (m.single) go(m.single);
          else setAnchor(e.currentTarget.getBoundingClientRect());
        }}
      >
        <OutputGlyph kind={m.glyph} {...(m.look ? { look: m.look } : {})} />
        <span className={cx("truncate", label)}>{m.label}</span>
      </button>
      {anchor &&
        // a row is content-visibility: auto, which clips anything fixed inside it. and its click
        // opens the row: the menu's clicks stop here
        createPortal(
          // biome-ignore lint/a11y/noStaticElementInteractions: only stops the menu's clicks reaching the row
          // biome-ignore lint/a11y/useKeyWithClickEvents: the menu takes its own keys
          <div onClick={stop} onMouseMove={stop}>
            <Menu
              anchor={anchor}
              items={menuItems(m)}
              width={360}
              testId="output-menu"
              down={anchor.top < window.innerHeight / 2}
              onClose={() => setAnchor(null)}
              onPick={(i) => {
                setAnchor(null);
                const o = list[Number(i)];
                if (o) go(o);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

/** the row's right edge after the time: the glyph alone while the list is narrow */
export function OutputCell({ outputs }: { outputs: readonly OutputView[] | undefined }) {
  return (
    <span className="flex w-5 shrink-0 justify-end @xl:w-24" data-testid="session-output">
      <OutputMark outputs={outputs} label="hidden @xl:inline" />
    </span>
  );
}

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

/** the session card's Outputs: by kind, made first, then updated and commented on, then a fork's copies */
export function OutputSection({
  outputs,
  now,
}: {
  outputs: readonly OutputView[] | undefined;
  now: number;
}) {
  const sections = sectionsOf(outputs);
  if (!sections.length) return null;
  return (
    <div data-testid="card-outputs">
      <h3 className="text-sm font-medium text-fg-4">Outputs</h3>
      {sections.map((sec) => (
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
      ))}
    </div>
  );
}

const REVIEWER_WORD: Record<PrReviewer["state"], string> = {
  approved: "Approved",
  changes: "Changes requested",
  commented: "Commented",
  requested: "Requested",
};
const REVIEWER_TONE: Partial<Record<PrReviewer["state"], "green" | "red">> = {
  approved: "green",
  changes: "red",
};
const CHECK_TONE = { failing: "red", pending: "faint", passed: "green" } as const;
const CHECK_WORD: Record<PrCheck["group"], string> = {
  failing: "failing",
  pending: "running",
  passed: "passed",
};

/** at most this many passed checks show before "N more passed" */
const PASSED_SHOWN = 5;

/** all of one PR, asked for when it shows, when its rollup or github's update time moves, and when the window comes back */
function usePrInfo(p: PrView): PrInfo | null | undefined {
  const [info, setInfo] = useState<{ url: string; info: PrInfo | null }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a moved rollup or update time is a new ask
  useEffect(() => {
    let live = true;
    const ask = () =>
      void window.grove.prInfo(p.url).then((i) => {
        if (live) setInfo({ url: p.url, info: i });
      });
    ask();
    window.addEventListener("focus", ask);
    return () => {
      live = false;
      window.removeEventListener("focus", ask);
    };
  }, [p.url, p.rollup, p.updatedAt]);
  return info?.url === p.url ? info.info : undefined;
}

function Checks({ checks }: { checks: readonly PrCheck[] }) {
  const [allPassed, setAllPassed] = useState(false);
  if (!checks.length) return null;
  const count = (g: PrCheck["group"]) => checks.filter((c) => c.group === g).length;
  const words = (["failing", "pending", "passed"] as const)
    .filter((g) => count(g))
    .map((g) => `${count(g)} ${CHECK_WORD[g]}`);
  const passed = checks.filter((c) => c.group === "passed");
  const hidden = allPassed ? 0 : Math.max(0, passed.length - PASSED_SHOWN);
  const shown = hidden ? checks.slice(0, checks.length - hidden) : checks;
  return (
    <div data-testid="pr-pane-checks">
      <h3 className="flex items-baseline gap-2 text-sm font-medium text-fg-4">
        Checks <span className="font-normal">{words.join(", ")}</span>
      </h3>
      <ul className="mt-1">
        {shown.map((c) => (
          <li key={`${c.group}:${c.name}:${c.url ?? ""}`}>
            <button
              type="button"
              disabled={!c.url}
              data-testid="pr-pane-check"
              data-group={c.group}
              title={c.url ? `${c.name} on GitHub` : c.name}
              onClick={() => c.url && open(c.url)}
              className="fade -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left enabled:hover:bg-raised"
            >
              <CheckDot tone={CHECK_TONE[c.group]} />
              <span
                className={cx(
                  "min-w-0 flex-1 truncate",
                  c.group === "failing" ? "text-fg" : "text-fg-3",
                )}
              >
                {c.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          className="fade mt-0.5 text-sm text-fg-4 hover:text-fg"
          data-testid="pr-pane-more-checks"
          onClick={() => setAllPassed(true)}
        >
          {hidden} more passed
        </button>
      )}
    </div>
  );
}

/** one PR, in full: what it is, where it goes, how big, who reviews it, and its checks */
function PrFull({ p, onBack, onClose }: { p: PrView; onBack?: () => void; onClose: () => void }) {
  const info = usePrInfo(p);
  const now = useTick(false);
  const s = info ?? undefined;
  // the row's own until github answers
  const state = s?.state ?? p.state;
  const review = s?.review ?? p.review;
  const updatedAt = s?.updatedAt ?? p.updatedAt;
  const d =
    state &&
    prDetail(
      { title: "", state, ...(review ? { review } : {}), ...(updatedAt ? { updatedAt } : {}) },
      undefined,
      (at) => formatRelativeTime(at, now),
    );
  const done = state === "merged" || state === "closed";
  return (
    <section
      className="flex min-h-0 w-80 shrink-0 flex-col border-l border-line bg-chrome"
      data-testid="pr-pane"
      data-url={p.url}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-3">
        {onBack && (
          <IconButton label="All pull requests" onClick={onBack} data-testid="pr-pane-back">
            <Icon name="chevron" size={12} className="rotate-180" />
          </IconButton>
        )}
        <h2 className={cx("min-w-0 flex-1 truncate font-medium text-fg", !onBack && "pl-1")}>
          {shortRepo(p.repo)} #{p.number}
        </h2>
        <IconButton label="Open on GitHub" onClick={() => open(p.url)} data-testid="pr-pane-github">
          <Icon name="external" size={12} />
        </IconButton>
        <IconButton label="Close" onClick={onClose} data-testid="pr-pane-close">
          <Icon name="x" size={12} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <div>
          <div className="flex items-start gap-2">
            <span className="mt-1">
              <PrGlyph look={lookOf({ ...p, ...(state ? { state } : {}) })} />
            </span>
            <p className="min-w-0 font-medium text-fg" data-testid="pr-pane-title">
              {s?.title || p.title || p.url}
            </p>
          </div>
          {d && (
            <p className="mt-1 text-sm text-fg-3">
              {d.words.join(" · ")}
              {d.updated && ` · ${d.updated}`}
            </p>
          )}
        </div>
        {info === undefined && <Spinner />}
        {info === null && (
          <p className="text-sm text-fg-4" data-testid="pr-pane-unknown">
            GitHub did not answer. It shows on GitHub.
          </p>
        )}
        {s && (
          <>
            <div className="space-y-1 text-sm" data-testid="pr-pane-facts">
              <p className="min-w-0 truncate text-fg-3" title={`${s.head} into ${s.base}`}>
                <span className="font-mono text-fg-2">{s.head}</span> into{" "}
                <span className="font-mono text-fg-2">{s.base}</span>
              </p>
              <p className="tabular-nums text-fg-3">
                <PrWords tone="green">+{s.additions}</PrWords>{" "}
                <PrWords tone="red">-{s.deletions}</PrWords> · {s.files}{" "}
                {s.files === 1 ? "file" : "files"}
                {s.comments > 0 && ` · ${s.comments} ${s.comments === 1 ? "comment" : "comments"}`}
              </p>
              {!done && s.conflicts !== undefined && (
                <p className="text-fg-3" data-testid="pr-pane-merge">
                  {s.conflicts ? (
                    <PrWords tone="red">Conflicts with {s.base}</PrWords>
                  ) : (
                    `No conflicts with ${s.base}`
                  )}
                </p>
              )}
            </div>
            {s.reviewers.length > 0 && (
              <div data-testid="pr-pane-reviewers">
                <h3 className="text-sm font-medium text-fg-4">Reviewers</h3>
                <ul className="mt-1 space-y-0.5">
                  {s.reviewers.map((r) => (
                    <li key={r.login} className="flex items-baseline gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-fg-2">{r.login}</span>
                      {REVIEWER_TONE[r.state] ? (
                        <PrWords tone={REVIEWER_TONE[r.state]!}>{REVIEWER_WORD[r.state]}</PrWords>
                      ) : (
                        <span className={r.state === "requested" ? "text-fg-4" : "text-fg-3"}>
                          {REVIEWER_WORD[r.state]}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Checks checks={s.checks} />
          </>
        )}
      </div>
      <div className="shrink-0 border-t border-line px-4 py-2.5">
        <Button size="sm" onClick={() => open(p.url)} data-testid="pr-pane-open">
          Open on GitHub
        </Button>
      </div>
    </section>
  );
}

/**
 * the chat's PR pane: one PR in full, or a stack's list (the same order as its menu) that opens
 * each in full
 */
export function PrPane({ prs, onClose }: { prs: readonly PrView[]; onClose: () => void }) {
  const [picked, setPicked] = useState<string>();
  const one = prs.length === 1 ? prs[0] : prs.find((p) => p.url === picked);
  if (one) {
    return (
      <PrFull
        p={one}
        onClose={onClose}
        {...(prs.length > 1 ? { onBack: () => setPicked(undefined) } : {})}
      />
    );
  }
  const { open: live, done } = ordered(prs);
  const row = (p: PrView, dim: boolean) => (
    <button
      key={p.url}
      type="button"
      data-testid="pr-pane-row"
      data-url={p.url}
      onClick={() => setPicked(p.url)}
      className="fade flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-raised"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <PrGlyph look={lookOf(p)} />
        <span className={cx("shrink-0 tabular-nums", dim ? "text-fg-4" : "text-fg-2")}>
          #{p.number}
        </span>
        {p.title && (
          <span className={cx("min-w-0 truncate", dim ? "text-fg-4" : "text-fg")}>{p.title}</span>
        )}
      </span>
      <span className="pl-[18px] text-sm text-fg-4">
        {shortRepo(p.repo)}
        {p.state ? ` · ${PR_STATE_WORD[p.state]}` : ""}
      </span>
    </button>
  );
  return (
    <section
      className="flex min-h-0 w-80 shrink-0 flex-col border-l border-line bg-chrome"
      data-testid="pr-pane"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="flex-1 font-medium text-fg">Pull requests</h2>
        <IconButton label="Close" onClick={onClose} data-testid="pr-pane-close">
          <Icon name="x" size={12} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {live.map((p) => row(p, false))}
        {live.length > 0 && done.length > 0 && <div className="mx-2 my-1 border-t border-line" />}
        {done.map((p) => row(p, true))}
      </div>
    </section>
  );
}
