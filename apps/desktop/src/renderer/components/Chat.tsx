// grove chat's window: one session, its conversation in a reading column, the composer under it.
// the transcript is what is drawn, as in the panel. the host adds what is not in it yet: the
// answer being streamed, and what the agent is waiting on the person for.
import { modelLabel, type TurnView } from "@grove/core/pure";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ChatAgent,
  ChatAnswer,
  ChatAttachment,
  ChatConversation,
  ChatMode,
  ChatNote,
  ChatStatus,
  ChatTarget,
  Outcome,
} from "../../shared/ipc.ts";
import { attachKind, bytes } from "../logic/attach.ts";
import { type ChatAction, keysLabel, pressed } from "../logic/chatKeys.ts";
import { applyAppearance } from "../state/appearance.ts";
import { ChatScopeContext } from "../state/chatScope.ts";
import { useStore } from "../state/store.ts";
import { AgentList, AgentViewer } from "./Agents.tsx";
import { Ask } from "./Asks.tsx";
import { CommandPalette, ShortcutSheet } from "./ChatPalette.tsx";
import { FileList, OutputCards, Viewer } from "./Files.tsx";
import { Clock, LiveLine } from "./Live.tsx";
import { QUIET, Turn } from "./SessionPanel.tsx";
import { useSuggest } from "./Suggest.tsx";
import {
  AgentState,
  Button,
  ComposerFrame,
  cx,
  DropOverlay,
  EFFORT_WORD,
  Icon,
  IconButton,
  Menu,
  MODE_HINT,
  MODE_WORD,
  ModeDot,
  ProjectMark,
  Segmented,
  SendButton,
  Spinner,
  StateLabel,
  Switch,
  ToolbarButton,
  UltraChip,
} from "./ui.tsx";

const api = () => window.grove;

/** the reading column, and the composer under it at the same width */
const COLUMN = "mx-auto w-full max-w-[760px] px-6";

/** what the window sent, until the transcript has it: a prompt's start is enough to know it */
const same = (a: string, b: string) => a.trim().slice(0, 200) === b.trim().slice(0, 200);

/** grove's caps on what crosses into main (main holds them too): see ATTACH in services/chat.ts */
const CAP = { image: 20 * 1024 * 1024, pdf: 10 * 1024 * 1024, text: 512 * 1024, files: 10 };

/** a file in the composer: what goes to claude, and what its chip shows */
type Attached = ChatAttachment & { size: number; url?: string };

const dataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
const base64 = (url: string) => url.slice(url.indexOf(",") + 1);

/**
 * files picked, dropped or pasted, read as claude takes them. one it cannot take, or one over its
 * cap, is said why. one that is not a type it takes goes into the message as its path
 */
async function readAttachment(f: File): Promise<Attached | { path: string } | { refused: string }> {
  const kind = attachKind(f.type, f.name);
  if (kind === "unsupported") {
    const path = window.grove.pathOf(f);
    return path ? { path } : { refused: `${f.name} can't be attached.` };
  }
  if (f.size > CAP[kind]) {
    return {
      refused:
        kind === "text"
          ? `${f.name} is over ${bytes(CAP.text)}: mention it with @ instead.`
          : `${f.name} is over ${bytes(CAP[kind])}.`,
    };
  }
  if (kind === "text") return { kind, name: f.name, text: await f.text(), size: f.size };
  const url = await dataUrl(f);
  if (kind === "pdf") return { kind, name: f.name, data: base64(url), size: f.size };
  return {
    kind,
    mediaType: f.type.toLowerCase() as "image/png",
    data: base64(url),
    size: f.size,
    url,
  };
}

/** what went to claude, as the turn's header names it until the transcript has it */
const namesOf = (files: ChatAttachment[]) => ({
  images: files.filter((f) => f.kind === "image").length,
  files: files.flatMap((f) => (f.kind === "image" ? [] : [f.name])),
});

