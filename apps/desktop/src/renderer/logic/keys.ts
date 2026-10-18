// a key combination as electron's accelerator names it, from a key the page saw, and as the mac
// writes it. pure.

const MODS: Record<string, string> = { Control: "⌃", Alt: "⌥", Shift: "⇧", Command: "⌘" };

const NAMED: Record<string, string> = {
  Space: "Space",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/** `⌃⌥⌘G` for `Control+Alt+Command+G` */
export const keyLabel = (accelerator: string): string =>
  accelerator
    .split("+")
    .map((p) => MODS[p] ?? p)
    .join("");

/**
 * the accelerator for a key pressed with at least one of ctrl, opt and cmd. by the key's place on
 * the keyboard, not what it types: opt-G types ©. null for anything else
 */
export function acceleratorOf(e: {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const key =
    /^Key([A-Z])$/.exec(e.code)?.[1] ??
    /^Digit(\d)$/.exec(e.code)?.[1] ??
    (/^F\d{1,2}$/.test(e.code) ? e.code : undefined) ??
    NAMED[e.code];
  if (!key || !(e.metaKey || e.ctrlKey || e.altKey)) return null;
  return [
    e.ctrlKey && "Control",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    e.metaKey && "Command",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
