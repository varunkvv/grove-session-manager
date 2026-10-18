// grove chat's keyboard: every action in the chat window has a key, said the way macOS menus say
// them (⌘⇧E), and the palette and the shortcuts sheet show the same words.

/** a key and the modifiers held with it. `key` as KeyboardEvent.key has it, any case */
export interface Keys {
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

const NAMED: Record<string, string> = {
  enter: "↩",
  escape: "esc",
  arrowdown: "↓",
  arrowup: "↑",
  tab: "⇥",
  backspace: "⌫",
};

/** "⌃⌥⇧⌘K", in the order macOS draws them */
export function keysLabel(k: Keys): string {
  const name = NAMED[k.key.toLowerCase()] ?? k.key.toUpperCase();
  return `${k.ctrl ? "⌃" : ""}${k.alt ? "⌥" : ""}${k.shift ? "⇧" : ""}${k.meta ? "⌘" : ""}${name}`;
}

/** the event is these keys: every modifier as asked, none more */
export function pressed(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey">,
  k: Keys,
): boolean {
  return (
    e.key.toLowerCase() === k.key.toLowerCase() &&
    e.metaKey === !!k.meta &&
    e.shiftKey === !!k.shift &&
    e.altKey === !!k.alt &&
    e.ctrlKey === !!k.ctrl
  );
}

/** one thing the chat window can do: in the palette, in the sheet, and on its key */
export interface ChatAction {
  id: string;
  label: string;
  /** where the palette and the sheet group it */
  group: "Session" | "Message" | "Composer" | "View";
  keys?: Keys;
  /** a key the window or a field already takes (Esc, ⇧⇥, @): shown, never bound here */
  shown?: string;
  /** not now: in the sheet, not in the palette */
  off?: boolean;
  run: () => void;
}
