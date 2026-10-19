// what the page looks like now: dark or light, and which palette. code blocks and diagrams are
// coloured for it, so they redraw when it moves
export const isDark = (): boolean => {
  const pinned = document.documentElement.dataset.theme;
  return pinned ? pinned === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

/** "grove" when no other palette is set */
export const paletteNow = (): string => document.documentElement.dataset.palette ?? "grove";

const listeners = new Set<() => void>();
const tell = () => {
  for (const l of listeners) l();
};
let watching: (() => void) | null = null;

/**
 * the look moved: pinned in Settings, macOS at sunset, or another palette. every code block and
 * diagram listens, so they share one observer rather than one each
 */
export function onLook(changed: () => void): () => void {
  listeners.add(changed);
  if (!watching) {
    const system = matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", tell);
    const pinned = new MutationObserver(tell);
    pinned.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-palette"],
    });
    watching = () => {
      system.removeEventListener("change", tell);
      pinned.disconnect();
    };
  }
  return () => {
    listeners.delete(changed);
    if (listeners.size || !watching) return;
    watching();
    watching = null;
  };
}
