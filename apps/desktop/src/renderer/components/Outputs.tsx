import {
  type FailingCheck,
  formatRelativeTime,
  PR_STATE_WORD,
  type PrCheck,
  type PrInfo,
  type PrReviewer,
  prDetail,
} from "@grove/core/pure";
import { type MouseEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PrView } from "../../shared/ipc.ts";
import { lookOf, ordered, prTooltip, rollup, shortRepo } from "../logic/prs.ts";
import { useTick } from "./Live.tsx";
import {
  Button,
  CheckDot,
  cx,
  Icon,
  IconButton,
  Menu,
  type MenuItem,
  PrGlyph,
  PrWords,
  Spinner,
} from "./ui.tsx";

const open = (url: string) => void window.grove.openExternal(url);
const stop = (e: MouseEvent) => e.stopPropagation();

/** a stack, open ones first (top of the stack first), merged and closed under a line, dimmed */
function stackItems(prs: readonly PrView[]): MenuItem[] {
  const { open: live, done } = ordered(prs);
  const item = (p: PrView, i: number, dim: boolean): MenuItem => ({
    key: p.url,
    label: `#${p.number}${p.title ? ` ${p.title}` : ""}`,
    description: `${shortRepo(p.repo)}${p.state ? ` · ${PR_STATE_WORD[p.state]}` : ""}`,
    mark: <PrGlyph look={lookOf(p)} />,
    ...(dim ? { dim, divider: i === 0 && live.length > 0 } : {}),
  });
  return [...live.map((p, i) => item(p, i, false)), ...done.map((p, i) => item(p, i, true))];
}

/**
 * a row's PR, or its stack: the glyph and the number, or `3 PRs` over the open ones. one opens on
 * github, a stack opens a menu of them. `label` hides the words as the list narrows
 */
export function PrMark({
  prs,
  label,
  className,
  onOpen,
  pressed,
}: {
  prs: readonly PrView[] | undefined;
  /** classes for the words beside the glyph */
  label?: string;
  className?: string;
  /** given: a click is this (the chat's PR pane), not github or the stack's menu */
  onOpen?: () => void;
  /** its pane is open */
  pressed?: boolean;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!prs?.length) return null;
  const r = rollup(prs);
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        title={prTooltip(prs)}
        data-testid="pr-mark"
        data-state={r.single?.state ?? (r.look.done ? "done" : "stack")}
        {...(onOpen ? { "aria-pressed": !!pressed } : {})}
        className={cx(
          "no-drag fade -mr-1 inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-sm tabular-nums hover:bg-active hover:text-fg",
          r.look.done ? "text-fg-4" : "text-fg-3",
          pressed && "bg-raised text-fg",
          className,
        )}
        onClick={(e) => {
          e.stopPropagation();
          if (onOpen) onOpen();
          else if (r.single) open(r.single.url);
          else setAnchor(e.currentTarget.getBoundingClientRect());
        }}
      >
        <PrGlyph look={r.look} />
        <span className={label}>{r.label}</span>
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
              items={stackItems(prs)}
              width={360}
              testId="pr-menu"
              down={anchor.top < window.innerHeight / 2}
              onClose={() => setAnchor(null)}
              onPick={(url) => {
                setAnchor(null);
                open(url);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

/** the row's right edge after the time: the glyph alone while the list is narrow */
export function PrCell({ prs }: { prs: readonly PrView[] | undefined }) {
  return (
    <span className="flex w-5 shrink-0 justify-end @xl:w-16" data-testid="session-pr">
      <PrMark prs={prs} label="hidden @xl:inline" />
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

function PrRow({ p, now, dim }: { p: PrView; now: number; dim: boolean }) {
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
    // biome-ignore lint/a11y/useSemanticElements: a link with links inside it cannot be an <a>
    <div
      role="link"
      tabIndex={0}
      data-testid="card-pr"
      data-state={p.state}
      title={p.url}
      onClick={() => open(p.url)}
      onKeyDown={(e) => {
        if (e.key === "Enter") open(p.url);
      }}
      className="fade -mx-2 cursor-pointer rounded-md px-2 py-1.5 hover:bg-raised"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <PrGlyph look={lookOf(p)} />
        <span className={cx("shrink-0 tabular-nums", dim ? "text-fg-4" : "text-fg-2")}>
          {shortRepo(p.repo)} #{p.number}
        </span>
        {p.title && (
          <span className={cx("min-w-0 truncate", dim ? "text-fg-4" : "text-fg")}>{p.title}</span>
        )}
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
    </div>
  );
}

/** the session card's Pull requests: the same order as a stack's menu */
export function PrSection({ prs, now }: { prs: readonly PrView[] | undefined; now: number }) {
  if (!prs?.length) return null;
  const { open: live, done } = ordered(prs);
  return (
    <div data-testid="card-prs">
      <h3 className="text-sm font-medium text-fg-4">Pull requests</h3>
      <div className="mt-1">
        {live.map((p) => (
          <PrRow key={p.url} p={p} now={now} dim={false} />
        ))}
        {live.length > 0 && done.length > 0 && <div className="my-1 border-t border-line" />}
        {done.map((p) => (
          <PrRow key={p.url} p={p} now={now} dim />
        ))}
      </div>
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
