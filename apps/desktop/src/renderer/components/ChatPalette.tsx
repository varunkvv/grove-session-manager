// grove chat's index of everything it can do: ⌘K runs any of it by name, ⌘/ lists every key. the
// same look as the main window's palette.
import { type KeyboardEvent, useState } from "react";
import { type ChatAction, keysLabel } from "../logic/chatKeys.ts";
import { rank } from "../logic/fuzzy.ts";
import { Kbd, menuItemClass, Overlay } from "./ui.tsx";

const GROUPS: ChatAction["group"][] = ["Session", "Message", "Composer", "View"];
const keyOf = (a: ChatAction) => a.shown ?? (a.keys ? keysLabel(a.keys) : "");

/** ⌘K: every action that can run now, found by its name. Enter runs it, Esc closes */
export function CommandPalette({
  actions,
  onClose,
}: {
  actions: readonly ChatAction[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const live = actions.filter((a) => !a.off);
  const items = query.trim()
    ? rank(live, query.trim(), (a) => a.label)
    : GROUPS.flatMap((g) => live.filter((a) => a.group === g));
  const active = items[Math.min(at, items.length - 1)];
  const run = (a: ChatAction | undefined) => {
    if (!a) return;
    onClose();
    a.run();
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
        aria-label="Run an action"
        placeholder="Run an action"
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
        {items.map((a, i) => [
          !query.trim() && items[i - 1]?.group !== a.group && (
            <div key={`g-${a.group}`} className="px-2 pt-2 pb-1 text-meta text-fg-4">
              {a.group}
            </div>
          ),
          <div
            key={a.id}
            role="option"
            aria-selected={a === active}
            data-active={a === active || undefined}
            data-testid="chat-palette-item"
            data-id={a.id}
            className={menuItemClass}
            onMouseMove={() => setAt(i)}
            onClick={() => run(a)}
          >
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
            {keyOf(a) && <Kbd>{keyOf(a)}</Kbd>}
          </div>,
        ])}
        {items.length === 0 && (
          <p className="px-2 py-3 text-sm text-fg-4">No action by that name.</p>
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
