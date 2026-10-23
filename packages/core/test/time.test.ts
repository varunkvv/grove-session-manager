import { describe, expect, it } from "vitest";
import { messageTime } from "../src/time.ts";

const NOW = new Date(2026, 9, 22, 18, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("messageTime", () => {
  it("is the clock alone within a day", () => {
    const at = NOW - 23 * HOUR;
    expect(messageTime(at, NOW)).toBe(
      new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    );
  });

  it("adds the date and how long ago in words past a day", () => {
    expect(messageTime(NOW - DAY, NOW)).toMatch(/ · 1 day ago$/);
    expect(messageTime(NOW - 3 * DAY, NOW)).toMatch(/ · 3 days ago$/);
    expect(messageTime(NOW - 7 * DAY, NOW)).toMatch(/ · 1 week ago$/);
    expect(messageTime(NOW - 20 * DAY, NOW)).toMatch(/ · 2 weeks ago$/);
    expect(messageTime(NOW - 70 * DAY, NOW)).toMatch(/ · 2 months ago$/);
    expect(messageTime(NOW - 400 * DAY, NOW)).toMatch(/ · 1 year ago$/);
  });

  it("names the year only when it is another one", () => {
    expect(messageTime(NOW - 3 * DAY, NOW)).not.toContain("2026");
    expect(messageTime(NOW - 400 * DAY, NOW)).toContain("2025");
  });
});
