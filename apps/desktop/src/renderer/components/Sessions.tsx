import { tokenize } from "@grove/core/pure";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ProjectId, ProjectView, SessionRef } from "../../shared/ipc.ts";
import { moved } from "../logic/keyboard.ts";
import {
  groupSessions,
  type SessionItem,
  startBlocked,
  tasksLine,
  tasksSince,
} from "../logic/views.ts";
import {
  drawMore,
  focusScreen,
  loadSessions,
  newSession,
  openRow,
  openSession,
  optionId,
  perform,
  toggleOlder,
} from "../state/actions.ts";
import { currentProject, listInput, type Section, useStore } from "../state/store.ts";
import { InboxRow } from "./Inbox.tsx";
import { SessionPanel, useHandoff } from "./SessionPanel.tsx";
import {
  Button,
  cx,
  Highlighted,
  Icon,
  Loading,
  Mono,
  ProjectMark,
  RuntimeChip,
  Split,
  StateLabel,
  stateWord,
  Time,
  useRowDoubleClick,
} from "./ui.tsx";

/** rows with no description that came into sight, sent to main together a moment later */
const inSight = new Set<string>();
const askedFor = new Set<string>();
const keyOf = new WeakMap<Element, string>();
let sending: ReturnType<typeof setTimeout> | undefined;
const sight =
  typeof IntersectionObserver === "undefined"
    ? undefined
    : new IntersectionObserver((seen) => {
        for (const e of seen) {
          const key = keyOf.get(e.target);
          if (!e.isIntersecting || !key) continue;
          sight?.unobserve(e.target);
          if (!askedFor.has(key)) inSight.add(key);
          askedFor.add(key);
        }
        if (!inSight.size) return;
        clearTimeout(sending);
        sending = setTimeout(() => {
          void window.grove.nameSessions([...inSight]).catch(() => {});
          inSight.clear();
        }, 300);
      });

/**
 * a session from the last week is named without being asked. an older one is named when its row
 * comes into sight: Older draws a page at a time, so this is what he scrolls to
 */
function useNamedInSight(ref: RefObject<HTMLDivElement | null>, key: string, named: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || named || !sight) return;
    keyOf.set(el, key);
    sight.observe(el);
    return () => sight.unobserve(el);
  }, [ref, key, named]);
}

/**
 * which session, what it is at when it is at anything, and where it is, and under it what it is
 * for: how he tells sessions apart. a watching one has what it left running under that. one a
 * search found by what was said in it has the words around the match in the description's place.
 * with no description yet a row is as it was: a working one says what it was last asked
 */
function SessionRow({
  item,
  screen,
  active,
  open,
  tokens,
  onClick,
}: {
  item: SessionItem;
  screen: Section;
  active: boolean;
  /** it is the one in the panel */
  open: boolean;
  /** the words of a search, marked wherever they show */
  tokens: readonly string[];
  onClick: () => void;
}) {
  const { hit, state, snippet } = item;
  const ref = useRef<HTMLDivElement>(null);
  useNamedInSight(ref, hit.key, !!hit.description);
  const home = screen === "inbox";
  const watching = state === "watching" ? hit.tasks : undefined;
  const described = hit.description;
  // the last prompt is often "yes go ahead": what the session is for says more. the panel has it
  const doing = state === "working" ? !described && hit.doing : watching && tasksLine(watching);
  const lines =
    1 + (snippet || described || doing ? 1 : 0) + (!snippet && described && doing ? 1 : 0);
  return (
    <div
      ref={ref}
      id={optionId(hit.sessionId)}
      role="option"
      aria-selected={active}
      aria-label={state ? `${stateWord(state)}: ${hit.title}` : hit.title}
      data-testid="session-row"
      data-id={hit.sessionId}
      data-state={state}
      data-active={active || undefined}
      data-open={open || undefined}
      className={cx(
        "fade border-b border-line px-3 last:border-b-0",
        lines === 1
          ? "cv-line flex h-9 flex-col justify-center"
          : lines === 2
            ? "cv-row py-2"
            : "cv-tall py-2",
        // the open row is marked whoever moved last. hover and the keyboard's row are the lighter grey
        open ? "bg-active" : "hover:bg-raised data-[active]:bg-raised",
      )}
      onClick={onClick}
      // the keyboard carries on from where the mouse was. a move, not an enter: a list that the
      // keys scroll under a resting pointer puts another row under it, and that row is not the
      // keyboard's
      onMouseMove={(e) => {
        const s = useStore.getState();
        if (moved(e) && s.active[screen] !== hit.sessionId) {
          s.set({ active: { ...s.active, [screen]: hit.sessionId } });
        }
      }}
    >
      <div className="flex h-5 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-fg" title={hit.title}>
          <Highlighted text={hit.title} tokens={tokens} />
        </span>
        {state && <StateLabel state={state} within="list" className="@xl:w-[128px]" />}
        {/* where it is gives way to the title as the list narrows. the home screen says which
            project, in the cells of a row that needs him, and a project's own screen the branch */}
        {home ? (
          <span className="flex min-w-0 items-center gap-1.5 @xl:w-[132px]" title={hit.where}>
            {/* a session in no project has no mark, only its folder's name where the others' are */}
            {hit.project ? <ProjectMark id={hit.project} /> : <span className="size-2 shrink-0" />}
            <span className="hidden truncate text-fg-3 @xl:inline" data-testid="session-project">
              {hit.where}
            </span>
          </span>
        ) : (
          <span className="hidden w-[140px] min-w-0 @3xl:block">
            {hit.branch && (
              <Mono className="block truncate text-fg-3" title={hit.branch}>
                <Highlighted text={hit.branch} tokens={tokens} />
              </Mono>
            )}
          </span>
        )}
        <span className={cx("hidden w-[80px]", home ? "@3xl:block" : "@xl:block")}>
          <RuntimeChip runtime={hit.runtime} />
        </span>
        {/* a working one says how long its turn has run, a watching one how long it has watched */}
        <Time
          at={item.row?.at ?? hit.activityMs}
          since={state === "working" ? hit.since : watching && tasksSince(watching)}
          className="w-[60px] text-right"
        />
      </div>
      {snippet ? (
        // why a search has it here: its title does not say
        <p className="mt-0.5 truncate text-fg-3" title={snippet} data-testid="session-snippet">
          <Highlighted text={snippet} tokens={tokens} />
        </p>
      ) : (
        described && (
          <p
            className="mt-0.5 truncate text-fg-2"
            title={described}
            data-testid="session-description"
          >
            <Highlighted text={described} tokens={tokens} />
          </p>
        )
      )}
      {doing && !snippet && (
        <p
          className="mt-0.5 truncate text-fg-4"
          title={doing}
          data-testid={watching ? "session-tasks" : "session-doing"}
        >
          {doing}
        </p>
      )}
    </div>
  );
}

