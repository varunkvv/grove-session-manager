import { describe, expect, it } from "vitest";
import { openPlanOf } from "../../src/main/services/openPlan.ts";
import type { BackgroundView, SessionRow } from "../../src/shared/ipc.ts";

const row = (background?: BackgroundView): SessionRow => ({
  key: "/projects/-ws-chat/aaaaaaaa-0000-4000-8000-000000000001.jsonl",
  sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
  projectLabel: "chat",
  activityMs: 0,
  parsed: true,
  ...(background ? { background } : {}),
});

describe("what Open in {editor} needs before it is pressed", () => {
  it("vscode, closed, terminal and elsewhere: nothing. openSession lands or says why not", () => {
    for (const runtime of ["vscode", "closed", "terminal", "elsewhere"] as const) {
      expect(openPlanOf(runtime, row()), runtime).toEqual({});
      expect(openPlanOf(runtime), runtime).toEqual({});
    }
  });

  it("background with its short id, working: asks before it stops the turn", () => {
    expect(openPlanOf("background", row({ id: "b4f2", state: "working", held: true }))).toEqual({
      confirm: {
        title: "Stop it while it works?",
        body: "It is still working - stopping it interrupts the turn. The conversation is kept, and it opens where you left it.",
        label: "Stop and open",
      },
    });
  });

  it("background with its short id, not working: stops and lands with no question", () => {
    for (const state of ["blocked", "done", "failed", undefined]) {
      expect(
        openPlanOf("background", row({ id: "b4f2", held: true, ...(state ? { state } : {}) })),
        String(state),
      ).toEqual({});
    }
  });

  it("background before Claude Code says which one it is: no button", () => {
    const disabled = { disabled: "running in the background" };
    expect(openPlanOf("background", row({ held: true, state: "working" }))).toEqual(disabled);
    expect(openPlanOf("background", row())).toEqual(disabled);
    expect(openPlanOf("background")).toEqual(disabled);
  });
});
