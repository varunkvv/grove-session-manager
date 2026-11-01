// the usage limit as a bar for the menu row: a track and a fill in grove's accent, drawn as pixels so
// the menu gets it as an icon. no electron import, so a unit test can read its pixels.

/** 56 x 16 points, doubled: wide enough that 21% and 40% look different */
export const BAR_WIDTH = 112;
export const BAR_HEIGHT = 32;
/** the bar itself: 6 points tall, centred */
const BAR_TOP = 13;
const BAR_BOTTOM = 19;
const SAMPLES = 4;

/** grove's accent, light and dark. amber from 90% on, so a near-full limit reads as a warning */
const ACCENT = { light: [0x67, 0x26, 0xe1], dark: [0xa4, 0x8b, 0xfa] } as const;
const WARNING = { light: [0xb4, 0x53, 0x09], dark: [0xfb, 0xbf, 0x24] } as const;
const WARN_FROM = 90;

/** how much of the bar is filled, 0 to 100, with the rounded ends */
function covered(x: number, y: number, fillTo: number): number {
  // a point is in the rounded bar when it is within the bar's radius of its inner rectangle, and left of the fill
  const r = (BAR_BOTTOM - BAR_TOP) / 2;
  let hits = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const px = x + (sx + 0.5) / SAMPLES;
      const py = y + (sy + 0.5) / SAMPLES;
      if (py < BAR_TOP || py > BAR_BOTTOM || px > fillTo) continue;
      const cx = Math.min(Math.max(px, 0 + r), BAR_WIDTH - r);
      const cy = (BAR_TOP + BAR_BOTTOM) / 2;
      if ((px - cx) ** 2 + (py - cy) ** 2 > r * r) continue;
      hits++;
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

/** the bar as BGRA pixels, straight alpha. `percent` is clamped to 0 to 100 */
export function limitBarPixels(percent: number, dark: boolean): Buffer {
  const share = Math.min(100, Math.max(0, percent));
  const palette = dark ? "dark" : "light";
  const [r, g, b] = share >= WARN_FROM ? WARNING[palette] : ACCENT[palette];
  // the fill ends where the share says, and a non-zero share always shows at least a sliver
  const fillTo = share === 0 ? 0 : Math.max((share / 100) * BAR_WIDTH, 2);
  const buf = Buffer.alloc(BAR_WIDTH * BAR_HEIGHT * 4);
  for (let y = 0; y < BAR_HEIGHT; y++) {
    for (let x = 0; x < BAR_WIDTH; x++) {
      const track = covered(x, y, BAR_WIDTH) * 0.2;
      const fill = covered(x, y, fillTo);
      // the fill is drawn over the track, so the same colour carries both and only alpha differs
      const o = (y * BAR_WIDTH + x) * 4;
      buf[o] = b;
      buf[o + 1] = g;
      buf[o + 2] = r;
      buf[o + 3] = Math.round((fill + track * (1 - fill)) * 255);
    }
  }
  return buf;
}
