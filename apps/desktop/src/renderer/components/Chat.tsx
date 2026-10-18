// grove chat's window: one session, its conversation in a reading column, the composer under it.
// the transcript is what is drawn, as in the panel. the host adds what is not in it yet: the
// answer being streamed, and what the agent is waiting on the person for.
import { modelLabel, type TurnView } from "@grove/core/pure";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ChatAnswer,
  ChatAsk,
  ChatConversation,
  ChatImage,
  ChatMode,
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
import { useSuggest } from "./Suggest.tsx";
import {
  AskCard,
  Button,
  Choice,
  ComposerFrame,
  cx,
  Icon,
  IconButton,
  Menu,
  MODE_HINT,
  MODE_WORD,
  ModeDot,
  Mono,
  ProjectMark,
  Select,
  SendButton,
  Spinner,
  StateLabel,
  ToolbarButton,
} from "./ui.tsx";

const api = () => window.grove;

/** the reading column, and the composer under it at the same width */
const COLUMN = "mx-auto w-full max-w-[760px] px-6";

/** what the window sent, until the transcript has it: a prompt's start is enough to know it */
const same = (a: string, b: string) => a.trim().slice(0, 200) === b.trim().slice(0, 200);

/** what the api takes, and its limit: 5MB an image */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_MAX = 5 * 1024 * 1024;

type Pasted = ChatImage & { url: string };

