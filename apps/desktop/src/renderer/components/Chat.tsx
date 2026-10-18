// grove chat's window: one session, its conversation in a reading column, the composer under it.
// the transcript is what is drawn, as in the panel. the host adds what is not in it yet: the
// answer being streamed, and what the agent is waiting on the person for.
import { modelLabel, type TurnView } from "@grove/core/pure";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ChatAnswer,
  ChatAsk,
  ChatConversation,
  ChatStatus,
  ChatTarget,
  Outcome,
} from "../../shared/ipc.ts";
import { applyAppearance } from "../state/appearance.ts";
import { ChatScopeContext } from "../state/chatScope.ts";
import { useStore } from "../state/store.ts";
import { FileList, OutputCards, Viewer } from "./Files.tsx";
import { Markdown } from "./Markdown.tsx";
import { QUIET, Turn } from "./SessionPanel.tsx";
import {
  AskCard,
  Button,
  Choice,
  cx,
  Icon,
  IconButton,
  ModePill,
  Mono,
  ProjectMark,
  Select,
  Spinner,
  StateLabel,
} from "./ui.tsx";

const api = () => window.grove;

/** the reading column, and the composer under it at the same width */
const COLUMN = "mx-auto w-full max-w-[760px] px-6";

/** what the window sent, until the transcript has it: a prompt's start is enough to know it */
const same = (a: string, b: string) => a.trim().slice(0, 200) === b.trim().slice(0, 200);

/** a refusal from main, as the line over the composer says it */
const failed = (o: Outcome<unknown>): string | undefined => (o.ok ? undefined : o.error.message);

function QuestionCard({
  ask,
  onAnswer,
}: {
  ask: Extract<ChatAsk, { kind: "question" }>;
  onAnswer: (a: ChatAnswer) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  // one question that takes one pick: a click on it is the answer
  const quick = ask.questions.length === 1 && !ask.questions[0]?.multiSelect;
  const answerOf = (q: string) => [...(picked[q] ?? []), ...(other[q]?.trim() ? [other[q]] : [])];
  const send = (answers: Record<string, string>) => onAnswer({ kind: "question", answers });
  const complete = ask.questions.every((q) => answerOf(q.question).length > 0);
  return (
    <AskCard label="Claude asks" testId="ask-question">
      {ask.questions.map((q) => (
        <div key={q.question} className="mt-2">
          <p className="selectable text-fg">{q.question}</p>
          <div className="mt-2 space-y-1.5">
            {q.options.map((o) => {
              const on = picked[q.question]?.includes(o.label) ?? false;
              return (
                <Choice
                  key={o.label}
                  picked={on}
                  data-testid="ask-option"
                  onClick={() => {
                    if (quick) return send({ [q.question]: o.label });
                    const was = picked[q.question] ?? [];
                    const next = q.multiSelect
                      ? on
                        ? was.filter((l) => l !== o.label)
                        : [...was, o.label]
                      : [o.label];
                    setPicked({ ...picked, [q.question]: next });
                  }}
                >
                  <span className="block font-medium">{o.label}</span>
                  {o.description && (
                    <span className="block text-sm text-fg-3">{o.description}</span>
                  )}
                </Choice>
              );
            })}
            <input
              className="no-drag h-8 w-full rounded-md border border-line-strong bg-canvas px-3 text-body text-fg placeholder:text-fg-4"
              placeholder="Something else…"
              data-testid="ask-other"
              value={other[q.question] ?? ""}
              onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && quick && e.currentTarget.value.trim()) {
                  send({ [q.question]: e.currentTarget.value.trim() });
                }
              }}
            />
          </div>
        </div>
      ))}
      {!quick && (
        <Button
          variant="primary"
          className="mt-3"
          disabled={!complete}
          data-testid="ask-send"
          onClick={() =>
            send(
              Object.fromEntries(
                ask.questions.map((q) => [q.question, answerOf(q.question).join(", ")]),
              ),
            )
          }
        >
          Answer
        </Button>
      )}
    </AskCard>
  );
}

