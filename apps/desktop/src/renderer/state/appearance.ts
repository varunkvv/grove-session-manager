/**
 * which half of every light-dark() the page uses, and which palette's. the theme attribute switches
 * `color-scheme` on :root, which also makes macOS draw the scrollbars and native controls to match.
 * anything but "light" or "dark" means follow the system, which the media query already does. the
 * palette attribute swaps app.css's colour tokens. grove's own has none. the text size is
 * `--reading-scale` on :root, which only the reading areas' text takes (app.css `.reading`)
 */
export function applyAppearance(
  appearance: string | null | undefined,
  palette: string | null | undefined,
  textScale?: number | string | null,
): void {
  const root = document.documentElement;
  if (appearance === "light" || appearance === "dark") root.dataset.theme = appearance;
  else delete root.dataset.theme;
  if (palette === "rose-pine" || palette === "solarized") root.dataset.palette = palette;
  else delete root.dataset.palette;
  const percent = Number(textScale);
  const scale = percent && percent !== 100 ? String(percent / 100) : "";
  if (root.style.getPropertyValue("--reading-scale") === scale) return;
  // every conversation on the page keeps its place through the text growing or shrinking
  const places = [...document.querySelectorAll<HTMLElement>('[data-testid="conversation"]')].map(
    keepPlace,
  );
  if (scale) root.style.setProperty("--reading-scale", scale);
  else root.style.removeProperty("--reading-scale");
  for (const back of places) back();
}

/**
 * where a conversation is read from, to put back once the text has its new size: at its end it
 * stays at the end, anywhere else the turn at its top stays where it was. not left to chromium's
 * scroll anchoring: the column's max-width moves with the size too, and that turns anchoring off
 */
function keepPlace(box: HTMLElement): () => void {
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 24) {
    return () => {
      box.scrollTop = box.scrollHeight;
    };
  }
  const top = box.getBoundingClientRect().top;
  const turn = [...box.querySelectorAll<HTMLElement>('[data-testid="turn"]')].find(
    (t) => t.getBoundingClientRect().bottom > top,
  );
  if (!turn) return () => {};
  const was = turn.getBoundingClientRect().top - top;
  return () => {
    box.scrollTop += turn.getBoundingClientRect().top - box.getBoundingClientRect().top - was;
  };
}
