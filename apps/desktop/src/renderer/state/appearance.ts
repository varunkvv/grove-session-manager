/**
 * which half of every light-dark() the page uses, and which palette's. the theme attribute switches
 * `color-scheme` on :root, which also makes macOS draw the scrollbars and native controls to match.
 * anything but "light" or "dark" means follow the system, which the media query already does. the
 * palette attribute swaps app.css's colour tokens. grove's own has none
 */
export function applyAppearance(
  appearance: string | null | undefined,
  palette: string | null | undefined,
): void {
  const root = document.documentElement;
  if (appearance === "light" || appearance === "dark") root.dataset.theme = appearance;
  else delete root.dataset.theme;
  if (palette === "rose-pine" || palette === "solarized") root.dataset.palette = palette;
  else delete root.dataset.palette;
}
