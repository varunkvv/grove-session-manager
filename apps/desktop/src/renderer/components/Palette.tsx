import { tokenize } from "@grove/core/pure";
import { type KeyboardEvent, useEffect, useState } from "react";
import type { ChatWindowView, SessionHit } from "../../shared/ipc.ts";
import { type PaletteItem, paletteItems } from "../logic/palette.ts";
import type { SessionItem } from "../logic/views.ts";
import {
  archiveProject,
  focusScreen,
  go,
  goUsage,
  newSession,
  openChat,
  openSession,
  report,
  switchProject,
} from "../state/actions.ts";
import { currentProject, useStore } from "../state/store.ts";
import {
  cx,
  Highlighted,
  Icon,
  Kbd,
  menuItemClass,
  NeedsLine,
  Overlay,
  ProjectMark,
  StateLabel,
  stateWord,
  Time,
} from "./ui.tsx";

/** its own prefix: aria-activedescendant must never name a list row behind the overlay */
const domId = (id: string) => `palette-${id}`;

/** a palette row that can have a second line under the first: it wraps onto it */
export const tallItemClass = cx(menuItemClass, "h-auto! flex-wrap gap-y-0 py-1.5");

/** a project's mark, or the same room left empty, so the titles of a list line up */
const MarkSlot = ({ hit }: { hit: SessionHit }) =>
  hit.project ? <ProjectMark id={hit.project} /> : <span className="size-2 shrink-0" />;

/**
 * an open chat window in ⌘K, from the inbox row's parts: which session, its project, what it is at,
 * and under it what it asks or else what it is for. one line when there is neither. nothing that
 * ticks: the palette is open for a second
 */
export function WindowRow({ item, words }: { item: SessionItem; words: readonly string[] }) {
  const { hit, state, row } = item;
  return (
    <>
      <MarkSlot hit={hit} />
      <span className="min-w-0 flex-1 truncate text-fg">
        <Highlighted text={hit.title} tokens={words} />
      </span>
      <span className="max-w-[140px] shrink-0 truncate text-sm text-fg-3">{hit.where}</span>
      {state && <StateLabel state={state} within="menu" />}
      {row?.summary ? (
        <div className="w-full min-w-0 pl-4">
          <NeedsLine state={row.kind} text={row.summary} />
        </div>
      ) : (
        hit.description && (
          <span className="mt-0.5 w-full truncate pl-4 text-fg-2" title={hit.description}>
            <Highlighted text={hit.description} tokens={words} />
          </span>
        )
      )}
    </>
  );
}

/** what a screen reader says of a window row, as the inbox row says it */
export function windowLabel({ hit, state, row }: SessionItem): string {
  const line = row?.summary || hit.description;
  return `${state ? `${stateWord(state)}: ` : ""}${hit.title}, in ${hit.where}${line ? `. ${line}` : ""}`;
}

/** a session a search found, in either palette: why it was found under it, when that is not its title */
export function HitRow({ hit, words }: { hit: SessionHit; words: readonly string[] }) {
  return (
    <>
      <MarkSlot hit={hit} />
      <span className="min-w-0 flex-1 truncate">
        <Highlighted text={hit.title} tokens={words} />
      </span>
      <span className="max-w-[160px] shrink-0 truncate text-sm text-fg-3">{hit.where}</span>
      <Time at={hit.activityMs} />
      {hit.snippet && (
        // the words were found in what was said, not in the title: this line is why it is here
        <span className="w-full truncate pl-4 text-sm text-fg-3">
          <Highlighted text={hit.snippet} tokens={words} />
        </span>
      )}
    </>
  );
}

/**
 * the open chat windows, asked as a palette opens. it is drawn once they are in, a few ms later:
 * drawn before, its first row would move under an Enter already on the way
 */
export function useChatWindows(open = true): ChatWindowView[] | undefined {
  const [windows, setWindows] = useState<ChatWindowView[]>();
  useEffect(() => {
    setWindows(undefined);
    if (!open) return;
    let stale = false;
    window.grove.chatWindows().then(
      (w) => !stale && setWindows(w),
      () => !stale && setWindows([]),
    );
    return () => {
      stale = true;
    };
  }, [open]);
  return windows;
}

/** findSessions' answer to what is typed, asked 80ms after the last key. an older query's is dropped */
export function useFoundSessions(query: string) {
  const [sessions, setSessions] = useState<{ query: string; hits: SessionHit[] }>();
  const typed = tokenize(query).length > 0;
  useEffect(() => {
    if (!typed) return;
    let stale = false;
    const timer = setTimeout(async () => {
      // a search that failed is an answer with nothing in it, or `No matches.` would never show
      const hits = await window.grove.findSessions(query).catch(() => []);
      if (!stale) setSessions({ query, hits });
    }, 80);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, typed]);
  return sessions;
}