/** a project nobody has worked in yet. it never offers a start that is known to fail */
function NoSessions({ project }: { project: ProjectView }) {
  const blocked = startBlocked(project);
  return (
    <div
      className="pt-24 text-center"
      data-testid="sessions-empty"
      data-case={blocked?.case ?? "ready"}
    >
      <p className="text-body text-fg">No sessions yet.</p>
      <p className="mt-1 text-body text-fg-4">
        {blocked?.line ?? "Sessions started in this project's folder show here."}
      </p>
      {!blocked && (
        <div className="mt-5 flex justify-center">
          <Button
            variant="primary"
            size="lg"
            onClick={() => newSession(project.id)}
            data-testid="empty-new-session"
          >
            New session
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * the end of what Older has drawn. when it comes near the window the next rows are drawn. `drawn`
 * starts the watch over after each of them, so a window taller than a page keeps going
 */
function More({ drawn }: { drawn: number }) {
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `drawn` is when to look again, not what is read
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const watch = new IntersectionObserver(
      (seen) => {
        if (seen.some((e) => e.isIntersecting)) drawMore();
      },
      // the list's own scroller, so the margin reaches past its edge: a screen and a half ahead
      { root: el.closest("[data-scroller]"), rootMargin: "0px 0px 150% 0px" },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, [drawn]);
  return <div ref={ref} aria-hidden="true" className="h-px" data-testid="older-more" />;
}

/** a group's band. the gap under it: the keyboard's row is the same grey, and must not read as its band */
const BAND =
  "mb-1 flex h-8 items-center gap-2 rounded-md bg-raised px-3 text-sm font-medium text-fg-2";

/**
 * a list of sessions, all of them: the ones that need the person, the ones working or watching,
 * then the rest by day, with what is older than three days folded away. a project's, or on the home screen
 * (`scope` null) every project's and the ones in none. a click opens a session in the panel beside
 * the list
 */
export function Sessions({ scope }: { scope: ProjectId | null }) {
  const screen: Section = scope === null ? "inbox" : "sessions";
  const project = useStore((s) => (scope === null ? undefined : currentProject(s)));
  const input = useStore(useShallow(listInput));
  const { hits, inbox, now, query } = input;
  const active = useStore((s) => (s.keys ? s.active[screen] : null));
  const peek = input.peek;

  const tokens = useMemo(() => tokenize(query), [query]);
  const typed = tokens.length > 0;
  const groups = useMemo(() => groupSessions(input), [input]);
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const ids = useMemo(() => items.map((i) => i.hit.sessionId), [items]);
  const open = items.find((i) => i.hit.sessionId === peek);
  const older = groups.find((g) => g.key === "older");
  const pair = useRowDoubleClick((h: SessionRef) => openSession(h.key, h.open, h.title));
  const some = groups.length > 0;

  // main says when a row changed (`sessions:changed`, in the store). asked here when the list
  // comes on screen, when the inbox moves (a dismissed stop in a subfolder leaves the list), and on
  // the clock, which is what moves a working session's time
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are when to ask again, not what is read
  useEffect(() => {
    void loadSessions();
  }, [scope, inbox, now]);

  // the list holds the keyboard once it is there. never from under a dialog or the palette, and
  // never out of the filter while it is typed in
  useEffect(() => {
    const s = useStore.getState();
    if (some && !s.overlay && !s.dialog && document.activeElement?.id !== "search") focusScreen();
  }, [some]);
  useHandoff(screen, ids, hits !== null, query);

  // what was said in a session is main's to look through: asked 80ms after the last key, as the
  // palette does. an answer to an older query is dropped
  useEffect(() => {
    if (!typed) return;
    let stale = false;
    const timer = setTimeout(async () => {
      // a search that failed is an answer with nothing in it, or `No sessions match.` would never show
      const found = await window.grove.findSessions(query, scope).catch(() => []);
      if (!stale) useStore.getState().set({ found: { scope, query, hits: found } });
    }, 80);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, scope, typed]);

  if (scope !== null && !project) return null;
  return (
    <Split
      testId={screen}
      root={pair.root}
      from={query}
      label={open && (open.state ? `${stateWord(open.state)}: ${open.hit.title}` : open.hit.title)}
      panel={
        open && (
          <SessionPanel
            key={open.hit.sessionId}
            // its inbox row while it needs him: that one is pushed, the list is asked for
            session={open.row ?? open.hit}
            project={open.hit.project}
            state={open.state}
            at={open.row?.at ?? open.hit.activityMs}
            row={open.row}
            // the list's, not the inbox row's: a session that needs him can have them too
            tasks={open.hit.tasks}
            // the same as Escape
            onClose={() => perform({ type: "close-panel" })}
          />
        )
      }
    >
      {some ? (
        <div
          role="listbox"
          aria-label={project ? `Sessions in ${project.name}` : "All sessions"}
          tabIndex={0}
          data-list
          aria-activedescendant={active ? optionId(active) : undefined}
          className="space-y-5"
        >
          {groups.map((g) => (
            <div
              key={g.key}
              role="group"
              aria-labelledby={`group-${g.key}`}
              data-testid="session-group"
              data-group={g.key}
            >
              {g.key === "older" && !typed ? (
                // the one group that folds: closed until it is asked for, a page at a time after.
                // a search looks in all of it, so while one is typed there is nothing to fold
                <button
                  type="button"
                  id="group-older"
                  aria-expanded={g.open}
                  data-testid="older-toggle"
                  className={cx(BAND, "fade w-full hover:bg-active")}
                  onClick={(e) => {
                    toggleOlder();
                    // a click leaves the keyboard with the list. a key on the button leaves it there
                    if (e.detail) focusScreen();
                  }}
                >
                  <Icon name="chevron" size={10} faint className={cx(g.open && "rotate-90")} />
                  {g.label}
                  <span className="font-normal tabular-nums text-fg-4">{g.count}</span>
                </button>
              ) : (
                <div id={`group-${g.key}`} className={BAND}>
                  {g.label}
                  <span className="font-normal tabular-nums text-fg-4">{g.count}</span>
                </div>
              )}
              {g.items.map((i) => {
                const id = i.hit.sessionId;
                const row = {
                  active: id === active,
                  open: id === peek,
                  tokens,
                  onClick: () => {
                    pair.clicked(i.hit);
                    openRow(screen, id);
                  },
                };
                // on the home screen a session that needs him is the inbox's row, with what it asks
                return scope === null && i.row ? (
                  <InboxRow key={id} row={i.row} snippet={i.snippet} {...row} />
                ) : (
                  <SessionRow key={id} item={i} screen={screen} {...row} />
                );
              })}
            </div>
          ))}
          {older?.open && older.items.length < older.count && <More drawn={older.items.length} />}
        </div>
      ) : hits === null ? (
        <Loading />
      ) : typed ? (
        // only once main has looked through what was said: until then nothing is known to be missing
        input.found && (
          <p className="py-28 text-center text-body text-fg" data-testid="sessions-none">
            No sessions match.
          </p>
        )
      ) : project ? (
        <NoSessions project={project} />
      ) : (
        <div className="pt-24 text-center" data-testid="inbox-empty">
          <p className="text-body text-fg">No sessions yet.</p>
          <p className="mt-1 text-body text-fg-4">
            Sessions from every project show here, and the ones started outside one.
          </p>
        </div>
      )}
    </Split>
  );
}
