// grove chat's index of everything it can do: ⌘K switches to another chat window or runs any
// action by name, ⌘/ lists every key. the same look as the main window's palette.
import { tokenize } from "@grove/core/pure";
import { type KeyboardEvent, useState } from "react";
import type { ChatWindowView } from "../../shared/ipc.ts";
import { type ChatAction, keysLabel } from "../logic/chatKeys.ts";
import { type ChatPaletteItem, chatPaletteItems } from "../logic/palette.ts";
import {
  HitRow,
  tallItemClass,
  useChatWindows,
  useFoundSessions,
  WindowRow,
  windowLabel,
} from "./Palette.tsx";
import { Kbd, menuItemClass, Overlay } from "./ui.tsx";

const GROUPS: ChatAction["group"][] = ["Session", "Message", "Composer", "View"];
const keyOf = (a: ChatAction) => a.shown ?? (a.keys ? keysLabel(a.keys) : "");

/**
 * ⌘K: the other chat windows, the one looked at last first, so ⌘K Enter goes back to it. then
 * every action that can run now, found by its name. typed, the sessions found too. Enter runs the
 * row, Esc closes. drawn once main has said which windows are open, a few ms after ⌘K
 */
export function CommandPalette(props: {
  /** the window's own session */
  self: string;
  actions: readonly ChatAction[];
  onClose: () => void;
  /** a session that would not open */
  onError: (message: string) => void;
}) {
  const windows = useChatWindows();
  return windows ? <Open {...props} windows={windows} /> : null;
}

function Open({
  self,
  actions,
  windows,
  onClose,
  onError,
}: {
  self: string;
  actions: readonly ChatAction[];
  windows: readonly ChatWindowView[];
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const sessions = useFoundSessions(query);
  const words = tokenize(query);
  const sections = chatPaletteItems({ self, windows, actions, sessions }, query);
  const items = sections.flatMap((s) => s.items);
  const active = items[Math.min(at, items.length - 1)];
  // more than the actions: what to switch to is the first thing it is for
  const switching = windows.some((w) => w.hit.sessionId !== self);
  const run = (i: ChatPaletteItem | undefined) => {
    if (!i) return;
    onClose();
    if (i.kind === "action") i.action.run();
    else if (i.kind === "window") void window.grove.showWindow(i.window.hit.sessionId);
    else if (i.kind === "all") void window.grove.showWindow(null);
    else {
      void window.grove
        .openChat(i.hit.key)
        .then((o) => o.ok || onError(`Could not open ${i.hit.title}: ${o.error.message}`));
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      // the window's own Esc (stop, close a pane) must not fire as well
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length || 1;
      setAt((i) => (Math.min(i, n - 1) + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(active);
    }
  };
  const label = switching ? "Switch window or run an action" : "Run an action";
  return (
    <Overlay
      open
      onClose={onClose}
      testId="chat-palette"
      className="w-[520px] max-w-[calc(100vw-32px)] overflow-hidden"
      style={{ top: 64, left: "50%", transform: "translateX(-50%)" }}
    >
      <input
        data-palette-input
        autoFocus
        spellCheck={false}
        aria-label={label}
        placeholder={label}
        data-testid="chat-palette-input"
        className="h-11 w-full border-b border-line bg-transparent px-4 text-body text-fg placeholder:text-fg-4"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(0);
        }}
        onKeyDown={onKey}
      />
      <div
        role="listbox"
        className="max-h-[420px] overflow-y-auto p-1.5"
        onMouseDown={(e) => e.preventDefault()}
      >
        {sections.map((s) => [
          <div key={`g-${s.label}`} className="px-2 pt-2 pb-1 text-meta text-fg-4">
            {s.label}
          </div>,
          ...s.items.map((i) => (
            <div
              key={i.id}
              role="option"
              aria-selected={i === active}
              aria-label={i.kind === "window" ? windowLabel(i.window) : undefined}
              data-active={i === active || undefined}
              data-testid="chat-palette-item"
              data-id={i.id}
              className={
                i.kind === "window" || i.kind === "session" ? tallItemClass : menuItemClass
              }
              onMouseMove={() => setAt(items.indexOf(i))}
              onClick={() => run(i)}
            >
              {i.kind === "window" ? (
                <WindowRow item={i.window} words={words} />
              ) : i.kind === "session" ? (
                <HitRow hit={i.hit} words={words} />
              ) : i.kind === "all" ? (
                <>
                  {/* under the windows' titles, as their marks' column runs */}
                  <span className="min-w-0 flex-1 truncate pl-4">All sessions</span>
                  <Kbd>⌘1</Kbd>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{i.action.label}</span>
                  {keyOf(i.action) && <Kbd>{keyOf(i.action)}</Kbd>}
                </>
              )}
            </div>
          )),
        ])}
        {items.length === 0 && (!words.length || sessions?.query === query) && (
          <p className="px-2 py-3 text-sm text-fg-4">No matches.</p>
        )}
      </div>
    </Overlay>
  );
}

/** ⌘/: every key the chat window has, by group, in a quiet sheet. Esc or a click away closes it */
export function ShortcutSheet({
  actions,
  onClose,
}: {
  actions: readonly ChatAction[];
  onClose: () => void;
}) {
  return (
    <Overlay
      open
      onClose={onClose}
      testId="chat-shortcuts"
      className="w-[560px] max-w-[calc(100vw-32px)] p-4"
      style={{ top: 64, left: "50%", transform: "translateX(-50%)" }}
    >
      <div
        // the sheet takes Esc itself: the window has no store of open overlays
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "/" && e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        data-list
        className="grid grid-cols-2 gap-x-8 gap-y-4"
      >
        {GROUPS.map((g) => {
          const rows = actions.filter((a) => a.group === g && keyOf(a));
          if (!rows.length) return null;
          return (
            <section key={g}>
              <h3 className="mb-1 text-meta text-fg-4">{g}</h3>
              {rows.map((a) => (
                <p key={a.id} className="flex h-7 items-center gap-3 text-sm text-fg-2">
                  <span className="min-w-0 flex-1 truncate">{a.label}</span>
                  <Kbd>{keyOf(a)}</Kbd>
                </p>
              ))}
            </section>
          );
        })}
      </div>
    </Overlay>
  );
}
