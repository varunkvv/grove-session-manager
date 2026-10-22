/**
 * the Text size setting: how big the conversation's text is, in percent. one step list for the
 * app's main process, its pages and the settings file. 100 is the default, kept as no setting
 */
export const TEXT_SCALES = [90, 100, 110, 120, 135, 150] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

export const isTextScale = (v: unknown): v is TextScale => TEXT_SCALES.includes(v as TextScale);

/** a step bigger (1), smaller (-1), or back to 100 (0). at either end it stays where it is */
export function stepTextScale(now: number | undefined, dir: -1 | 0 | 1): TextScale {
  if (dir === 0) return 100;
  const at = TEXT_SCALES.indexOf(isTextScale(now) ? now : 100);
  return TEXT_SCALES[Math.min(TEXT_SCALES.length - 1, Math.max(0, at + dir))] ?? 100;
}