/** the images among pasted or dropped files, read as the api takes them */
async function imagesOf(files: FileList | null | undefined): Promise<Pasted[] | string> {
  const picked = [...(files ?? [])].filter((f) => IMAGE_TYPES.has(f.type));
  if (picked.some((f) => f.size > IMAGE_MAX)) return "An image can be 5 MB at most.";
  return Promise.all(
    picked.map(
      (f) =>
        new Promise<Pasted>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => {
            const url = String(r.result);
            resolve({
              mediaType: f.type as ChatImage["mediaType"],
              data: url.slice(url.indexOf(",") + 1),
              url,
            });
          };
          r.onerror = () => reject(r.error);
          r.readAsDataURL(f);
        }),
    ),
  );
}

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
  /** where the caret is in the draft: what `/` and `@` look at */
  const [caret, setCaret] = useState(0);
  /** images pasted or dropped, sent with the next message */
  const [images, setImages] = useState<Pasted[]>([]);
  /** how many images went with what this window sent, until the transcript has it */
  const [sentImages, setSentImages] = useState(0);
  /** bumped each time main hands the window a session */
  const [openings, setOpenings] = useState(0);
  const last = useRef("");
  const warmed = useRef(false);
  const [error, setError] = useState<string>();
  /** what main said that is not a failure: when it will open in the editor */
  const [note, setNote] = useState<string>();
  const [moving, setMoving] = useState(false);
  /** the toolbar menu that is open, and the button it opens from */
  const [menu, setMenu] = useState<{ kind: "mode"; anchor: DOMRect } | null>(null);
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
        setOpenings((n) => n + 1);
        void load();
      }),
      api().on("chat:status", (s) => setStatus(s)),
      api().on("chat:appearance", ({ appearance }) => applyAppearance(appearance)),
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

  // cmd-shift-Enter is the editor, as it is on a list in the main window. Esc closes the files
  // pane, unless the composer took it to stop a turn
  const editorKey = useRef<() => void>(() => {});
  const paneOpen = useRef(false);
  paneOpen.current = !!pane;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        editorKey.current();
      } else if (e.key === "Escape" && !e.defaultPrevented && paneOpen.current) {
        e.preventDefault();
        setPane(null);
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

  const suggest = useSuggest({
    text: draft,
    caret,
    live: !!status?.live,
    opened: openings,
    onPick: (text, at) => {
      setDraft(text);
      setCaret(at);
      placeCaret.current = at;
    },
  });

  // a pick put words in the middle of the message: the caret goes after them as soon as they are
  // drawn, before the next key can land somewhere else
  const placeCaret = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is when, not what
  useLayoutEffect(() => {
    if (placeCaret.current === null) return;
    composer.current?.setSelectionRange(placeCaret.current, placeCaret.current);
    placeCaret.current = null;
  }, [draft]);

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
  const pending =
    sent !== null && !(lastTurn?.prompt && same(lastTurn.prompt.text, sent)) ? sent : null;
  const rows = [
    ...items,
    ...(pending !== null
      ? [
          {
            kind: "turn",
            prompt: {
              kind: "human",
              text: pending,
              ...(sentImages ? { images: sentImages } : {}),
            },
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
    const pasted = images;
    if ((!text && pasted.length === 0) || readOnly) return;
    // a background agent mid-turn stops when this takes it over: asked first, as Open asks
    const stop = session.runtime === "background" ? session.open.confirm : undefined;
    if (stop && !window.confirm(`${stop.title}\n\n${stop.body}`)) return;
    setError(undefined);
    setDraft("");
    setImages([]);
    if (text) last.current = text;
    if (!running) {
      setSent(text);
      setSentImages(pasted.length);
    }
    atEnd.current = true;
    const res = await api().chatSend(
      text,
      pasted.map(({ mediaType, data }) => ({ mediaType, data })),
    );
    const why = failed(res);
    if (why) {
      setError(why);
      setSent(null);
      setDraft(text);
      setImages(pasted);
    }
  };

  const addImages = async (files: FileList | null | undefined) => {
    const got = await imagesOf(files).catch(() => "That image could not be read.");
    if (typeof got === "string") return setError(got);
    if (got.length === 0) return;
    setImages((was) => [...was, ...got]);
    warm();
  };

  const answer = async (askId: string, a: ChatAnswer) => {
    setError(failed(await api().chatAnswer(askId, a)));
    composer.current?.focus();
  };

  const openMenu = (kind: "mode", el: HTMLElement) => {
    if (menu?.kind === kind) return setMenu(null);
    setMenu({ kind, anchor: el.getBoundingClientRect() });
    // the rows are claude's: opening the menu starts it, as shift-tab does
    warm();
  };

  const closeMenu = () => {
    setMenu(null);
    composer.current?.focus();
  };

  const pickMode = async (mode: ChatMode) => {
    closeMenu();
    if (mode !== s.mode) setError(failed(await api().chatSetMode(mode)));
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
        {/* a new session has nothing to open in the editor until it has said something */}
        {!target.fresh && (
          <Button
            size="sm"
            data-testid="chat-open-editor"
            title="cmd-shift-Enter"
            onClick={toEditor}
          >
            Open in {target.editor}
          </Button>
        )}
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
                {target.fresh && pending === null && (
                  <p className={QUIET} data-testid="chat-fresh">
                    A new session in {session.where}. Claude starts as you type, with the project's
                    settings.
                  </p>
                )}
                {talk === null && pending === null && !target.fresh && (
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
                    <div key={(talk?.older ?? 0) + i} className="mt-6 first:mt-0">
                      <Turn turn={item} last={i === end} working={running} images />
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
            <footer
              className="shrink-0"
              onDragOver={(e) => {
                if (!readOnly) e.preventDefault();
              }}
              onDrop={(e) => {
                if (readOnly) return;
                e.preventDefault();
                void addImages(e.dataTransfer.files);
              }}
            >
              <div className={cx(COLUMN, "relative py-3")}>
                {suggest.menu}
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
                  <ComposerFrame>
                    {images.length > 0 && (
                      <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="composer-images">
                        {images.map((img, i) => (
                          <div
                            // biome-ignore lint/suspicious/noArrayIndexKey: the same image can be pasted twice
                            key={i}
                            className="group relative overflow-hidden rounded-md border border-line"
                          >
                            <img
                              src={img.url}
                              alt="Pasted"
                              className="block h-14 w-auto max-w-40"
                            />
                            <IconButton
                              label="Remove"
                              className="absolute top-0.5 right-0.5 bg-overlay opacity-0 group-hover:opacity-100"
                              onClick={() => setImages(images.filter((_, j) => j !== i))}
                            >
                              <Icon name="x" size={10} />
                            </IconButton>
                          </div>
                        ))}
                      </div>
                    )}
                    <textarea
                      ref={composer}
                      // the window is opened to write in
                      autoFocus
                      rows={1}
                      value={draft}
                      placeholder={running ? "Queue a message…" : "Message Claude…"}
                      data-testid="composer"
                      className="no-drag block max-h-[40vh] min-h-9 w-full resize-none border-0 bg-transparent px-3 pt-2.5 pb-1 text-body text-fg placeholder:text-fg-4 [field-sizing:content]"
                      data-composer
                      onChange={(e) => {
                        setDraft(e.target.value);
                        setCaret(e.target.selectionStart);
                        // the first keystroke starts claude, so the send does not wait for it
                        warm();
                      }}
                      onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                      onPaste={(e) => {
                        const files = e.clipboardData.files;
                        if (![...files].some((f) => f.type.startsWith("image/"))) return;
                        // a screenshot is only an image. a copy from a page that has words too
                        // pastes its words as well
                        if (!e.clipboardData.getData("text/plain")) e.preventDefault();
                        void addImages(files);
                      }}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (suggest.onKey(e)) {
                          e.preventDefault();
                          return;
                        }
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
                    <div
                      className="flex h-10 items-center gap-1.5 px-2"
                      data-testid="composer-toolbar"
                    >
                      {/* the mode is the settings', known once claude is up: opening the menu starts it */}
                      <ToolbarButton
                        title="Permission mode (Shift-Tab)"
                        aria-haspopup="menu"
                        aria-expanded={menu?.kind === "mode"}
                        data-testid="chat-mode"
                        data-mode={s.mode}
                        onClick={(e) => openMenu("mode", e.currentTarget)}
                      >
                        <ModeDot mode={s.mode} />
                        {s.mode ? MODE_WORD[s.mode] : "Mode"}
                        <Icon name="chevron" size={9} className="rotate-90" faint />
                      </ToolbarButton>
                      {s.models.length > 0 && (
                        <Select
                          wrapClassName="w-36 shrink-0"
                          className="h-6 text-sm"
                          value={
                            s.models.find((m) => m.value === s.model || m.id === s.model)?.value ??
                            ""
                          }
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
                      <span className="flex-1" />
                      {s.starting && (
                        <span
                          className="flex items-center gap-1.5 text-sm text-fg-4"
                          data-testid="chat-starting"
                        >
                          <Spinner size={10} />
                          Starting Claude…
                        </span>
                      )}
                      <SendButton
                        ready={!!draft.trim() || images.length > 0}
                        title="Send (Enter). Shift-Enter is a new line"
                        aria-label="Send"
                        data-testid="chat-send"
                        onClick={() => void send()}
                      />
                    </div>
                  </ComposerFrame>
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
      {menu?.kind === "mode" && (
        <Menu
          anchor={menu.anchor}
          testId="mode-menu"
          width={340}
          onClose={closeMenu}
          onPick={(m) => void pickMode(m as ChatMode)}
          footer="Shift-Tab to switch"
          items={
            s.live
              ? s.modes.map((m) => ({
                  key: m,
                  label: MODE_WORD[m],
                  description: MODE_HINT[m],
                  checked: m === s.mode,
                  mark: <ModeDot mode={m} />,
                }))
              : []
          }
        >
          {!s.live && (
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-sm text-fg-4">
              {s.error ?? (
                <>
                  <Spinner size={10} />
                  Starting Claude…
                </>
              )}
            </p>
          )}
        </Menu>
      )}
    </div>
  );
}
