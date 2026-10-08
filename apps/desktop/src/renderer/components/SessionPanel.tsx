import type { ConversationView, TurnView } from "@grove/core/pure";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { InboxRowView, ProjectId, RecapView, SessionRef } from "../../shared/ipc.ts";
import { nextActiveKey } from "../logic/rows.ts";
import { type SessionState, workLine } from "../logic/views.ts";
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

/** one line of what happened, where there is nothing to read: a compaction, an interrupt */
const QUIET = "text-sm text-fg-4";

/**
 * one turn: what the person typed, the work in one line, and the message it ended on. the steps
 * inside the work are in the editor. the message is an agent's and goes through Markdown, what
 * the person typed is plain text
 */
function Turn({ turn, last, working }: { turn: TurnView; last: boolean; working: boolean }) {
  const p = turn.prompt;
  const typed =
    "selectable mt-1 max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words text-fg-2";
  // the turn it is in now has no end yet, so no length either
  const going = last && working;
  const work = workLine(going ? { ...turn, ms: undefined } : turn);
  // the last turn always says what the agent said, even when that is nothing yet
  const talks = !!turn.text || !!work || (last && p?.kind !== "command");
  return (
    <section className="mt-6 first:mt-0" data-testid="turn">
      {p?.kind === "human" ? (
        <>
          <h3 className="text-sm font-medium text-fg-4">You</h3>
          {/* a pasted brief runs to pages: it scrolls in place, so what the agent said stays near */}
          <p className={typed} data-testid={last ? "panel-prompt" : undefined}>
            {p.text}
          </p>
        </>
      ) : (
        // a slash command, or Claude Code saying a background task finished: nobody typed a prompt
        p && <p className={`${QUIET} break-words`}>{p.text}</p>
      )}
      {turn.said?.map((said) => (
        <div key={said} className="mt-3">
          <h3 className="text-sm font-medium text-fg-4">You, while it worked</h3>
          <p className={typed}>{said}</p>
        </div>
      ))}
      {talks && (
        <>
          <h3 className="mt-3 text-sm font-medium text-fg-4" data-testid="turn-work">
            Claude
            <span className="font-normal">
              {work ? ` · ${work}${going ? " so far" : ""}` : going ? " · working" : ""}
            </span>
          </h3>
          <div className="mt-1" data-testid={last ? "panel-text" : undefined}>
            {turn.text ? (
              <Markdown text={turn.text} className={last ? "md-full" : undefined} />
            ) : (
              last && <p className="text-fg-4">Nothing said yet.</p>
            )}
          </div>
        </>
      )}
      {turn.note && <p className={`${QUIET} mt-2 break-words`}>{turn.note}</p>}
    </section>
  );
}

/**
 * a session, beside the list its row is in: a recap of what it was for and what it needs, and
 * under it the conversation, opened at its end. both lists open this one panel
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
  /** null: the transcript is gone. undefined: main has not answered */
  const [talk, setTalk] = useState<ConversationView | null>();
  const scroller = useRef<HTMLDivElement>(null);
  /** the conversation is at its end, which is where it opens: a new turn keeps it there */
  const atEnd = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the session moves on, which its state and its time say
  useEffect(() => {
    let stale = false;
    const got = (t: ConversationView | null) => {
      if (!stale) setTalk(t);
    };
    void window.grove.sessionConversation(session.key).then(got, () => got(null));
    return () => {
      stale = true;
    };
  }, [session.key, state, at]);

  // the recap arriving makes the room under it smaller: the end stays in sight through that too
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are when to scroll, not what is read
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [talk, session.recap]);

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
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto border-t border-line px-4 pt-4 pb-6 @md:px-6 @xl:px-10"
        data-testid="conversation"
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {talk === null && (
          <p className={QUIET} data-testid="panel-gone">
            This session's transcript is gone. Claude Code deletes one after 30 days.
          </p>
        )}
        {!!talk?.older && (
          <p className={`${QUIET} mb-6`} data-testid="turns-older">
            {talk.older} older {talk.older === 1 ? "turn is" : "turns are"} in {editor}.
          </p>
        )}
        {talk?.items.map((item, i) =>
          item.kind === "compact" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a transcript only grows, so a turn's number in it is its key
            <p key={talk.older + i} className={`${QUIET} mt-6`} data-testid="turn-compact">
              Compacted: what came before was summarised.
            </p>
          ) : (
            <Turn
              // biome-ignore lint/suspicious/noArrayIndexKey: a transcript only grows, so a turn's number in it is its key
              key={talk.older + i}
              turn={item}
              last={i === talk.items.length - 1}
              working={state === "working"}
            />
          ),
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
