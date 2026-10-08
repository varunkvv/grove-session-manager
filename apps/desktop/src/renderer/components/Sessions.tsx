import { useEffect, useMemo } from "react";
import type { ProjectView, SessionHit } from "../../shared/ipc.ts";
import { groupSessions, type SessionItem, startBlocked } from "../logic/views.ts";
import {
  editProject,
  focusScreen,
  loadSessions,
  openRow,
  openWith,
  optionId,
  perform,
  startAgent,
} from "../state/actions.ts";
import { currentProject, useStore } from "../state/store.ts";
import { SessionPanel, useHandoff } from "./SessionPanel.tsx";
import {
  Button,
  cx,
  Loading,
  Mono,
  RuntimeChip,
  Split,
  StateLabel,
  stateWord,
  Time,
  useRowDoubleClick,
} from "./ui.tsx";

const NONE: SessionHit[] = [];

/** one line: which session, what it is at when it is at anything, and where it runs */
function SessionRow({
  item,
  active,
  open,
  onClick,
}: {
  item: SessionItem;
  active: boolean;
  /** it is the one in the panel */
  open: boolean;
  onClick: () => void;
}) {
  const { hit, state } = item;
  return (
    <div
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
        "cv-line fade flex h-9 items-center gap-3 border-b border-line px-3 last:border-b-0",
        // the open row is marked whoever moved last. hover and the keyboard's row are the lighter grey
        open ? "bg-active" : "hover:bg-raised data-[active]:bg-raised",
      )}
      onClick={onClick}
      // the keyboard carries on from where the mouse was
      onMouseEnter={() => {
        const s = useStore.getState();
        if (s.active.sessions !== hit.sessionId) {
          s.set({ active: { ...s.active, sessions: hit.sessionId } });
        }
      }}
    >
      <span className="min-w-0 flex-1 truncate text-fg" title={hit.title}>
        {hit.title}
      </span>
      {state && <StateLabel state={state} within="list" className="@xl:w-[128px]" />}
      {/* the branch gives way to the title as the list narrows, and beside the panel where it runs
          does too */}
      <span className="hidden w-[140px] min-w-0 @3xl:block">
        {hit.branch && (
          <Mono className="block truncate text-fg-3" title={hit.branch}>
            {hit.branch}
          </Mono>
        )}
      </span>
      <span className="hidden w-[80px] @xl:block">
        <RuntimeChip runtime={hit.runtime} />
      </span>
      <Time at={item.row?.at ?? hit.activityMs} className="w-[60px] text-right" />
    </div>
  );
}

/** a project nobody has worked in yet. it never offers a start that is known to fail */
function NoSessions({ project }: { project: ProjectView }) {
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  const blocked = startBlocked(project);
  const start = (where: "editor" | "background") => void startAgent({ project: project.id, where });
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
      <div className="mt-5 flex justify-center gap-2">
        {!blocked && (
          <>
            <Button
              variant="primary"
              size="lg"
              onClick={() => start("editor")}
              data-testid="empty-start-editor"
            >
              Start an agent in {editor}
            </Button>
            <Button
              variant="ghost"
              size="lg"
              onClick={() => start("background")}
              data-testid="empty-start-background"
            >
              Start in the background
            </Button>
          </>
        )}
        {blocked?.case === "goal" && (
          <Button variant="primary" size="lg" onClick={editProject} data-testid="empty-edit">
            Edit project
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * a project's sessions, all of them: the ones that need the person, the ones working, then the
 * rest by day. a click opens a session in the panel beside the list
 */
export function Sessions() {
  const project = useStore(currentProject);
  // null until main has answered for this project: another project's rows never show under its name
  const hits = useStore((s) => (s.sessions?.project === s.project ? s.sessions.hits : null));
  const inbox = useStore((s) => s.inbox);
  const filter = useStore((s) => s.filter);
  const now = useStore((s) => s.now);
  const active = useStore((s) => (s.keys ? s.active.sessions : null));
  const peek = useStore((s) => s.peek);

  const groups = useMemo(
    () => groupSessions(hits ?? NONE, inbox, filter, now),
    [hits, inbox, filter, now],
  );
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const ids = useMemo(() => items.map((i) => i.hit.sessionId), [items]);
  const open = items.find((i) => i.hit.sessionId === peek);
  const pair = useRowDoubleClick((h: SessionHit) => openWith(h.key, h.open, h.title));
  const id = project?.id;
  const some = ids.length > 0;

  // main says when a row changed (`sessions:changed`, in the store). asked here when the project
  // comes on screen, when the inbox moves (a dismissed stop in a subfolder leaves the list), and on
  // the clock, which is what moves a working session's time
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are when to ask again, not what is read
  useEffect(() => {
    void loadSessions();
  }, [id, inbox, now]);

  // the list holds the keyboard once it is there. never from under a dialog or the palette, and
  // never out of the filter while it is typed in
  useEffect(() => {
    const s = useStore.getState();
    if (some && !s.overlay && !s.dialog && document.activeElement?.id !== "search") focusScreen();
  }, [some]);
  useHandoff("sessions", ids, hits !== null, filter);

  if (!project) return null;
  return (
    <Split
      testId="sessions"
      root={pair.root}
      from={filter}
      label={open?.hit.title}
      panel={
        open && (
          <SessionPanel
            key={open.hit.sessionId}
            session={open.hit}
            project={project.id}
            state={open.state}
            at={open.row?.at ?? open.hit.activityMs}
            row={open.row}
            // the same as Escape
            onClose={() => perform({ type: "close-panel" })}
          />
        )
      }
    >
      {hits === null ? (
        <Loading />
      ) : hits.length === 0 ? (
        <NoSessions project={project} />
      ) : !some ? (
        <p className="py-28 text-center text-body text-fg" data-testid="sessions-none">
          No sessions match.
        </p>
      ) : (
        <div
          role="listbox"
          aria-label={`Sessions in ${project.name}`}
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
              <div
                id={`group-${g.key}`}
                // the gap under it: the keyboard's row is the same grey, and must not read as its band
                className="mb-1 flex h-8 items-center gap-2 rounded-md bg-raised px-3 text-sm font-medium text-fg-2"
              >
                {g.label}
                <span className="font-normal tabular-nums text-fg-4">{g.items.length}</span>
              </div>
              {g.items.map((i) => (
                <SessionRow
                  key={i.hit.sessionId}
                  item={i}
                  active={i.hit.sessionId === active}
                  open={i.hit.sessionId === peek}
                  onClick={() => {
                    pair.clicked(i.hit);
                    openRow("sessions", i.hit.sessionId);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </Split>
  );
}
