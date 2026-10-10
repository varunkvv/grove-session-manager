// the menu bar mark as alpha: the Dock icon's three trees. no electron import, so a unit test can
// read its pixels.

/** 16pt doubled */
export const MARK_SIZE = 32;

/** the line the three stand on */
const GROUND = 29;

/**
 * [crown x, crown y, crown radius, trunk width, strength], the front tree first. a trunk runs from
 * the middle of its crown down to the ground, 4px or 3px wide on whole pixels so it holds at 1x.
 * the Dock icon tells the trees apart by colour. a template image has one, so the two behind are
 * set back through alpha instead
 */
const TREES = [
  [16, 12, 8, 4, 1],
  [7.5, 16.25, 5.5, 3, 0.55],
  [24.5, 18, 5, 3, 0.42],
] as const;

/** how much ink each pixel carries, 0 to 255, row by row */
export function markAlpha(): Uint8Array {
  const alpha = new Uint8Array(MARK_SIZE * MARK_SIZE);
  for (let y = 0; y < MARK_SIZE; y++) {
    for (let x = 0; x < MARK_SIZE; x++) {
      // 4x4 samples per pixel, so the edges are smooth
      let ink = 0;
      for (let s = 0; s < 16; s++) {
        const px = x + ((s % 4) + 0.5) / 4;
        const py = y + (Math.floor(s / 4) + 0.5) / 4;
        // the front tree is solid and the two behind never meet, so the first tree hit decides
        const tree = TREES.find(
          ([cx, cy, r, trunk]) =>
            (px - cx) ** 2 + (py - cy) ** 2 <= r * r ||
            (Math.abs(px - cx) <= trunk / 2 && py >= cy && py <= GROUND),
        );
        if (tree) ink += tree[4];
      }
      alpha[y * MARK_SIZE + x] = Math.round((ink / 16) * 255);
    }
  }
  return alpha;
}
