import { describe, expect, it } from "vitest";
import { MARK_SIZE, markAlpha } from "../../src/main/trayMark.ts";

describe("the menu bar mark", () => {
  const alpha = markAlpha();
  const at = (x: number, y: number) => alpha[y * MARK_SIZE + x] ?? Number.NaN;

  it("is a solid tree in front: a crown, and a trunk under it", () => {
    expect(alpha.length).toBe(MARK_SIZE * MARK_SIZE);
    expect(at(16, 12)).toBe(255);
    expect(at(15, 25)).toBe(255);
  });

  it("sets the two trees behind back through alpha, the far one furthest", () => {
    const [mid, far] = [at(5, 16), at(26, 18)];
    expect(far).toBeGreaterThan(64);
    expect(far).toBeLessThan(mid);
    expect(mid).toBeLessThan(192);
    // where the front crown crosses the far one, the front one is what shows
    expect(at(21, 15)).toBe(255);
  });

  it("leaves the corners and the gaps between the trunks empty", () => {
    expect([at(0, 0), at(31, 0), at(0, 31), at(31, 31)]).toEqual([0, 0, 0, 0]);
    expect([at(11, 26), at(20, 26)]).toEqual([0, 0]);
  });
});
