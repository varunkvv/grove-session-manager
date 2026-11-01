import { describe, expect, it } from "vitest";
import { BAR_HEIGHT, BAR_WIDTH, limitBarPixels } from "../../src/main/limitBar.ts";

/** the alpha and the colour of the pixel at (x, y), BGRA */
const at = (buf: Buffer, x: number, y: number) => {
  const o = (y * BAR_WIDTH + x) * 4;
  return { b: buf[o], g: buf[o + 1], r: buf[o + 2], a: buf[o + 3] };
};
const MID = BAR_HEIGHT / 2;

describe("the limit bar's pixels", () => {
  it("fills from the left by the share used, in the accent, over a track", () => {
    const half = limitBarPixels(50, false);
    // the middle of the fill is solid accent: #6726e1
    expect(at(half, 20, MID)).toMatchObject({ r: 0x67, g: 0x26, b: 0xe1, a: 255 });
    // past the fill the track shows, at 20% of the accent
    expect(at(half, 100, MID)).toMatchObject({ r: 0x67, g: 0x26, b: 0xe1, a: 51 });
  });

  it("uses the lighter accent in dark mode", () => {
    expect(at(limitBarPixels(50, true), 20, MID)).toMatchObject({
      r: 0xa4,
      g: 0x8b,
      b: 0xfa,
      a: 255,
    });
  });

  it("turns amber from 90% on, so a near-full limit reads as a warning", () => {
    expect(at(limitBarPixels(89, false), 20, MID)).toMatchObject({ r: 0x67, g: 0x26, b: 0xe1 });
    expect(at(limitBarPixels(90, false), 20, MID)).toMatchObject({ r: 0xb4, g: 0x53, b: 0x09 });
  });

  it("is only the track at zero, and a sliver shows for any share above zero", () => {
    // the track's 20%, and no fill over it
    expect(at(limitBarPixels(0, false), 2, MID).a).toBe(51);
    expect(at(limitBarPixels(0.5, false), 1, MID).a).toBe(255);
  });

  it("fills the whole bar at 100%, and clamps what is outside 0 to 100", () => {
    expect(at(limitBarPixels(100, false), BAR_WIDTH - 10, MID).a).toBe(255);
    expect(at(limitBarPixels(250, false), BAR_WIDTH - 10, MID).a).toBe(255);
    expect(at(limitBarPixels(-5, false), 20, MID).a).toBe(51);
  });
});