/** mounted only while it is open, so every open starts empty with the first item active */
function Open({ windows }: { windows: readonly ChatWindowView[] }) {
  // the inbox is every project's: nothing there is `This project`
  const project = useStore((s) => (s.view.name === "inbox" ? null : (currentProject(s) ?? null)));
  const projects = useStore((s) => s.projects);
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  const [query, setQuery] = useState("");
  /** the keyboard's item by id. null, or one that left the list, is the first item */
  const [at, setAt] = useState<string | null>(null);
  // sessions are main's: asked 80ms after the last keystroke
  const sessions = useFoundSessions(query);

  const words = tokenize(query);
  const { sections, none } = paletteItems({ project, projects, editor, sessions, windows }, query);
  const items = sections.flatMap((s) => s.items);
  const active = items.find((i) => i.id === at) ?? items[0];

  const close = () => {
    useStore.getState().set({ overlay: null });
    focusScreen();
  };

  const run = (item: PaletteItem) => {
    const { set, toast } = useStore.getState();
    // `project:{id}`, `session:{key}`
    const cut = item.id.indexOf(":");
    const name = cut < 0 ? item.id : item.id.slice(0, cut);
    const arg = item.id.slice(cut + 1);
    const p = project;
    switch (name) {
      case "go-inbox":
        go("inbox");
        break;
      case "go-usage":
        goUsage();
        break;
      case "project":
        switchProject(arg);
        break;
      case "session":
        if (item.hit) openSession(item.hit.key, item.hit.open, item.hit.title);
        break;
      // an open chat window, where it was. Enter on it opens the session from here, as a
      // double-click on its row does
      case "window":
        if (item.window) openChat(item.window.hit.key, item.window.hit.title);
        break;
      // a dialog takes the keyboard itself
      case "settings":
        return set({ overlay: null, dialog: { kind: "settings" } });
    }
    // the rows of `This project`
    if (p) {
      switch (name) {
        case "new-session":
          newSession(p.id);
          break;
        // a dialog takes the keyboard itself
        case "start-background":
          return set({ overlay: null, dialog: { kind: "start", project: p.id } });
        case "long-work": {
          const next = p.longWork === "background" ? "foreground" : "background";
          void window.grove.setLongWork(p.id, next).then((res) => {
            if (!report("Could not change that", res)) return;
            const where = next === "background" ? "background" : "conversation";
            toast({ level: "info", title: `Long work runs in the ${where} in ${p.name}` });
          });
          break;
        }
        case "repair":
          // main says what it did to each working copy
          void window.grove
            .repairProject(p.id)
            .then((res) => report("Could not repair the working copies", res));
          break;
        case "archive-project":
          void archiveProject(p.id, !p.archived);
          break;
        case "delete-project":
          return set({ overlay: null, dialog: { kind: "delete", project: p.id } });
      }
    }
    close();
  };

  const onKey = (e: KeyboardEvent) => {
    const i = active ? items.indexOf(active) : -1;
    const next = { ArrowDown: Math.min(items.length - 1, i + 1), ArrowUp: Math.max(0, i - 1) }[
      e.key
    ];
    if (next !== undefined) {
      const to = items[next];
      if (to) {
        setAt(to.id);
        document.getElementById(domId(to.id))?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter") {
      // an Enter that ends an IME composition picks a candidate, not an item
      if (active && !e.nativeEvent.isComposing) run(active);
    } else if (e.key === "Escape") close();
    else if (e.key !== "Tab") return;
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <Overlay
      open
      onClose={close}
      testId="palette"
      className="w-[560px] overflow-hidden"
      style={{ top: 72, left: "50%", transform: "translateX(-50%)" }}
    >
      <input
        data-palette-input
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-activedescendant={active && domId(active.id)}
        aria-label="Go to, switch project or find a session"
        autoFocus
        spellCheck={false}
        className="h-11 w-full border-b border-line bg-transparent px-4 text-body text-fg placeholder:text-fg-4"
        placeholder="Go to, switch project or find a session"
        data-testid="palette-input"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          // typing puts the keyboard back on the best match
          setAt(null);
        }}
        onKeyDown={onKey}
      />
      <div
        id="palette-list"
        role="listbox"
        // the scroll padding keeps a section's label above its first row, and the last row off the edge
        className="max-h-[420px] scroll-pt-9 scroll-pb-1.5 overflow-y-auto p-1.5"
        data-testid="palette-list"
        // a click on a label or between rows must not take the keyboard out of the field
        onMouseDown={(e) => e.preventDefault()}
      >
        {sections.map((s) => (
          <div role="group" aria-label={s.label} key={s.label} data-testid="palette-section">
            <div className="px-2 pt-2 pb-1 text-meta text-fg-4">{s.label}</div>
            {s.items.map((i) => (
              <div
                key={i.id}
                id={domId(i.id)}
                role="option"
                aria-selected={i === active}
                aria-label={i.window && windowLabel(i.window)}
                data-active={i === active || undefined}
                // a window's line under it, or a snippet: the row grows
                className={i.window || i.hit ? tallItemClass : menuItemClass}
                data-testid="palette-item"
                data-id={i.id}
                onMouseMove={() => setAt(i.id)}
                onClick={() => run(i)}
              >
                {i.window ? (
                  <WindowRow item={i.window} words={words} />
                ) : i.hit ? (
                  <HitRow hit={i.hit} words={words} />
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{i.label}</span>
                    {i.kbd && <Kbd>{i.kbd}</Kbd>}
                    {i.current && <Icon name="check" size={10} className="text-fg-3" />}
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
        {none && (
          <p className="px-2 py-3 text-sm text-fg-4" data-testid="palette-empty">
            No matches.
          </p>
        )}
      </div>
    </Overlay>
  );
}

/** cmd-K: go to, switch project, what the screens have no button for, and every session */
export function Palette() {
  const open = useStore((s) => s.overlay === "palette");
  const windows = useChatWindows(open);
  return open && windows ? <Open windows={windows} /> : null;
}
