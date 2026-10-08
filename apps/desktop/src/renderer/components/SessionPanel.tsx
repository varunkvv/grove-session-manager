import { useEffect, useRef, useState } from "react";
import type {
  InboxRowView,
  ProjectId,
  RecapView,
  SessionRef,
  SessionTail,
} from "../../shared/ipc.ts";
import { nextActiveKey } from "../logic/rows.ts";
import type { SessionState } from "../logic/views.ts";
import { openWith, review } from "../state/actions.ts";
import { type Section, useStore } from "../state/store.ts";
import { Markdown } from "./Markdown.tsx";
import {
  Button,
  EscButton,
  Icon,
  Mono,
  ProjectMark,
  RecapBlock,
  RuntimeChip,
  Spinner,
  StateLabel,
  Time,
} from "./ui.tsx";

/**
 * a list with a panel, as its rows come and go: a row that left hands the keyboard to the one that
 * took its place, and the panel with it. a closed panel stays closed. while the list has not
 * arrived nothing moves: a landing names the panel's session before its project's sessions are in
 */
export function useHandoff(screen: Section, ids: string[], loaded = true, query = ""): void {
  const before = useRef({ ids: [] as string[], query });
  useEffect(() => {
    if (!loaded) return;
    const s = useStore.getState();
    const was = before.current;
    before.current = { ids, query };
    const typed = was.query !== query;
    const next = nextActiveKey(was.ids, ids, s.active[screen], typed);
    // the panel moves on only from a row this list had. typing in the filter never sends it to
    // another session, and one a landing named that is not here opens nothing
    const peek =
      !s.peek || ids.includes(s.peek)
        ? s.peek
        : !typed && was.ids.includes(s.peek)
          ? nextActiveKey(was.ids, ids, s.peek, false)
          : null;
    if (next !== s.active[screen] || peek !== s.peek) {
      s.set({ active: { ...s.active, [screen]: next }, peek });
    }
  }, [ids, loaded, query, screen]);
}

/**
 * a session's recap and, under it, when it was written and the way to have it written again.
 * while the first one is on its way there is only a quiet line: the rest of the panel is what
 * says where the session is until then
 */
function Recap({
  recap,
  working,
  onAgain,
}: {
  recap: RecapView;
  /** it is in a turn now: no recap is written, and the one there is from before it */
  working: boolean;
  onAgain: () => void;
}) {
  const writing = (words: string) => (
    <span className="flex items-center gap-1.5" data-testid="recap-writing">
      <Spinner size={10} />
      {words}
    </span>
  );
  if (!recap.lines) {
    return recap.writing ? (
      <p className="mt-4 text-sm text-fg-4">{writing("Writing a recap…")}</p>
    ) : null;
  }
  return (
    <div className="mt-4">
      <RecapBlock lines={recap.lines} />
      <div className="mt-1 flex min-h-6 flex-wrap items-center gap-x-2 px-1 text-sm text-fg-4">
        <span data-testid="recap-when">
          Written {recap.at !== undefined && <Time at={recap.at} />}
          {working ? ", before this turn" : recap.old ? ", before it moved on" : ""}
        </span>
        {recap.writing
          ? writing("Writing a new one…")
          : !working && (
              <Button variant="quiet" size="sm" data-testid="recap-again" onClick={onAgain}>
                Write again
              </Button>
            )}
      </div>
    </div>
  );
}

/**
 * a session, beside the list its row is in: a recap of what it was for and what it needs, then
 * what the person last said to it and what it has said since. both lists open this one panel
 */
export function SessionPanel({
  session,
  project,
  state,
  at,
  row,
  onClose,
}: {
  session: SessionRef;
  project?: ProjectId;
  state?: SessionState;
  /** when it last moved */
  at: number;
  /** its inbox row, while it needs the person: what Dismiss clears */
  row?: InboxRowView;
  onClose: () => void;
}) {
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  /** null: main had nothing. undefined: it has not answered */
  const [tail, setTail] = useState<SessionTail | null>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the session moves on, which its state and its time say
  useEffect(() => {
    let stale = false;
    const got = (t: SessionTail | null) => {
      if (!stale) setTail(t);
    };
    void window.grove.sessionTail(session.key).then(got, () => got(null));
    return () => {
      stale = true;
    };
  }, [session.key, state, at]);

  return (
    <div
      className="@container flex h-full flex-col"
      data-testid="session-panel"
      data-id={session.sessionId}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <EscButton onClick={onClose} />
        {state && <StateLabel state={state} within="panel" />}
        <h2 className="min-w-0 flex-1 truncate font-semibold" title={session.title}>
          {session.title}
        </h2>
        <Button
          variant="primary"
          disabled={!!session.open.disabled}
          title={session.open.disabled}
          data-testid="panel-open"
          onClick={() => openWith(session.key, session.open, session.title)}
        >
          {/* one span: the button is a flex row, and two would get its gap between them */}
          <span>
            Open<span className="hidden @md:inline"> in {editor}</span>
          </span>
        </Button>
      </header>
      {/* what the person reads first stays put over what scrolls, and takes the room it needs:
          the recap matters more. in the shortest window it leaves a strip of what is under it,
          and scrolls by itself past that */}
      <div className="max-h-[calc(100%-11rem)] shrink-0 overflow-y-auto px-4 pt-4 pb-3 @md:px-6 @md:pt-5 @md:pb-4 @xl:px-10">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="panel-meta">
          <span className="flex min-w-0 items-center gap-1.5">
            {project && <ProjectMark id={project} />}
            <span className="truncate text-fg-2">{session.where}</span>
          </span>
          {session.branch && (
            <span className="flex min-w-0 items-center gap-1 text-fg-3">
              <Icon name="branch" size={11} faint />
              <Mono className="truncate">{session.branch}</Mono>
            </span>
          )}
          <RuntimeChip runtime={session.runtime} />
          <Time at={at} />
        </div>
        {session.recap && (
          <Recap
            recap={session.recap}
            working={state === "working"}
            onAgain={() => void window.grove.writeRecap(session.key)}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-4 pt-4 pb-6 @md:px-6 @xl:px-10">
        {tail?.prompt && (
          <section>
            <h3 className="text-sm font-medium text-fg-4">You</h3>
            {/* a pasted brief runs to pages: it scrolls in place, so what the agent said stays near */}
            <p
              className="selectable mt-1 max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words text-fg-2"
              data-testid="panel-prompt"
            >
              {tail.prompt}
            </p>
          </section>
        )}
        {tail !== undefined && (
          <section className="mt-6 first:mt-0">
            <h3 className="text-sm font-medium text-fg-4">Claude</h3>
            <div className="mt-1" data-testid="panel-text">
              {tail?.text ? (
                <Markdown text={tail.text} className="md-full" />
              ) : (
                <p className="text-fg-4">Nothing said since.</p>
              )}
            </div>
          </section>
        )}
        {row && (
          <Button
            size="sm"
            className="mt-6"
            data-testid="panel-dismiss"
            onClick={() => void review(row.project, row.reviewKeys)}
          >
            <Icon name="check" size={10} />
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}