function PlanCard({
  ask,
  onAnswer,
}: {
  ask: Extract<ChatAsk, { kind: "plan" }>;
  onAnswer: (a: ChatAnswer) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <AskCard label="Claude's plan" testId="ask-plan">
      <div className="selectable mt-2">
        <Markdown text={ask.plan} className="md-full" />
      </div>
      <textarea
        className="no-drag mt-3 w-full resize-none rounded-md border border-line-strong bg-canvas px-3 py-2 text-body text-fg placeholder:text-fg-4 [field-sizing:content]"
        placeholder="What should change? (for Keep planning)"
        rows={1}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <Button
          variant="primary"
          data-testid="plan-approve"
          onClick={() => onAnswer({ kind: "plan", approve: true })}
        >
          Approve
        </Button>
        <Button
          data-testid="plan-keep"
          onClick={() => onAnswer({ kind: "plan", approve: false, message: note })}
        >
          Keep planning
        </Button>
      </div>
    </AskCard>
  );
}

function PermissionCard({
  ask,
  onAnswer,
}: {
  ask: Extract<ChatAsk, { kind: "permission" }>;
  onAnswer: (a: ChatAnswer) => void;
}) {
  return (
    <AskCard label={`Claude wants to use ${ask.tool}`} testId="ask-permission">
      {ask.title && <p className="selectable mt-1 text-fg">{ask.title}</p>}
      <Mono className="selectable mt-2 block max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-canvas px-3 py-2 text-fg-2">
        {ask.detail}
      </Mono>
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          data-testid="permission-allow"
          onClick={() => onAnswer({ kind: "permission", allow: "once" })}
        >
          Allow
        </Button>
        {ask.canAlways && (
          <Button onClick={() => onAnswer({ kind: "permission", allow: "always" })}>
            Always allow
          </Button>
        )}
        <Button
          variant="ghost"
          data-testid="permission-deny"
          onClick={() => onAnswer({ kind: "permission", allow: "no" })}
        >
          Deny
        </Button>
      </div>
    </AskCard>
  );
}

function Ask({ ask, onAnswer }: { ask: ChatAsk; onAnswer: (a: ChatAnswer) => void }) {
  if (ask.kind === "question") return <QuestionCard ask={ask} onAnswer={onAnswer} />;
  if (ask.kind === "plan") return <PlanCard ask={ask} onAnswer={onAnswer} />;
  return <PermissionCard ask={ask} onAnswer={onAnswer} />;
}

