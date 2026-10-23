import { type ConversationView, type FileMark, fileKind, type TurnView } from "@grove/core/pure";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import {
  queuedRows,
  type SessionState,
  type TypedStep,
  turnParts,
  workLine,
} from "../logic/views.ts";
import { openChat, openWith, review } from "../state/actions.ts";
import { useChatScope } from "../state/chatScope.ts";
import { type Section, useStore } from "../state/store.ts";
import { Ask } from "./Asks.tsx";
import { Clock, LiveLine } from "./Live.tsx";
import { Markdown } from "./Markdown.tsx";
import { StepFold, StepList, Thought } from "./Steps.tsx";
import {
  Button,
  ComposerFrame,
  CopyButton,
  cx,
  EscButton,
  Icon,
  IconButton,
  Mono,
  ProjectMark,
  PromptBlock,
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

/** what the person typed: plain text, a pasted brief scrolls in place */
const TYPED =
  "selectable mt-1 max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words text-fg-2";

/**
 * one turn: what the person typed, the work in one line, everything said on the way in order (what
 * he typed while it worked too, where claude took it), and the message it ended on. what it said
 * is an agent's and goes through Markdown, what the person typed is plain text. grove chat folds
 * the steps between what was said, the panel leaves them out
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
   * grove chat: the steps between what it said sit folded where they ran, the work line opens
   * them all, and the thinking before the answer sits folded above it. the panel has none of it
   */
  detail?: boolean;
  /** the steps start open: an agent's own transcript, which is opened to see what it did */
  stepsOpen?: boolean;
  /** who the prompt is from: an agent's is what it was asked */
  who?: string;
}) {
  const [open, setOpen] = useState(!!stepsOpen);
  /** the hover actions exist: the pointer or the keyboard came to this turn */
  const [armed, setArmed] = useState(false);
  const scope = useChatScope();
  const p = turn.prompt;
  // the turn it is in now has no end yet, so no length either
  const going = last && working;
  // what the person said: a prompt, or a command with words after it. a bare one says nothing
  // (recap.ts reads them the same way). an agent's prompt is what another agent asked it
  const mine =
    who === "You" && (p?.kind === "human" || (p?.kind === "command" && p.text.includes(" ")));
  // grove chat: what can be done from a message the person typed, on hover. in his block they sit
  // on the raised ground
  const actions = p?.kind === "human" && detail && armed && scope && !going && (
    <div
      className={cx(
        "absolute flex gap-0.5 opacity-0 group-hover/prompt:opacity-100 focus-within:opacity-100",
        mine ? "top-1.5 right-1.5" : "top-0 right-0",
      )}
      data-testid="prompt-actions"
    >
      {scope.fork && p.text && !p.text.endsWith("…") && (
        <IconButton
          label="Edit and send again: a new session from just before this"
          data-testid="prompt-edit"
          raised={mine}
          onClick={() => scope.fork?.(p.parent ?? null, p.text)}
        >
          <Icon name="pencil" size={12} />
        </IconButton>
      )}
      {scope.rewind && p.uuid && (
        <IconButton
          label="Rewind the files to before this"
          data-testid="prompt-rewind"
          raised={mine}
          onClick={() => p.uuid && scope.rewind?.(p.uuid)}
        >
          <Icon name="undo" size={12} />
        </IconButton>
      )}
    </div>
  );
  // the label and the words, in his block or, for an agent, as they always were
  const typedPrompt = p && (
    <>
      {actions}
      {/* in grove chat his label wraps before the buttons */}
      <h3 className={cx("text-sm font-medium text-fg-4", mine && detail && "pr-14")}>
        {who}
        {images && (!!p.images || !!p.files?.length) && (
          <span className="font-normal" data-testid="turn-attached">
            {p.images ? ` · ${p.images} ${p.images === 1 ? "image" : "images"}` : ""}
            {p.files?.map((f) => ` · ${f}`).join("")}
          </span>
        )}
      </h3>
      {/* a pasted brief runs to pages: it scrolls in place, so what the agent said stays near. in
          his block the scrollbar sits in its padding, off the words */}
      <p
        className={cx(TYPED, mine && "-mr-2 pr-2")}
        data-testid={last ? "panel-prompt" : undefined}
      >
        {p.text}
      </p>
    </>
  );
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
  // what was said on the way, each after the steps that led to it: claude's, and his typed while
  // it worked, where it was handed over. claude's last one's place is the panel's text when it has
  // not answered
  const parts = turnParts(turn.steps);
  const said = parts.length - 1;
  const lastText = parts.findLastIndex((x) => x.text !== undefined);
  const folded = detail && parts.some((x) => x.work.some((w) => w.kind === "tool"));
  const firstFold = parts.findIndex((x) => x.work.some((w) => w.kind === "tool"));
  const textId = (i: number) => (last && !turn.text && i === lastText ? "panel-text" : undefined);
  // the last turn always says what the agent said, even when that is nothing yet
  const talks = !!turn.text || !!work || said > 0 || (last && p?.kind !== "command");
  return (
    <section
      className="mt-6 first:mt-0"
      data-testid="turn"
      // grove chat: a turn's hover actions are only made once the pointer or the keyboard comes
      // near it. a hundred turns each with their own buttons cost a window's open ~20ms
      {...(detail && !armed
        ? { onMouseEnter: () => setArmed(true), onFocus: () => setArmed(true) }
        : {})}
    >
      {mine ? (
        <PromptBlock className={cx(detail && "group/prompt")}>{typedPrompt}</PromptBlock>
      ) : p?.kind === "human" ? (
        <div className={cx(detail && "group/prompt relative")}>{typedPrompt}</div>
      ) : (
        // a bare slash command, or Claude Code saying a background task finished: nothing the
        // person said
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
      {talks && (
        <>
          <h3 className="mt-3 text-sm font-medium text-fg-4" data-testid="turn-work">
            Claude
            {folded ? (
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
          {/* nothing said on the way: the work line is the one fold, as it always was */}
          {folded && open && said === 0 && (
            <StepList steps={parts[0]?.work ?? []} before={turn.stepsBefore} going={going} />
          )}
          {said > 0 &&
            parts.map((part, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a turn's parts only grow, in order
              <Fragment key={i}>
                {detail && part.work.length > 0 && (
                  // the work line opens or closes them all: each starts again from it
                  <StepFold
                    key={`${open}`}
                    steps={part.work}
                    before={i === firstFold ? turn.stepsBefore : undefined}
                    going={going}
                    open={open}
                  />
                )}
                {part.text !== undefined && (
                  <div
                    className={detail || i === 0 ? "mt-1" : "mt-2"}
                    data-testid={textId(i) ?? "turn-said"}
                  >
                    <Markdown text={part.text} className={last ? "md-full" : undefined} />
                  </div>
                )}
                {part.typed && <Typed step={part.typed} images={images} />}
              </Fragment>
            ))}
          {detail && turn.thought && <Thought text={turn.thought.text} ms={turn.thought.ms} />}
          <div
            className={cx(!detail && said > 0 ? "mt-2" : "mt-1", detail && "group/answer relative")}
            data-testid={last && (turn.text || lastText < 0) ? "panel-text" : undefined}
          >
            {turn.text ? (
              <Markdown
                text={turn.text}
                className={last ? "md-full" : undefined}
                streaming={going}
              />
            ) : (
              // grove chat says what it is doing under the turn instead
              last &&
              lastText < 0 &&
              !(detail && going) && <p className="text-fg-4">Nothing said yet.</p>
            )}
            {/* grove chat: what can be done with an answer, on hover, in the gap under it */}
            {detail && armed && scope && turn.text && !going && (
              <div
                className="absolute top-full right-0 flex gap-0.5 pt-0.5 opacity-0 group-hover/answer:opacity-100 focus-within:opacity-100"
                data-testid="answer-actions"
              >
                <CopyButton label="Copy answer" text={() => turn.text ?? ""} />
                {scope.fork && turn.end && (
                  <IconButton
                    label="Fork from here: a new session with all of this"
                    data-testid="answer-fork"
                    onClick={() => turn.end && scope.fork?.(turn.end, "")}
                  >
                    <Icon name="branch" size={12} />
                  </IconButton>
                )}
              </div>
            )}
          </div>
        </>
      )}
      {turn.note && (
        <p className={`${QUIET} mt-2 break-words`} data-testid="turn-note">
          {turn.note}
          {/* grove chat: the last turn died on an api error. a prompt cut for the view is not
              offered: it would go out cut */}
          {detail &&
            turn.failed &&
            last &&
            !working &&
            scope?.retry &&
            p?.kind === "human" &&
            !p.text.endsWith("…") && (
              <>
                {" "}
                <Button
                  variant="link"
                  data-testid="turn-retry"
                  onClick={() => scope.retry?.(p.text)}
                >
                  Try again
                </Button>
              </>
            )}
        </p>
      )}
    </section>
  );
}

/** what he typed while it worked, in his block where claude took it */
function Typed({ step, images }: { step: TypedStep; images?: boolean }) {
  return (
    <div className="mt-2" data-testid="turn-typed">
      <PromptBlock>
        <h3 className="text-sm font-medium text-fg-4">
          You, while it worked
          {images && (!!step.images || !!step.files?.length) && (
            <span className="font-normal" data-testid="typed-attached">
              {step.images ? ` · ${step.images} ${step.images === 1 ? "image" : "images"}` : ""}
              {step.files?.map((f) => ` · ${f}`).join("")}
            </span>
          )}
        </h3>
        <p className={cx(TYPED, "-mr-2 pr-2")}>{step.text}</p>
      </PromptBlock>
    </div>
  );
}

/**
 * what was sent while it worked, under the conversation (queuedRows says which). queued: his
 * block's outline until claude takes it, and its one action where a sent one's are. taken: drawn
 * as sent, where it was, until the transcript has it in its place
 */
export function QueuedRows({
  queued,
  onUnqueue,
}: {
  queued: ChatStatus["queued"];
  /** taken back before claude gets to it: grove chat's only */
  onUnqueue?: (q: ChatStatus["queued"][number]) => void;
}) {
  return queued.map((q) => (
    <div
      key={q.id}
      className="group/queued mt-3"
      data-testid="chat-queued"
      data-taken={q.taken ? "" : undefined}
    >
      <PromptBlock queued={!q.taken}>
        {!q.taken && onUnqueue && (
          <IconButton
            label="Take back"
            data-testid="chat-unqueue"
            className="absolute top-1.5 right-1.5 opacity-0 group-hover/queued:opacity-100 focus-visible:opacity-100"
            onClick={() => onUnqueue(q)}
          >
            <Icon name="x" size={10} />
          </IconButton>
        )}
        <h3 className={cx("text-sm font-medium text-fg-4", !q.taken && onUnqueue && "pr-8")}>
          {q.taken ? "You, while it worked" : "You, queued"}
        </h3>
        <p
          className={cx(
            "selectable mt-1 whitespace-pre-wrap break-words",
            q.taken ? "text-fg-2" : "text-fg-3",
          )}
        >
          {q.text}
        </p>
      </PromptBlock>
    </div>
  ));
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
  const queued = queuedRows(host?.queued ?? [], talk);
  const running = !!host?.running;
  const last = talk?.items.findLast((i): i is TurnView => i.kind === "turn");
  // the end of what it last said: its answer, or what it said before it stopped without one
  const lastSaid =
    last?.text || last?.steps?.flatMap((x) => (x.kind === "text" ? [x.text] : [])).at(-1);
  const made = madeOf(talk);
  // what runs for it: agents and workflows, not a workflow's own agents
  const agents = (host?.agents ?? []).filter((a) => a.state === "running" && !a.workflow);
  const lastPrompt = talk?.items.findLast(
    (i): i is TurnView => i.kind === "turn" && i.prompt?.kind === "human",
  )?.prompt?.text;

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
    // one gap between its parts. an ask card's own gap is for under a turn
    <div data-testid="session-card" className="flex flex-col gap-4 [&>section]:mt-0">
      {elsewhere && (
        <p className={QUIET} data-testid="card-elsewhere">
          Live in {elsewhere}. Answer it there.
        </p>
      )}
      {asks.map((a) => (
        <Ask
          key={a.id}
          ask={a}
          modes={host?.modes ?? []}
          onAnswer={(x) => void window.grove.sessionAnswer(key, a.id, x).then(failed)}
          // a refusal's "Edit what you asked": it goes back in the reply box
          onEditPrompt={() => lastPrompt && setReply(lastPrompt)}
        />
      ))}
      {!elsewhere && running && asks.length === 0 && (
        // what the chat window's header and live line say, in the same words
        <div data-testid="card-live">
          <span className="flex items-center gap-1.5">
            <StateLabel state="working" within="panel" />
            {host?.since !== undefined && <Clock since={host.since} />}
          </span>
          {host && <LiveLine status={host} className="mt-1" />}
        </div>
      )}
      {!running && asks.length === 0 && lastSaid && (
        <div data-testid="card-tail">
          <h3 className="text-sm font-medium text-fg-4">Claude</h3>
          <div className="selectable mt-1">
            <Markdown text={tailOf(lastSaid)} />
          </div>
        </div>
      )}
      {!elsewhere && host && queued.length > 0 && (
        // what was sent while it works, as the chat window has it: taken back from there
        <div className="[&>div:first-child]:mt-0" data-testid="card-queued">
          <QueuedRows queued={queued} />
        </div>
      )}
      {!elsewhere && (
        <div>
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
          {error && (
            <p className="mt-2 break-words text-sm text-danger" data-testid="card-error">
              {error}
            </p>
          )}
        </div>
      )}
      {made.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="card-made">
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
          className="fade flex min-w-0 max-w-full items-center gap-1.5 self-start text-left text-sm text-fg-3 hover:text-fg"
        >
          <TaskMark />
          <span className="truncate">
            {agents.length} running · {agents.map((a) => a.description).join(", ")}
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
        {/* what is read grows with the text size. Dismiss is the panel's own button, and stays */}
        <div className="reading">
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
        </div>
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
