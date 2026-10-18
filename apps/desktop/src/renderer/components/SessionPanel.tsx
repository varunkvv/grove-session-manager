import { type ConversationView, type FileMark, fileKind, type TurnView } from "@grove/core/pure";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ChatStatus,
  InboxRowView,
  Outcome,
  ProjectId,
  RecapView,
  SessionRef,
  TaskView,
} from "../../shared/ipc.ts";
import { blocks } from "../logic/blocks.ts";
import { nextActiveKey } from "../logic/rows.ts";
import { type SessionState, workLine } from "../logic/views.ts";
import { openChat, openWith, review } from "../state/actions.ts";
import { useChatScope } from "../state/chatScope.ts";
import { type Section, useStore } from "../state/store.ts";
import { Ask } from "./Asks.tsx";
import { Clock, LiveLine } from "./Live.tsx";
import { Markdown } from "./Markdown.tsx";
import { StepList, Thought } from "./Steps.tsx";
import {
  AgentState,
  Button,
  ComposerFrame,
  EscButton,
  Icon,
  Mono,
  ProjectMark,
  RecapBlock,
  RuntimeChip,
  SendButton,
  Spinner,
  StateLabel,
  TaskMark,
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
  goal,
  onAgain,
}: {
  recap: RecapView;
  /** it is in a turn now: no recap is written, and the one there is from before it */
  working: boolean;
  /** with no description above it, the recap says what the session was for */
  goal: boolean;
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
      <RecapBlock lines={recap.lines} goal={goal} />
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
 * what the session left running, whatever it is at: each background command, Monitor or wake-up,
 * how long grove has seen it, and under it one line of status. a command's is the last line it
 * wrote, which is its own text: plain, one line, never markdown
 */
function Tasks({ tasks }: { tasks: readonly TaskView[] }) {
  return (
    <div className="mt-4" data-testid="panel-tasks">
      <h3 className="text-sm font-medium text-fg-4">Background tasks</h3>
      <ul className="mt-1.5 space-y-1.5">
        {tasks.map((t) => (
          <li key={t.id} data-testid="panel-task" data-kind={t.kind}>
            <div className="flex items-center gap-2">
              <TaskMark />
              <span className="min-w-0 flex-1 truncate text-fg-2" title={t.description}>
                {t.description}
              </span>
              <Time at={t.since} since={t.since} />
            </div>
            {t.status && (
              // under the description, past the mark
              <Mono className="block truncate pl-4 text-fg-3" title={t.status}>
                {t.status}
              </Mono>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** one line of what happened, where there is nothing to read: a compaction, an interrupt */
export const QUIET = "text-sm text-fg-4";

/**
 * one turn: what the person typed, the work in one line, and the message it ended on. the steps
 * inside the work are in the editor. the message is an agent's and goes through Markdown, what
 * the person typed is plain text
 */
export function Turn({
  turn,
  last,
  working,
  images,
  detail,
  stepsOpen,
  who = "You",
}: {
  turn: TurnView;
  last: boolean;
  working: boolean;
  /** say what was attached to a prompt (images, files): grove chat, where they are sent from */
  images?: boolean;
  /**
   * grove chat: the work line opens the turn's steps, and the thinking before the answer sits
   * folded above it. the panel has neither
   */
  detail?: boolean;
  /** the steps start open: an agent's own transcript, which is opened to see what it did */
  stepsOpen?: boolean;
  /** who the prompt is from: an agent's is what it was asked */
  who?: string;
}) {
  const [open, setOpen] = useState(!!stepsOpen);
  const scope = useChatScope();
  const p = turn.prompt;
  const typed =
    "selectable mt-1 max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words text-fg-2";
  // the turn it is in now has no end yet, so no length either
  const going = last && working;
  // grove chat says its agents and workflows apart, as a way to the drawer that lists them
  const agentsLink = detail && (turn.agents > 0 || !!turn.workflows) && !!scope?.agents;
  const agentWords = [
    turn.agents ? `${turn.agents} ${turn.agents === 1 ? "agent" : "agents"}` : "",
    turn.workflows ? `${turn.workflows} ${turn.workflows === 1 ? "workflow" : "workflows"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const work = workLine({
    ...turn,
    ...(going ? { ms: undefined } : {}),
    ...(agentsLink ? { agents: 0 } : {}),
  });
  // the last turn always says what the agent said, even when that is nothing yet
  const talks = !!turn.text || !!work || (last && p?.kind !== "command");
  return (
    <section className="mt-6 first:mt-0" data-testid="turn">
      {p?.kind === "human" ? (
        <>
          <h3 className="text-sm font-medium text-fg-4">
            {who}
            {images && (!!p.images || !!p.files?.length) && (
              <span className="font-normal" data-testid="turn-attached">
                {p.images ? ` · ${p.images} ${p.images === 1 ? "image" : "images"}` : ""}
                {p.files?.map((f) => ` · ${f}`).join("")}
              </span>
            )}
          </h3>
          {/* a pasted brief runs to pages: it scrolls in place, so what the agent said stays near */}
          <p className={typed} data-testid={last ? "panel-prompt" : undefined}>
            {p.text}
          </p>
        </>
      ) : (
        // a slash command, or Claude Code saying a background task finished: nobody typed a prompt
        p && <p className={`${QUIET} break-words`}>{p.text}</p>
      )}
      {detail && turn.output && (
        <div
          className="selectable mt-2 border-l border-line pl-3 text-sm text-fg-3"
          data-testid="turn-output"
        >
          <Markdown text={turn.output} />
        </div>
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
            {detail && turn.steps?.length ? (
              <>
                <span className="font-normal"> · </span>
                <button
                  type="button"
                  aria-expanded={open}
                  data-testid="turn-steps-toggle"
                  onClick={() => setOpen(!open)}
                  className="fade inline-flex items-center gap-1 font-normal hover:text-fg-2"
                >
                  {`${work || "working"}${work && going ? " so far" : ""}`}
                  <Icon name="chevron" size={9} faint className={open ? "rotate-90" : undefined} />
                </button>
                {agentsLink && (
                  <>
                    <span className="font-normal"> · </span>
                    <button
                      type="button"
                      data-testid="turn-agents"
                      onClick={() => scope?.agents?.()}
                      className="fade font-normal underline decoration-line-strong underline-offset-2 hover:text-fg-2"
                    >
                      {agentWords}
                    </button>
                  </>
                )}
              </>
            ) : (
              <span className="font-normal">
                {work ? ` · ${work}${going ? " so far" : ""}` : going ? " · working" : ""}
              </span>
            )}
          </h3>
          {detail && open && turn.steps && (
            <StepList steps={turn.steps} before={turn.stepsBefore} going={going} />
          )}
          {detail && turn.thought && <Thought text={turn.thought.text} ms={turn.thought.ms} />}
          <div className="mt-1" data-testid={last ? "panel-text" : undefined}>
            {turn.text ? (
              <Markdown
                text={turn.text}
                className={last ? "md-full" : undefined}
                streaming={going}
              />
            ) : (
              // grove chat says what it is doing under the turn instead
              last && !(detail && going) && <p className="text-fg-4">Nothing said yet.</p>
            )}
          </div>
        </>
      )}
      {turn.note && <p className={`${QUIET} mt-2 break-words`}>{turn.note}</p>}
    </section>
  );
}

/** the end of an answer: its last paragraph or two, with … when there was more */
function tailOf(text: string): string {
  const parts = blocks(text).filter((p) => p.trim());
  const kept = parts.slice(-2).join("\n\n");
  return parts.length > 2 ? `…\n\n${kept}` : kept;
}

/** the files a session wrote that can be looked at, the latest first */
function madeOf(talk: ConversationView | null | undefined): FileMark[] {
  const seen = new Map<string, FileMark>();
  for (const item of [...(talk?.items ?? [])].reverse()) {
    if (item.kind !== "turn") continue;
    for (const o of [...(item.outputs ?? [])].reverse()) {
      if (!o.read && !seen.has(o.path)) seen.set(o.path, o);
    }
  }
  return [...seen.values()].slice(0, 6);
}

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * grove chat on: the panel is the session's card, not its transcript. what it waits on, answerable
 * here with the chat window's own cards, or the end of what it last said. a reply that goes
 * through the same claude the chat window talks to. what it made, and what runs for it. a session
 * live in another app is only pointed at
 */
function SessionCard({
  session,
  talk,
  editor,
}: {
  session: SessionRef;
  talk: ConversationView | null | undefined;
  editor: string;
}) {
  const [host, setHost] = useState<ChatStatus | null>(null);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string>();
  const key = session.key;
  const id = session.sessionId;
  useEffect(() => {
    let live = true;
    void window.grove.sessionHost(key).then((h) => live && setHost(h));
    const off = window.grove.on("chat:host", (p) => {
      if (p.sessionId === id) setHost(p.status);
    });
    return () => {
      live = false;
      off();
    };
  }, [key, id]);

  const elsewhere =
    session.runtime === "vscode"
      ? editor
      : session.runtime === "terminal"
        ? "a terminal"
        : session.runtime === "elsewhere"
          ? "another app"
          : undefined;
  const failed = (o: Outcome<unknown>) => setError(o.ok ? undefined : o.error.message);
  const asks = elsewhere ? [] : (host?.asks ?? []);
  const running = !!host?.running;
  const last = talk?.items.findLast((i): i is TurnView => i.kind === "turn");
  const made = madeOf(talk);
  const agents = (host?.agents ?? []).filter((a) => a.state === "running" && !a.workflow);

  const send = async () => {
    const text = reply.trim();
    if (!text) return;
    // a background agent mid-turn stops when this takes it over: asked first, as Open asks
    const stop = session.runtime === "background" ? session.open.confirm : undefined;
    if (stop && !window.confirm(`${stop.title}\n\n${stop.body}`)) return;
    setReply("");
    const o = await window.grove.sessionReply(key, text);
    failed(o);
    if (!o.ok) setReply(text);
  };

  return (
    // the first thing in it sits at its top: an ask card's own gap is for under a turn
    <div data-testid="session-card" className="[&>section:first-child]:mt-0">
      {elsewhere && (
        <p className={QUIET} data-testid="card-elsewhere">
          Live in {elsewhere}. Answer it there.
        </p>
      )}
      {asks.map((a) => (
        <Ask
          key={a.id}
          ask={a}
          onAnswer={(x) => void window.grove.sessionAnswer(key, a.id, x).then(failed)}
        />
      ))}
      {!elsewhere && running && asks.length === 0 && (
        <div className="flex items-center gap-2" data-testid="card-live">
          <span className="text-sm text-working">Working</span>
          {host?.since !== undefined && <Clock since={host.since} />}
          {host && <LiveLine status={host} className="min-w-0" />}
        </div>
      )}
      {!running && asks.length === 0 && last?.text && (
        <div data-testid="card-tail">
          <h3 className="text-sm font-medium text-fg-4">Claude</h3>
          <div className="selectable mt-1">
            <Markdown text={tailOf(last.text)} />
          </div>
        </div>
      )}
      {!elsewhere && (
        <div className="mt-4">
          <ComposerFrame>
            <div className="flex items-end gap-2 py-1 pr-1.5">
              <textarea
                rows={1}
                value={reply}
                data-reply
                data-composer
                data-testid="card-reply"
                placeholder={running ? "Queue a reply…" : "Reply…"}
                className="no-drag block max-h-32 min-h-8 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-1.5 text-body text-fg placeholder:text-fg-4 [field-sizing:content]"
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  } else if (e.key === "Escape") {
                    // out of the box, and the panel stays: the next Esc closes it
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.blur();
                  }
                }}
              />
              <SendButton
                ready={!!reply.trim()}
                title={running ? "Queue it (Enter)" : "Send (Enter)"}
                aria-label="Send"
                data-testid="card-send"
                onClick={() => void send()}
              />
            </div>
          </ComposerFrame>
        </div>
      )}
      {error && (
        <p className="mt-2 break-words text-sm text-danger" data-testid="card-error">
          {error}
        </p>
      )}
      {made.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5" data-testid="card-made">
          {made.map((o) => (
            <button
              key={o.path}
              type="button"
              title={o.path}
              data-testid="card-file"
              onClick={() => openChat(key, session.title, { file: o.path })}
              className="fade flex h-7 max-w-56 items-center gap-1.5 rounded-md border border-line px-2 text-sm text-fg-2 hover:border-line-strong hover:bg-raised"
            >
              <Icon name="file" size={12} faint />
              <span className="truncate">{nameOf(o.path)}</span>
              {fileKind(o.path) === "image" && <span className="text-fg-4">image</span>}
            </button>
          ))}
        </div>
      )}
      {agents.length > 0 && (
        <button
          type="button"
          data-testid="card-agents"
          onClick={() => openChat(key, session.title, { agents: true })}
          className="fade mt-3 flex min-w-0 max-w-full items-center gap-1.5 text-left text-sm text-fg-3 hover:text-fg"
        >
          <AgentState state="running" word={false} />
          <span className="truncate">
            {agents.length} {agents.length === 1 ? "agent" : "agents"} running ·{" "}
            {agents.map((a) => a.description).join(", ")}
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * a session, beside the list its row is in: a recap of what it was for and what it needs, and
 * under it the conversation, opened at its end. both lists open this one panel. with grove chat on
 * the conversation's place is the session card's
 */
export function SessionPanel({
  session,
  project,
  state,
  at,
  row,
  tasks,
  onClose,
}: {
  session: SessionRef;
  project?: ProjectId;
  state?: SessionState;
  /** when it last moved */
  at: number;
  /** its inbox row, while it needs the person: what Dismiss clears */
  row?: InboxRowView;
  /** what it left running, when anything */
  tasks?: readonly TaskView[];
  onClose: () => void;
}) {
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  const chat = useStore((s) => s.settings?.chat === true);
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
          variant={chat ? "secondary" : "primary"}
          disabled={!!session.open.disabled}
          title={session.open.disabled}
          data-testid="panel-open"
          onClick={() => openWith(session.key, session.open, session.title)}
        >
          {/* one span: the button is a flex row, and two would get its gap between them. beside
              grove chat's Open it always says where */}
          <span>
            Open
            <span className={chat ? undefined : "hidden @md:inline"}> in {editor}</span>
          </span>
        </Button>
        {/* grove chat: the session's own window is the way in, the editor one step away */}
        {chat && (
          <Button
            variant="primary"
            data-testid="panel-chat"
            onClick={() => openChat(session.key, session.title)}
          >
            Open
          </Button>
        )}
      </header>
      {/* what the person reads first stays put over what scrolls, and takes the room it needs:
          the recap matters more. in the shortest window it leaves a strip of what is under it,
          and scrolls by itself past that */}
      <div className="max-h-[calc(100%-11rem)] shrink-0 overflow-y-auto px-4 pt-4 pb-3 @md:px-6 @md:pt-5 @md:pb-4 @xl:px-10">
        {session.description && (
          // what it is for, under its title: the recap under it says where it stands
          <p className="selectable mb-3 break-words text-fg-2" data-testid="panel-description">
            {session.description}
          </p>
        )}
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
        {!!tasks?.length && <Tasks tasks={tasks} />}
        {session.recap && (
          <Recap
            recap={session.recap}
            working={state === "working"}
            goal={!session.description}
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
        {chat && <SessionCard session={session} talk={talk} editor={editor} />}
        {!chat && talk === null && (
          <p className={QUIET} data-testid="panel-gone">
            This session's transcript is gone. Claude Code deletes one after 30 days.
          </p>
        )}
        {!chat && !!talk?.older && (
          <p className={`${QUIET} mb-6`} data-testid="turns-older">
            {talk.older} older {talk.older === 1 ? "turn is" : "turns are"} in {editor}.
          </p>
        )}
        {!chat &&
          talk?.items.map((item, i) =>
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
