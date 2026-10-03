import { useEffect, useMemo, useRef } from "react";
import type { ConclusionView } from "../../shared/ipc.ts";
import { nextActiveKey } from "../logic/rows.ts";
import { type ConclusionControls, decidedLine, filterConclusions } from "../logic/views.ts";
import { whoView } from "../logic/who.ts";
import { openConclusion, openWith, optionId, review } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import {
  Avatar,
  Button,
  CardChip,
  ConclusionChip,
  cx,
  Dot,
  Icon,
  inputClass,
  KindLabel,
  Loading,
  ProblemMark,
  Segmented,
  Time,
} from "./ui.tsx";

const NONE: ConclusionView[] = [];

/** the search, the kind and the open row live in the store: they outlive a trip to a card and back */
function setControls(patch: Partial<ConclusionControls>): void {
  const s = useStore.getState();
  s.set({ conclusions: { ...s.conclusions, ...patch } });
}

/** exactly the conclusions that have an inbox row: the same mark clears both */
const notReviewed = (c: ConclusionView) => c.needsReview && !c.reviewed;

/** what opens with a row: who settled it and how, what it replaces, and the two actions */
function ConclusionDetail({ c }: { c: ConclusionView }) {
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  const project = useStore((s) => s.project);
  const canOpen = c.sessionKey && c.open;
  const dot = notReviewed(c);
  return (
    <div className="space-y-2.5 pr-3 pb-3 pl-12" data-testid="conclusion-detail">
      <p className="text-sm text-fg-3">{decidedLine(c)}</p>
      {(c.replaces || c.related.length > 0) && (
        // flex, so a chip sits in the middle of its line whatever its own vertical-align says
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-3">
          {c.replaces && (
            <span className="flex items-center gap-1">
              Replaces <ConclusionChip id={c.replaces} />
            </span>
          )}
          {c.related.length > 0 && (
            <span className="flex items-center gap-1">
              Related
              {c.related.map((id) => (
                <ConclusionChip key={id} id={id} />
              ))}
            </span>
          )}
        </p>
      )}
      {(canOpen || dot) && (
        <div className="flex gap-1.5">
          {canOpen && (
            <Button
              size="sm"
              disabled={!!c.open?.disabled}
              title={c.open?.disabled}
              data-testid="conclusion-open"
              onClick={() => openWith(c.sessionKey, c.open, c.id)}
            >
              Open in {editor}
            </Button>
          )}
          {dot && project && (
            <Button
              size="sm"
              data-testid="conclusion-review"
              onClick={() => void review(project, [`conclusion:${c.id}`])}
            >
              <Icon name="check" size={10} />
              Reviewed
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * the inbox's shape: what it is and whose, then what was settled at full width, then why. closed,
 * `what` takes two lines at most and `why` one. open, both wrap to their full length
 */
function ConclusionRow({ c, open, active }: { c: ConclusionView; open: boolean; active: boolean }) {
  const by = whoView(c.by === "person" ? "person" : c.who);
  // markSuperseded pushes oldest first
  const newest = c.replacedBy.at(-1);
  return (
    <li
      id={optionId(c.id)}
      role="option"
      aria-selected={active}
      data-testid="conclusion-row"
      data-id={c.id}
      data-kind={c.kind}
      data-open={open || undefined}
      data-superseded={c.superseded || undefined}
      data-active={active || undefined}
      className={cx("group border-b border-line", open && "bg-raised")}
      // the row under the mouse is the one the next key acts on
      onMouseMove={() => {
        const s = useStore.getState();
        if (s.active.conclusions !== c.id) s.set({ active: { ...s.active, conclusions: c.id } });
      }}
    >
      <div
        className="fade cursor-default px-3 py-2 hover:bg-raised group-data-[active]:bg-raised"
        onClick={() => setControls({ open: open ? null : c.id })}
      >
        <div className="flex h-5 items-center gap-3">
          {/* kept when there is no dot, so the kinds line up */}
          <span className="flex w-1.5 shrink-0">
            {notReviewed(c) && <Dot label="Not reviewed" />}
          </span>
          <KindLabel kind={c.kind} className="w-[76px]" />
          <span className="w-[44px] shrink-0 font-mono text-sm text-fg-4">{c.id}</span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <ProblemMark count={c.problems} />
            {c.superseded && newest && (
              <span className="shrink-0 text-sm text-fg-4" data-testid="replaced-by">
                replaced by{" "}
                <Button
                  variant="link"
                  className="font-mono font-normal!"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    openConclusion(newest);
                  }}
                >
                  {newest}
                </Button>
              </span>
            )}
          </span>
          {/* the inbox's cell: avatar 16 + 6 + a name as long as `chat-features-35` */}
          <span className="flex w-[126px] min-w-0 shrink-0 items-center gap-1.5">
            {by && (
              <>
                <Avatar who={by} />
                <span className="truncate text-fg-2">{by.name}</span>
              </>
            )}
          </span>
          <span className="flex w-[96px] shrink-0 items-center">
            {c.card && <CardChip cardId={c.card.id} inRow />}
          </span>
          <span className="w-[56px] shrink-0 truncate text-sm text-fg-4">{c.area}</span>
          <Time at={c.at} className="w-[60px] text-right" />
        </div>
        {/* both start under the kind's word: dot 6 + 12, icon 12 + 6 */}
        <p
          className={cx(
            "mt-0.5 pl-9",
            !open && "line-clamp-2",
            c.superseded ? "text-fg-4 line-through" : "text-fg",
          )}
          title={c.what}
          data-testid="conclusion-what"
        >
          {c.what}
        </p>
        {c.why && (
          <p
            className={cx("mt-0.5 pl-9 text-sm text-fg-4", !open && "truncate")}
            title={c.why}
            data-testid="conclusion-why"
          >
            {c.why}
          </p>
        )}
      </div>
      {open && <ConclusionDetail c={c} />}
    </li>
  );
}

/**
 * the conclusions screen (ui.md 4.4): every decision, finding and verdict of the project, newest
 * first, with its why. the search keeps the keyboard and the arrows move the active row
 */
export function Conclusions() {
  const record = useStore((s) => (s.project ? s.records[s.project] : undefined));
  const { query, kind, open } = useStore((s) => s.conclusions);
  // no row looks like the keyboard's until a key says so
  const active = useStore((s) => (s.keys ? s.active.conclusions : null));
  const list = record?.conclusions ?? NONE;
  const shown = useMemo(() => filterConclusions(list, query, kind), [list, query, kind]);
  const filter = `${kind} ${query}`;
  const before = useRef({ ids: [] as string[], filter });

  // a new search starts from its first match. a row that left hands the keyboard to the one that
  // took its place
  useEffect(() => {
    const ids = shown.map((c) => c.id);
    const s = useStore.getState();
    const was = before.current;
    const next = nextActiveKey(was.ids, ids, s.active.conclusions, was.filter !== filter);
    before.current = { ids, filter };
    if (next !== s.active.conclusions) s.set({ active: { ...s.active, conclusions: next } });
  }, [shown, filter]);

  // a search that hides the open row closes it, or the next Escape would close a row nobody sees
  useEffect(() => {
    if (open && !shown.some((c) => c.id === open)) setControls({ open: null });
  }, [open, shown]);

  // a row a chip opened, or the one that was open before a trip to a card: on screen, and the
  // keyboard's
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(open))?.scrollIntoView({ block: "nearest" });
    const s = useStore.getState();
    if (s.active.conclusions !== open) s.set({ active: { ...s.active, conclusions: open } });
  }, [open]);

  return (
    // the gutter stays when a search leaves too few rows to scroll, or the field would move while
    // it is typed in
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]" data-testid="conclusions">
      <div className="mx-auto max-w-[860px] px-4 pt-8 pb-16">
        <h1 className="sr-only">Conclusions</h1>
        {record?.readAt === undefined ? (
          <Loading />
        ) : list.length === 0 ? (
          <p className="py-28 text-center text-body text-fg-4" data-testid="conclusions-empty">
            No conclusions yet. Agents record decisions, findings and verdicts as they work, yours
            included.
          </p>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <div className="relative min-w-0 flex-1">
                <Icon
                  name="search"
                  size={11}
                  faint
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
                />
                <input
                  id="search"
                  type="search"
                  // no native clear button: its glyph is chromium's, not one of the app's. Escape clears
                  className={cx(
                    inputClass,
                    "pl-7 [&::-webkit-search-cancel-button]:appearance-none",
                  )}
                  placeholder="Search conclusions"
                  aria-label="Search conclusions"
                  aria-controls="conclusion-list"
                  aria-activedescendant={active ? optionId(active) : undefined}
                  autoFocus
                  spellCheck={false}
                  data-testid="conclusions-search"
                  value={query}
                  // typing is the keyboard: the first match shows as its row, so Enter opens it
                  onChange={(e) => {
                    setControls({ query: e.target.value });
                    useStore.getState().set({ keys: true });
                  }}
                />
              </div>
              <Segmented
                label="Kind"
                value={kind}
                onChange={(k) => setControls({ kind: k })}
                options={[
                  { value: "all", label: "All", testId: "kind-all" },
                  { value: "decision", label: "Decisions", testId: "kind-decision" },
                  { value: "finding", label: "Findings", testId: "kind-finding" },
                  { value: "verdict", label: "Verdicts", testId: "kind-verdict" },
                ]}
              />
            </div>
            {shown.length === 0 ? (
              <p
                className="py-16 text-center text-body text-fg-4"
                data-testid="conclusions-nomatch"
              >
                No conclusion matches.
              </p>
            ) : (
              <ul
                id="conclusion-list"
                role="listbox"
                aria-label="Conclusions"
                className="border-t border-line"
              >
                {shown.map((c) => (
                  <ConclusionRow key={c.id} c={c} open={c.id === open} active={c.id === active} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
