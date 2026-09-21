/**
 * which half of every light-dark() the page uses. the attribute switches `color-scheme` on
 * :root, which also makes macOS draw the scrollbars and native controls to match.
 * anything but "light" or "dark" means follow the system, which the media query already does.
 */
export function applyAppearance(appearance: string | null | undefined): void {
  const root = document.documentElement;
  if (appearance === "light" || appearance === "dark") root.dataset.theme = appearance;
  else delete root.dataset.theme;
}
