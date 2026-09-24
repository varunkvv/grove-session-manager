import { describe, expect, it } from "vitest";
import {
  backgroundTooltip,
  continuePrompt,
  interruptedTooltip,
} from "../../src/renderer/logic/background.ts";

describe("the background marker's tooltip", () => {
  it("names the id attach takes, the state in Claude Code's words, and what it waits on", () => {
    expect(backgroundTooltip({ id: "d7b6bcc2", held: true, state: "working" })).toBe(
      "Background session d7b6bcc2 · working",
    );
    expect(
      backgroundTooltip({
        id: "d7b6bcc2",
        held: true,
        state: "blocked",
        waitingFor: "permission prompt",
      }),
    ).toBe("Background session d7b6bcc2 · blocked · permission prompt");
    expect(backgroundTooltip({ id: "d7b6bcc2", held: false, state: "done" })).toBe(
      "Background session d7b6bcc2 · done · not running now",
    );
    expect(backgroundTooltip({ held: false, state: "stopped" })).toBe(
      "Background session · stopped",
    );
    expect(backgroundTooltip({ held: false })).toBe("Background session · state unknown");
  });
});

describe("an interrupted session", () => {
  it("is told so when it picks up", () => {
    expect(continuePrompt(undefined)).toBe("continue where you left off");
    expect(continuePrompt({})).toBe("continue where you left off");
    expect(continuePrompt({ interrupted: { why: "gone", at: 1 } })).toBe(
      "continue where you left off - you were interrupted",
    );
  });

  it("says how grove knows", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(interruptedTooltip({ why: "gone", at: now - 3 * 3_600_000 }, now)).toMatch(
      /^Its process went away mid-turn, 3h ago: a closed window, a crash or a restart\./,
    );
    expect(interruptedTooltip({ why: "failed" }, now)).toMatch(/^Its background run failed\./);
  });
});