/** a refusal from main, as the line over the composer says it */
const failed = (o: Outcome<unknown>): string | undefined => (o.ok ? undefined : o.error.message);

/** a file in the composer: an image as its thumbnail, anything else as its name and size */
function Chip({ file, onRemove }: { file: Attached; onRemove: () => void }) {
  const remove = (
    <IconButton
      label="Remove attachment"
      data-testid="chip-remove"
      className={
        file.url ? "absolute top-0.5 right-0.5 bg-overlay opacity-0 group-hover:opacity-100" : ""
      }
      onClick={onRemove}
    >
      <Icon name="x" size={10} />
    </IconButton>
  );
  if (file.url) {
    return (
      <div
        className="group relative overflow-hidden rounded-md border border-line"
        data-testid="chip"
      >
        <img src={file.url} alt="Attached" className="block h-10 w-auto max-w-32" />
        {remove}
      </div>
    );
  }
  return (
    <div
      className="flex h-10 max-w-64 items-center gap-2 rounded-md border border-line bg-chrome pr-1 pl-2.5"
      data-testid="chip"
      title={file.kind === "image" ? undefined : file.name}
    >
      <Icon name="file" faint />
      <span className="min-w-0 truncate text-sm text-fg-2">
        {file.kind === "image" ? "image" : file.name}
      </span>
      <span className="shrink-0 text-sm text-fg-4">{bytes(file.size)}</span>
      {remove}
    </div>
  );
}

/**
 * what claude said along the way that no transcript keeps: a tool it turned down by itself, a
 * command's output, a hook's reason. muted, under the turn: it is context, not the answer
 */
function Note({ note }: { note: ChatNote }) {
  if (note.kind === "output") {
    return (
      <pre
        className="selectable mt-2 border-l border-line pl-3 font-mono text-sm whitespace-pre-wrap break-words text-fg-3"
        data-testid="chat-note-output"
      >
        {note.text}
      </pre>
    );
  }
  return (
    <p
      className="mt-2 flex items-start gap-1.5 text-sm text-fg-4"
      data-testid={`chat-note-${note.kind}`}
    >
      <span className="flex h-[18px] items-center">
        <Icon name={note.kind === "denied" ? "x" : "warning"} size={10} />
      </span>
      <span className="selectable min-w-0 break-words">{note.text}</span>
    </p>
  );
}