/** the window of one session. its page has no list and no landing: main says which session */
export function ChatApp() {
  const [target, setTarget] = useState<ChatTarget | null>();
  /** main gave this window a session: a null target now means it has gone */
  const [opened, setOpened] = useState(false);
  const [status, setStatus] = useState<ChatStatus>();
  /** null: the transcript is gone. undefined: not read yet */
  const [talk, setTalk] = useState<ChatConversation | null>();
  /** beside the conversation: the session's files, or one of them. closed when the window opens */
  const [pane, setPane] = useState<{ file?: string } | null>(null);
  /** the answer as main streams it, and as it is drawn: see `reading` */
  const stream = useRef("");
  const [shown, setShown] = useState("");
  /** a read of the transcript is under way: a finished message waits for it, so it never blinks */
  const reading = useRef(false);
  const again = useRef(false);
  /** what this window sent while nothing ran, until the transcript has it */
  const [sent, setSent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const last = useRef("");
  const warmed = useRef(false);
  const [error, setError] = useState<string>();
  /** what main said that is not a failure: when it will open in the editor */
  const [note, setNote] = useState<string>();
  const [moving, setMoving] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);

  const read = useCallback(async () => {
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    try {
      const t = await api()
        .chatConversation()
        .catch(() => null);
      setTalk(t);
    } finally {
      reading.current = false;
      // what streamed while it read, or nothing when the message it was writing is in it now
      setShown(stream.current);
      if (again.current) {
        again.current = false;
        void read();
      }
    }
  }, []);

  const load = useCallback(async () => {
    const t = await api()
      .chatTarget()
      .catch(() => null);
    setTarget(t);
    if (!t) return;
    setStatus(t.status);
    stream.current = t.text;
    setShown(t.text);
    applyAppearance(t.appearance);
    document.title = t.session.title;
    void read();
  }, [read]);

  useEffect(() => {
    // the project marks' colours and the editor's name come from what the main window has
    void api()
      .bootstrap()
      .then((b) => useStore.getState().set({ projects: b.projects, editor: b.editor }))
      .catch(() => {});
    void load();
    const offs = [
      api().on("chat:open", () => {
        setOpened(true);
        setSent(null);
        setPane(null);
        void load();
      }),
      api().on("chat:status", (s) => setStatus(s)),
      api().on("chat:text", ({ at, text }) => {
        stream.current = stream.current.slice(0, at) + text;
        // a message that just finished is drawn until the transcript that has it is read
        if (stream.current || !reading.current) setShown(stream.current);
      }),
    ];
    const onCsp = (e: SecurityPolicyViolationEvent) =>
      void api().reportCspViolation(`${e.violatedDirective} ${e.blockedURI}`);
    document.addEventListener("securitypolicyviolation", onCsp);
    return () => {
      for (const off of offs) off();
      document.removeEventListener("securitypolicyviolation", onCsp);
    };
  }, [load]);

  // cmd-shift-Enter is the editor, as it is on a list in the main window
  const editorKey = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        editorKey.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // the transcript moved: a message finished, a tool answered, the turn ended
  const rev = status?.rev;
  useEffect(() => {
    if (rev !== undefined && rev > 0) void read();
  }, [rev, read]);

  // the transcript has the prompt now
  useEffect(() => {
    if (!sent || !talk) return;
    const turn = talk.items.findLast((i): i is TurnView => i.kind === "turn");
    if (turn?.prompt && same(turn.prompt.text, sent)) setSent(null);
  }, [talk, sent]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: these are when to scroll, not what is read
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [talk, shown, sent, status?.asks.length, status?.queued.length]);

  if (target === undefined) return <div className="drag h-full bg-canvas" />;
  if (!target) {
    return (
      <div className="drag flex h-full items-center justify-center bg-canvas" data-testid="chat">
        {opened && <p className={QUIET}>This session is no longer in Grove's list.</p>}
      </div>
    );
  }

  const s = status ?? target.status;
  const session = target.session;
  const running = s.running;
  const readOnly = target.readOnly;

  const items = talk?.items ?? [];
  const lastTurn = items.findLast((i): i is TurnView => i.kind === "turn");
  const pending = sent && !(lastTurn?.prompt && same(lastTurn.prompt.text, sent)) ? sent : null;
  const rows = [
    ...items,
    ...(pending
      ? [
          {
            kind: "turn",
            prompt: { kind: "human", text: pending },
            tools: 0,
            files: 0,
            agents: 0,
          } satisfies TurnView,
        ]
      : []),
  ];
  // the turn it is in: what it is writing now, before the transcript has it
  const end = rows.length - 1;
  const tail = rows[end];
  if (running && shown && tail?.kind === "turn") rows[end] = { ...tail, text: shown };

  const warm = () => {
    if (warmed.current || readOnly || s.live || s.starting) return;
    warmed.current = true;
    void api()
      .chatWarm()
      .then((o) => {
        if (!o.ok) setError(o.error.message);
      });
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || readOnly) return;
    // a background agent mid-turn stops when this takes it over: asked first, as Open asks
    const stop = session.runtime === "background" ? session.open.confirm : undefined;
    if (stop && !window.confirm(`${stop.title}\n\n${stop.body}`)) return;
    setError(undefined);
    setDraft("");
    last.current = text;
    if (!running) setSent(text);
    atEnd.current = true;
    const res = await api().chatSend(text);
    const why = failed(res);
    if (why) {
      setError(why);
      setSent(null);
      setDraft(text);
    }
  };

  const answer = async (askId: string, a: ChatAnswer) => {
    setError(failed(await api().chatAnswer(askId, a)));
    composer.current?.focus();
  };

  const stepMode = async () => {
    // the mode it starts in is the settings', known once claude is up: the first press starts it
    if (!s.live) return warm();
    const modes = s.modes;
    const next = modes[(modes.indexOf(s.mode ?? "default") + 1) % modes.length];
    if (next) setError(failed(await api().chatSetMode(next)));
  };

  const openInEditor = async (when: "now" | "after") => {
    setMoving(false);
    const res = await api().chatOpenInEditor(when);
    if (res.ok) setNote(res.value.message);
    else setError(res.error.message);
  };

  const toEditor = () => (running ? setMoving(!moving) : void openInEditor("now"));
  editorKey.current = toEditor;
  const scope = {
    session: session.sessionId,
    base: target.cwd,
    open: (file: string) => setPane({ file }),
  };

  return (
    <div
      className="@container flex h-full flex-col bg-canvas"
      data-testid="chat"
      data-id={session.sessionId}
    >
      {/* the traffic lights sit in the first 76px */}
      <header className="drag flex h-12 shrink-0 items-center gap-2.5 border-b border-line pr-3 pl-20">
        {target.project && <ProjectMark id={target.project} />}
        <h1 className="min-w-0 flex-1 truncate font-semibold" title={session.title}>
          {session.title}
        </h1>
        {s.asks.length > 0 ? (
          <StateLabel state="turn" within="panel" />
        ) : (
          running && <StateLabel state="working" within="panel" />
        )}
        {/* the mode is the settings', known once claude is up. shift-tab starts it before that */}
        {!readOnly && s.live && (
          <ModePill
            mode={s.mode}
            title="Permission mode (shift-tab)"
            data-testid="chat-mode"
            onClick={() => void stepMode()}
          />
        )}
        {!readOnly && s.models.length > 0 && (
          <Select
            wrapClassName="w-36 shrink-0"
            className="h-6 text-sm"
            value={s.models.find((m) => m.value === s.model || m.id === s.model)?.value ?? ""}
            data-testid="chat-model"
            onChange={(e) =>
              void api()
                .chatSetModel(e.target.value)
                .then((o) => setError(failed(o)))
            }
          >
            {!s.models.some((m) => m.value === s.model || m.id === s.model) && (
              <option value="">{s.model ? modelLabel(s.model) : "Model"}</option>
            )}
            {s.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        )}
        <Button size="sm" data-testid="chat-open-editor" title="cmd-shift-Enter" onClick={toEditor}>
          Open in {target.editor}
        </Button>
        <IconButton
          label="Files"
          aria-pressed={!!pane}
          data-testid="chat-files"
          className={cx(pane && "bg-raised text-fg")}
          onClick={() => setPane(pane ? null : {})}
        >
          <Icon name="file" />
        </IconButton>
      </header>
      {moving && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-raised px-4 py-2"
          data-testid="chat-move"
        >
          <span className="min-w-0 flex-1 text-sm text-fg-2">
            Claude is in the middle of a turn. One app runs a session at a time.
          </span>
          <Button size="sm" data-testid="move-now" onClick={() => void openInEditor("now")}>
            Stop the turn and move
          </Button>
          <Button size="sm" data-testid="move-after" onClick={() => void openInEditor("after")}>
            Move when it finishes
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMoving(false)}>
            Cancel
          </Button>
        </div>
      )}
      <ChatScopeContext.Provider value={scope}>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              ref={scroller}
              className="min-h-0 flex-1 overflow-y-auto"
              data-testid="conversation"
              onScroll={(e) => {
                const el = e.currentTarget;
                atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
            >
              <div className={cx(COLUMN, "pt-6 pb-8")}>
                {session.description && (
                  <p
                    className="selectable mb-6 break-words text-fg-2"
                    data-testid="chat-description"
                  >
                    {session.description}
                  </p>
                )}
                {talk === null && !pending && (
                  <p className={QUIET} data-testid="chat-gone">
                    This session's transcript is not there. Claude Code deletes one after 30 days.
                  </p>
                )}
                {!!talk?.older && (
                  <p className={`${QUIET} mb-6`}>
                    {talk.older} older {talk.older === 1 ? "turn is" : "turns are"} in{" "}
                    {target.editor}.
                  </p>
                )}
                {rows.map((item, i) =>
                  item.kind === "compact" ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a transcript only grows, so a turn's number in it is its key
                    <p key={(talk?.older ?? 0) + i} className={`${QUIET} mt-6`}>
                      Compacted: what came before was summarised.
                    </p>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a transcript only grows, so a turn's number in it is its key
                    <div key={(talk?.older ?? 0) + i}>
                      <Turn turn={item} last={i === end} working={running} />
                      {item.outputs && <OutputCards outputs={item.outputs} />}
                    </div>
                  ),
                )}
                {running && s.tool && (
                  <p
                    className={cx(QUIET, "mt-2 flex items-center gap-1.5")}
                    data-testid="chat-tool"
                  >
                    <Spinner size={10} />
                    {s.tool}
                  </p>
                )}
                {s.asks.map((a) => (
                  <Ask key={a.id} ask={a} onAnswer={(x) => void answer(a.id, x)} />
                ))}
                {s.queued.map((q, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: two sends can be the same words
                  <div key={i} className="mt-3" data-testid="chat-queued">
                    <h3 className="text-sm font-medium text-fg-4">You, queued</h3>
                    <p className="selectable mt-1 whitespace-pre-wrap break-words text-fg-2">{q}</p>
                  </div>
                ))}
              </div>
            </div>
            <footer className="shrink-0 border-t border-line">
              <div className={cx(COLUMN, "py-3")}>
                {note && !error && (
                  <p className="mb-2 text-sm text-fg-3" data-testid="chat-note">
                    {note}
                  </p>
                )}
                {(error || s.error) && (
                  <p className="mb-2 break-words text-sm text-danger" data-testid="chat-error">
                    {error ?? s.error}
                  </p>
                )}
                {readOnly ? (
                  <p className="text-fg-3" data-testid="chat-readonly">
                    {readOnly}
                  </p>
                ) : (
                  <>
                    <textarea
                      ref={composer}
                      // the window is opened to write in
                      autoFocus
                      rows={1}
                      value={draft}
                      placeholder={running ? "Queue a message…" : "Message Claude…"}
                      data-testid="composer"
                      className="no-drag max-h-[40vh] min-h-9 w-full resize-none rounded-lg border border-line-strong bg-canvas px-3 py-2 text-body text-fg placeholder:text-fg-4 [field-sizing:content]"
                      onChange={(e) => {
                        setDraft(e.target.value);
                        // the first keystroke starts claude, so the send does not wait for it
                        warm();
                      }}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void send();
                        } else if (e.key === "Escape" && running) {
                          e.preventDefault();
                          void api().chatInterrupt();
                        } else if (e.key === "ArrowUp" && !draft && last.current) {
                          e.preventDefault();
                          setDraft(last.current);
                        } else if (e.key === "Tab" && e.shiftKey) {
                          e.preventDefault();
                          void stepMode();
                        }
                      }}
                    />
                    <p className="mt-1.5 flex items-center gap-1 text-meta text-fg-4">
                      {s.starting && <Spinner size={10} />}
                      {s.starting
                        ? "Starting Claude…"
                        : running
                          ? "Esc stops the turn. What you send now waits for it."
                          : "Enter sends, Shift-Enter is a new line, Shift-Tab changes the mode."}
                    </p>
                  </>
                )}
              </div>
            </footer>
          </div>
          {pane?.file ? (
            <Viewer file={pane.file} onList={() => setPane({})} onClose={() => setPane(null)} />
          ) : (
            pane && (
              <FileList written={talk?.written ?? []} rev={s.rev} onClose={() => setPane(null)} />
            )
          )}
        </div>
      </ChatScopeContext.Provider>
    </div>
  );
}
