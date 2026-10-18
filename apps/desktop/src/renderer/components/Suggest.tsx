// the composer's two menus: `/` at the start of a message lists Claude Code's commands and skills,
// `@` after a space lists the files of the session's folders. both fuzzy, both keyboard-driven:
// arrows move, Enter or Tab puts it in the message, Esc closes it.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ChatCommand, ChatPath } from "../../shared/ipc.ts";
import { rank } from "../logic/fuzzy.ts";
import { cx, Spinner } from "./ui.tsx";

const api = () => window.grove;

/** what the text before the caret asks for, and the part of it a pick replaces */
export interface Trigger {
  kind: "/" | "@";
  query: string;
  from: number;
  to: number;
}

export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  // a command is the whole message so far
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: "/", query: slash[1] ?? "", from: 0, to: caret };
  const at = /(^|\s)@(\S*)$/.exec(before);
  if (at) {
    const query = at[2] ?? "";
    return { kind: "@", query, from: caret - query.length - 1, to: caret };
  }
  return null;
}

interface Item {
  key: string;
  insert: string;
  label: string;
  detail?: string;
}

/**
 * the menu for what is typed, and its keys. `live`: claude is up, so its commands can be asked
 * for. `opened`: changes each time the window is handed a session, and the file lists are read again
 */
export function useSuggest(o: {
  text: string;
  caret: number;
  live: boolean;
  opened: number;
  onPick: (text: string, caret: number) => void;
}) {
  const trigger = triggerAt(o.text, o.caret);
  const [commands, setCommands] = useState<ChatCommand[]>();
  const [paths, setPaths] = useState<ChatPath[]>();
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const asked = useRef({ commands: false, paths: -1 });
  const id = trigger && `${trigger.kind}${trigger.from}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new window open is when the paths are read again
  useEffect(() => {
    setPaths(undefined);
    setCommands(undefined);
    asked.current = { commands: false, paths: -1 };
  }, [o.opened]);

  useEffect(() => {
    if (trigger?.kind === "/" && o.live && !asked.current.commands) {
      asked.current.commands = true;
      void api()
        .chatCommands()
        .then(setCommands)
        .catch(() => setCommands([]));
    }
    if (trigger?.kind === "@" && asked.current.paths !== o.opened) {
      asked.current.paths = o.opened;
      void api()
        .chatPaths(true)
        .then(setPaths)
        .catch(() => setPaths([]));
    }
  }, [trigger?.kind, o.live, o.opened]);

  // the menu is new: its first item is the keyboard's
  // biome-ignore lint/correctness/useExhaustiveDependencies: what is typed is when it starts again
  useEffect(() => setActive(0), [trigger?.kind, trigger?.query]);
  useEffect(() => {
    if (!id) setDismissed(null);
  }, [id]);

  const open = !!trigger && id !== dismissed;
  const items: Item[] | undefined = !open
    ? []
    : trigger.kind === "/"
      ? commands &&
        rank(commands, trigger.query, (c) => c.name).map((c) => ({
          key: c.name,
          insert: `/${c.name} `,
          label: `/${c.name}${c.hint ? ` ${c.hint}` : ""}`,
          detail: c.description,
        }))
      : paths &&
        rank(paths, trigger.query, (p) => p.shown).map((p) => ({
          key: p.insert,
          insert: `@${p.insert} `,
          label: p.shown,
        }));

  const pick = (item: Item) => {
    if (!trigger) return;
    const next = o.text.slice(0, trigger.from) + item.insert + o.text.slice(trigger.to);
    o.onPick(next, trigger.from + item.insert.length);
  };

  /** the menu's keys. true: it took the key */
  const onKey = (e: KeyboardEvent): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === "Escape") {
      setDismissed(id);
      return true;
    }
    if (!items?.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + items.length) % items.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) {
      const item = items[active];
      if (item) pick(item);
      return true;
    }
    return false;
  };

  const menu = open ? (
    <SuggestMenu
      kind={trigger.kind}
      items={items}
      active={active}
      waiting={trigger.kind === "/" && !o.live}
      onPick={pick}
      onHover={setActive}
    />
  ) : null;
  return { menu, onKey };
}

function SuggestMenu({
  kind,
  items,
  active,
  waiting,
  onPick,
  onHover,
}: {
  kind: "/" | "@";
  items: Item[] | undefined;
  active: number;
  /** claude is not up yet, and only it knows its commands */
  waiting: boolean;
  onPick: (item: Item) => void;
  onHover: (i: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const quiet = (words: string, spin = false) => (
    <p className="flex items-center gap-1.5 px-2 py-1.5 text-sm text-fg-4">
      {spin && <Spinner size={10} />}
      {words}
    </p>
  );
  return (
    <div
      ref={list}
      role="listbox"
      data-testid="suggest"
      data-kind={kind}
      // the toolbar menus' box and rows, over the composer and as wide as it
      className="overlay-shadow absolute inset-x-6 bottom-full mb-2 max-h-72 overflow-y-auto rounded-lg border border-line-strong bg-overlay p-1"
    >
      {!items
        ? quiet(waiting ? "Starting Claude…" : "Looking…", true)
        : items.length === 0
          ? quiet(kind === "/" ? "No command by that name." : "No file by that name.")
          : items.map((item, i) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={i === active}
                data-i={i}
                data-testid="suggest-item"
                // the composer keeps the keyboard
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => onHover(i)}
                onClick={() => onPick(item)}
                className={cx(
                  "flex w-full min-w-0 items-baseline gap-3 rounded-md px-2 py-1.5 text-left",
                  i === active && "bg-raised",
                )}
              >
                <span className={cx("shrink-0 truncate text-fg", kind === "@" && "min-w-0")}>
                  {item.label}
                </span>
                {item.detail && (
                  <span className="min-w-0 flex-1 truncate text-sm text-fg-4">{item.detail}</span>
                )}
              </button>
            ))}
    </div>
  );
}