/** the window of one session. its page has no list and no landing: main says which session */
export function ChatApp() {
  const [target, setTarget] = useState<ChatTarget | null>();
  /** main gave this window a session: a null target now means it has gone */
  const [opened, setOpened] = useState(false);
  const [status, setStatus] = useState<ChatStatus>();
  /** null: the transcript is gone. undefined: not read yet */
  const [talk, setTalk] = useState<ChatConversation | null>();
  /**
   * beside the conversation: the session's files or one of them, its agents or one of them (by
   * id, or by the call that started it until the list is read). closed when the window opens
   */
  const [pane, setPane] = useState<
    { kind: "files"; file?: string } | { kind: "agents"; agent?: string; call?: string } | null
  >(null);
  /** every agent of the session, read when the agents pane is open */
  const [agents, setAgents] = useState<ChatAgent[]>();
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
  /** files picked, dropped or pasted, sent with the next message */
  const [files, setFiles] = useState<Attached[]>([]);
  /** what went with what this window sent, until the transcript has it */
  const [sentFiles, setSentFiles] = useState<{ images: number; files: string[] }>();
  /** files are being dragged over the window */
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  /** bumped each time main hands the window a session */
  const [openings, setOpenings] = useState(0);
  const last = useRef("");
  const warmed = useRef(false);
  const [error, setError] = useState<string>();
  /** what main said that is not a failure: when it will open in the editor */
  const [note, setNote] = useState<string>();
  const [moving, setMoving] = useState(false);
  /** the menu that is open, and the button it opens from: the toolbar's, or the header's … */
  const [menu, setMenu] = useState<{
    kind: "mode" | "model" | "attach" | "more";
    anchor: DOMRect;
  } | null>(null);
  /** ⌘K's palette or ⌘/'s sheet of keys */
  const [sheet, setSheet] = useState<"palette" | "shortcuts" | null>(null);
  const modeButton = useRef<HTMLButtonElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
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
      // the session card sent the person here for a file or the agents
      api().on("chat:show", (show) =>
        setPane("file" in show ? { kind: "files", file: show.file } : { kind: "agents" }),
      ),
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

  // every action's key, from wherever the keyboard is (cmd-shift-Enter is the editor, as on a list
  // in the main window). Esc closes the pane beside the conversation, unless the composer took it
  // to stop a turn
  const actionsRef = useRef<ChatAction[]>([]);
  const paneOpen = useRef(false);
  paneOpen.current = !!pane;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const hit = actionsRef.current.find((a) => a.keys && !a.off && pressed(e, a.keys));
      if (hit) {
        e.preventDefault();
        hit.run();
      } else if (e.key === "Escape" && paneOpen.current) {
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

  // the agents pane reads them all: when it opens, when claude says one moved, when the transcript did
  const agentsOpen = pane?.kind === "agents";
  const liveAgents = status?.agents;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the live agents and rev are when, not what
  useEffect(() => {
    if (!agentsOpen) return;
    let live = true;
    void api()
      .chatAgents()
      .then((a) => live && setAgents(a))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [agentsOpen, liveAgents, rev]);
  // a step's call names its agent once the list is read
  const call = pane?.kind === "agents" ? pane.call : undefined;
  useEffect(() => {
    if (!call || !agents) return;
    // a Workflow call opens the list, where its run and its agents are
    const hit = agents.find((a) => a.toolUseId === call && a.kind !== "workflow");
    setPane({ kind: "agents", ...(hit ? { agent: hit.id } : {}) });
  }, [call, agents]);

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
              ...(sentFiles?.images ? { images: sentFiles.images } : {}),
              ...(sentFiles?.files.length ? { files: sentFiles.files } : {}),
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

  /** the model it is on, as the menu lists it: claude reports the id a value like "opus" stands for */
  const current = s.models.find((m) => m.value === s.model || m.id === s.model);

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
    const attached = files;
    if ((!text && attached.length === 0) || readOnly) return;
    // a background agent mid-turn stops when this takes it over: asked first, as Open asks
    const stop = session.runtime === "background" ? session.open.confirm : undefined;
    if (stop && !window.confirm(`${stop.title}\n\n${stop.body}`)) return;
    setError(undefined);
    setNote(undefined);
    setDraft("");
    setFiles([]);
    if (text) last.current = text;
    // what goes over: the chip's size and thumbnail stay here
    const out = attached.map(({ size: _size, url: _url, ...f }) => f as ChatAttachment);
    if (!running) {
      setSent(text);
      setSentFiles(namesOf(out));
    }
    atEnd.current = true;
    const why = failed(await api().chatSend(text, out));
    if (why) {
      setError(why);
      setSent(null);
      setDraft(text);
      setFiles(attached);
    }
  };

  /** picked, dropped or pasted: what claude can take is attached, the rest is said why */
  const attach = async (list: FileList | null | undefined) => {
    const got = await Promise.all(
      [...(list ?? [])].map((f) =>
        readAttachment(f).catch(() => ({ refused: `${f.name} could not be read.` })),
      ),
    );
    const taken = got.filter((g): g is Attached => "kind" in g);
    const paths = got.flatMap((g) => ("path" in g ? [g.path] : []));
    const refused = got.flatMap((g) => ("refused" in g ? [g.refused] : []));
    const room = CAP.files - files.length;
    if (taken.length > room) refused.push(`${CAP.files} files at most go with one message.`);
    if (taken.length) setFiles((was) => [...was, ...taken.slice(0, Math.max(0, room))]);
    if (paths.length) {
      // claude reads it from where it is: the message names it
      setDraft((d) => `${d}${d && !/\s$/.test(d) ? " " : ""}${paths.join(" ")} `);
      const names = paths.map((p) => p.slice(p.lastIndexOf("/") + 1)).join(", ");
      setNote(
        `${names} can't be attached, so ${paths.length === 1 ? "its path is" : "their paths are"} in the message.`,
      );
    }
    setError(refused.length ? refused.join(" ") : undefined);
    if (taken.length || paths.length) warm();
    composer.current?.focus();
  };

  /** "Mention a file": an @ where the caret is, which opens the files menu */
  const mention = () => {
    const at = composer.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, at);
    const insert = `${before && !/\s$/.test(before) ? " " : ""}@`;
    const next = before + insert + draft.slice(at);
    setDraft(next);
    setCaret(at + insert.length);
    placeCaret.current = at + insert.length;
    warm();
  };

  const answer = async (askId: string, a: ChatAnswer) => {
    setError(failed(await api().chatAnswer(askId, a)));
    composer.current?.focus();
  };

  const openMenu = (kind: "mode" | "model" | "attach" | "more", el: HTMLElement) => {
    if (menu?.kind === kind) return setMenu(null);
    setMenu({ kind, anchor: el.getBoundingClientRect() });
    // the rows are claude's: opening the menu starts it, as shift-tab does
    if (kind === "mode" || kind === "model") warm();
  };

  const closeMenu = () => {
    setMenu(null);
    composer.current?.focus();
  };

  const pickMode = async (mode: ChatMode) => {
    closeMenu();
    if (mode !== s.mode) setError(failed(await api().chatSetMode(mode)));
  };

  const pickModel = async (model: string) => {
    closeMenu();
    if (model !== current?.value) setError(failed(await api().chatSetModel(model)));
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
  const scope = {
    session: session.sessionId,
    base: target.cwd,
    open: (file: string) => setPane({ kind: "files", file }),
    agents: (call?: string) => setPane({ kind: "agents", ...(call ? { call } : {}) }),
  };
  /** what runs now, as its claude says: the header counts its workflows and its other agents */
  const busy = (s.agents ?? []).filter((a) => a.state === "running");
  const runningWorkflows = busy.filter((a) => a.kind === "workflow").length;
  const runningAgents = busy.filter((a) => !a.kind && !a.workflow).length;
  const runningWords = [
    runningWorkflows
      ? `${runningWorkflows} ${runningWorkflows === 1 ? "workflow" : "workflows"}`
      : "",
    runningAgents ? `${runningAgents} ${runningAgents === 1 ? "agent" : "agents"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const shownAgent =
    pane?.kind === "agents" && pane.agent
      ? agents?.find((a) => a.id === pane.agent && a.kind !== "workflow")
      : undefined;
  const stopAgent = async (id: string) => setError(failed(await api().chatStopAgent(id)));
  const toggle = (kind: "files" | "agents") =>
    setPane(pane?.kind === kind && !("file" in pane && pane.file) ? null : { kind });

  /** everything the window does: the palette lists it, the sheet shows its keys, the keys run it */
  const actions: ChatAction[] = [
    {
      id: "editor",
      group: "Session",
      label: `Open in ${target.editor}`,
      keys: { key: "Enter", meta: true, shift: true },
      // a new session has nothing to open in the editor until it has said something
      off: !!target.fresh,
      run: toEditor,
    },
    {
      id: "attach",
      group: "Composer",
      label: "Attach files…",
      keys: { key: "u", meta: true },
      off: !!readOnly,
      run: () => picker.current?.click(),
    },
    {
      id: "mention",
      group: "Composer",
      label: "Mention a file",
      shown: "@",
      off: !!readOnly,
      run: mention,
    },
    {
      id: "mode",
      group: "Composer",
      label: "Permission mode…",
      keys: { key: "m", meta: true, shift: true },
      off: !!readOnly,
      run: () => modeButton.current && openMenu("mode", modeButton.current),
    },
    {
      id: "next-mode",
      group: "Composer",
      label: "Next permission mode",
      shown: "⇧⇥",
      off: !!readOnly,
      run: () => void stepMode(),
    },
    {
      id: "model",
      group: "Composer",
      label: "Model and effort…",
      keys: { key: "e", meta: true, shift: true },
      off: !!readOnly,
      run: () => modelButton.current && openMenu("model", modelButton.current),
    },
    {
      id: "stop",
      group: "Composer",
      label: "Stop the turn",
      shown: "esc",
      off: !running,
      run: () => void api().chatInterrupt(),
    },
    {
      id: "files",
      group: "View",
      label: "Files",
      keys: { key: "f", meta: true, shift: true },
      run: () => toggle("files"),
    },
    {
      id: "agents",
      group: "View",
      label: "Agents",
      keys: { key: "g", meta: true, shift: true },
      run: () => toggle("agents"),
    },
    {
      id: "palette",
      group: "View",
      label: "Command palette",
      keys: { key: "k", meta: true },
      run: () => setSheet(sheet === "palette" ? null : "palette"),
    },
    {
      id: "shortcuts",
      group: "View",
      label: "Keyboard shortcuts",
      keys: { key: "/", meta: true },
      run: () => setSheet(sheet === "shortcuts" ? null : "shortcuts"),
    },
  ];
  actionsRef.current = actions;
  const closeSheet = () => {
    setSheet(null);
    composer.current?.focus();
  };

  return (
    <div
      className="@container relative flex h-full flex-col bg-canvas"
      data-testid="chat"
      data-id={session.sessionId}
      // files dragged anywhere over the window attach where they are dropped
      onDragEnter={(e) => {
        if (readOnly || !e.dataTransfer.types.includes("Files")) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDragOver={(e) => {
        if (!readOnly && e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDragging(false);
        if (readOnly || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        void attach(e.dataTransfer.files);
      }}
    >
      {dragging && <DropOverlay />}
      {/* the traffic lights sit in the first 76px */}
      <header className="drag flex h-12 shrink-0 items-center gap-2.5 border-b border-line pr-3 pl-20">
        {target.project && <ProjectMark id={target.project} />}
        <h1 className="min-w-0 flex-1 truncate font-semibold" title={session.title}>
          {session.title}
        </h1>
        {s.asks.length > 0 ? (
          <StateLabel state="turn" within="panel" />
        ) : (
          running && (
            <span className="flex items-center gap-1.5">
              <StateLabel state="working" within="panel" />
              {s.since !== undefined && <Clock since={s.since} />}
            </span>
          )
        )}
        {runningWords && (
          <Button
            size="sm"
            variant="quiet"
            data-testid="chat-agents"
            title="The session's agents"
            onClick={() => setPane(pane?.kind === "agents" ? null : { kind: "agents" })}
          >
            <AgentState state="running" word={false} />
            <span className="tabular-nums">{runningWords}</span>
          </Button>
        )}
        <IconButton
          label="Files"
          aria-pressed={pane?.kind === "files"}
          data-testid="chat-files"
          className={cx(pane?.kind === "files" && "bg-raised text-fg")}
          onClick={() => setPane(pane?.kind === "files" ? null : { kind: "files" })}
        >
          <Icon name="file" />
        </IconButton>
        {/* what is about the session as a whole: open it elsewhere, rename, export, the keys */}
        <IconButton
          label="More"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "more"}
          data-testid="chat-more"
          className={cx(menu?.kind === "more" && "bg-raised text-fg")}
          onClick={(e) => openMenu("more", e.currentTarget)}
        >
          <Icon name="more" />
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
                      <Turn turn={item} last={i === end} working={running} images detail />
                      {item.outputs && <OutputCards outputs={item.outputs} />}
                    </div>
                  ),
                )}
                {/* a card says what it waits on: the live line would only say its tool's name */}
                {running && s.asks.length === 0 && <LiveLine status={s} />}
                {s.notes?.map((n, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: notes only grow, until the next send
                  <Note key={i} note={n} />
                ))}
                {s.asks.map((a) => (
                  <Ask
                    key={a.id}
                    ask={a}
                    onAnswer={(x) => void answer(a.id, x)}
                    onLeave={() => composer.current?.focus()}
                    // the keys go to the card, unless the person is in the middle of typing
                    autoFocus={!draft}
                  />
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
            <footer className="shrink-0">
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
                    {files.length > 0 && (
                      <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="composer-files">
                        {files.map((f, i) => (
                          <Chip
                            // biome-ignore lint/suspicious/noArrayIndexKey: the same file can be attached twice
                            key={i}
                            file={f}
                            onRemove={() => setFiles(files.filter((_, j) => j !== i))}
                          />
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
                        const pasted = e.clipboardData.files;
                        if (pasted.length === 0) return;
                        // a screenshot is only an image. a copy from a page that has words too
                        // pastes its words as well
                        if (!e.clipboardData.getData("text/plain")) e.preventDefault();
                        void attach(pasted);
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
                      <ToolbarButton
                        title="Attach files"
                        aria-label="Attach"
                        aria-haspopup="menu"
                        aria-expanded={menu?.kind === "attach"}
                        data-testid="chat-attach"
                        className="w-7 justify-center px-0"
                        onClick={(e) => openMenu("attach", e.currentTarget)}
                      >
                        <Icon name="plus" size={14} />
                      </ToolbarButton>
                      <input
                        ref={picker}
                        type="file"
                        multiple
                        hidden
                        data-testid="chat-picker"
                        onChange={(e) => {
                          void attach(e.currentTarget.files);
                          // the same file picked again is a change too
                          e.currentTarget.value = "";
                        }}
                      />
                      {/* the mode is the settings', known once claude is up: opening the menu starts it */}
                      <ToolbarButton
                        ref={modeButton}
                        title="Permission mode (⇧⌘M, or ⇧⇥ to step)"
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
                      <ToolbarButton
                        ref={modelButton}
                        title="Model and effort (⇧⌘E)"
                        aria-haspopup="menu"
                        aria-expanded={menu?.kind === "model"}
                        data-testid="chat-model"
                        onClick={(e) => openMenu("model", e.currentTarget)}
                      >
                        <span className="truncate">
                          {current?.label ?? (s.model ? modelLabel(s.model) : "Model")}
                          {s.effort && current?.efforts && (
                            <span className="text-fg-4">
                              {" "}
                              · {EFFORT_WORD[s.effort] ?? s.effort}
                            </span>
                          )}
                        </span>
                        <Icon name="chevron" size={9} className="rotate-90" faint />
                      </ToolbarButton>
                      {s.ultracode && <UltraChip />}
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
                      {running && !draft.trim() && files.length === 0 ? (
                        <SendButton
                          ready={false}
                          stop
                          title="Stop (Esc). Background agents keep running"
                          aria-label="Stop"
                          data-testid="chat-stop"
                          onClick={() => void api().chatInterrupt()}
                        />
                      ) : (
                        <SendButton
                          ready={!!draft.trim() || files.length > 0}
                          title={
                            running
                              ? "Queue it (Enter): it goes once this step is done"
                              : "Send (Enter). Shift-Enter is a new line"
                          }
                          aria-label="Send"
                          data-testid="chat-send"
                          onClick={() => void send()}
                        />
                      )}
                    </div>
                  </ComposerFrame>
                )}
              </div>
            </footer>
          </div>
          {pane?.kind === "files" &&
            (pane.file ? (
              <Viewer
                file={pane.file}
                onList={() => setPane({ kind: "files" })}
                onClose={() => setPane(null)}
              />
            ) : (
              <FileList written={talk?.written ?? []} rev={s.rev} onClose={() => setPane(null)} />
            ))}
          {pane?.kind === "agents" &&
            (shownAgent ? (
              <AgentViewer
                agent={shownAgent}
                onList={() => setPane({ kind: "agents" })}
                onClose={() => setPane(null)}
                onStop={() => void stopAgent(shownAgent.id)}
              />
            ) : (
              <AgentList
                agents={agents}
                onOpen={(id) => setPane({ kind: "agents", agent: id })}
                onStop={(id) => void stopAgent(id)}
                onClose={() => setPane(null)}
              />
            ))}
        </div>
      </ChatScopeContext.Provider>
      {menu?.kind === "more" && (
        <Menu
          anchor={menu.anchor}
          testId="more-menu"
          width={280}
          down
          onClose={closeMenu}
          onPick={(id) => {
            closeMenu();
            actions.find((a) => a.id === id)?.run();
          }}
          items={actions
            .filter(
              (a) =>
                !a.off && (a.group === "Session" || a.id === "shortcuts" || a.id === "palette"),
            )
            .map((a) => ({
              key: a.id,
              label: a.label,
              ...(a.keys ? { keys: keysLabel(a.keys) } : {}),
            }))}
        />
      )}
      {sheet === "palette" && <CommandPalette actions={actions} onClose={closeSheet} />}
      {sheet === "shortcuts" && <ShortcutSheet actions={actions} onClose={closeSheet} />}
      {menu?.kind === "attach" && (
        <Menu
          anchor={menu.anchor}
          testId="attach-menu"
          width={280}
          onClose={closeMenu}
          onPick={(k) => {
            closeMenu();
            if (k === "upload") picker.current?.click();
            else mention();
          }}
          items={[
            {
              key: "upload",
              label: "Upload from computer…",
              description: "Images, PDFs and text files",
            },
            { key: "mention", label: "Mention a file", description: "@ a file in this project" },
          ]}
        />
      )}
      {menu?.kind === "model" && (
        <Menu
          anchor={menu.anchor}
          testId="model-menu"
          width={340}
          onClose={closeMenu}
          onPick={(m) => void pickModel(m)}
          items={s.models.map((m) => ({
            key: m.value,
            label: m.label,
            ...(m.description ? { description: m.description } : {}),
            checked: m === current,
          }))}
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
          {s.live && !!current?.efforts?.length && (
            <div className="mt-1 border-t border-line px-2 pt-2.5 pb-1" data-testid="effort">
              <p className="mb-1.5 text-sm font-medium text-fg-3">Effort</p>
              <Segmented
                label="Effort"
                size="sm"
                value={s.effort ?? ""}
                options={current.efforts.map((e) => ({
                  value: e,
                  label: EFFORT_WORD[e] ?? e,
                  testId: `effort-${e}`,
                }))}
                onChange={(e) =>
                  void api()
                    .chatSetEffort(e)
                    .then((o) => setError(failed(o)))
                }
              />
              {s.effort === "max" && (
                <p className="mt-1.5 text-sm text-fg-4">
                  Max is for this session only and can run long.
                </p>
              )}
            </div>
          )}
          {s.live && s.ultracodeAvailable && (
            <div className="mt-1 flex items-start gap-3 border-t border-line px-2 pt-2.5 pb-1.5">
              <span className="min-w-0 flex-1">
                <span className="block text-body text-fg">Ultracode</span>
                <span className="block text-sm text-fg-4">
                  Runs a workflow of agents on every task. This session only.
                </span>
              </span>
              <span className="pt-0.5">
                <Switch
                  ultra
                  label="Ultracode"
                  testId="ultracode"
                  checked={!!s.ultracode}
                  onChange={(on) =>
                    void api()
                      .chatSetUltracode(on)
                      .then((o) => setError(failed(o)))
                  }
                />
              </span>
            </div>
          )}
        </Menu>
      )}
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
