// what the page looks like now: dark or light, and which palette. code blocks and diagrams are
// coloured for it, so they redraw when it moves
export const isDark = (): boolean => {
  const pinned = document.documentElement.dataset.theme;
  return pinned ? pinned === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

/** "grove" when no other palette is set */
export const paletteNow = (): string => document.documentElement.dataset.palette ?? "grove";

/** the look moved: pinned in Settings, macOS at sunset, or another palette */
export function onLook(changed: () => void): () => void {
  const system = matchMedia("(prefers-color-scheme: dark)");
  system.addEventListener("change", changed);
  const pinned = new MutationObserver(changed);
  pinned.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-palette"],
  });
  return () => {
    system.removeEventListener("change", changed);
    pinned.disconnect();
  };
}
