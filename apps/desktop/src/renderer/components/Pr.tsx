import { type FailingCheck, formatRelativeTime, PR_STATE_WORD, prDetail } from "@grove/core/pure";
import { type MouseEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PrView } from "../../shared/ipc.ts";
import { lookOf, ordered, prTooltip, rollup, shortRepo } from "../logic/prs.ts";
import { cx, Menu, type MenuItem, PrGlyph } from "./ui.tsx";

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
}: {
  prs: readonly PrView[] | undefined;
  /** classes for the words beside the glyph */
  label?: string;
  className?: string;
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
        className={cx(
          "no-drag fade -mr-1 inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-sm tabular-nums hover:bg-active hover:text-fg",
          r.look.done ? "text-fg-4" : "text-fg-3",
          className,
        )}
        onClick={(e) => {
          e.stopPropagation();
          if (r.single) open(r.single.url);
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
