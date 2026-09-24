import { describe, expect, it } from "vitest";
import { backgroundTooltip } from "../../src/renderer/logic/background.ts";

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
