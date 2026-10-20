import { type LiveStatus, reduceStatus, type StatusEvent } from "@grove/core";
import { describe, expect, it } from "vitest";
import { entered } from "../../src/main/services/live.ts";

const SID = "aaaaaaaa-0000-4000-8000-000000000001";

/** the status after each event, and whether it entered needs-you there: what a drain notifies */
function told(events: Array<Omit<StatusEvent, "sessionId">>, from?: LiveStatus) {
  let s = from;
  return events.map((e) => {
    const was = s;
    s = reduceStatus(s, { sessionId: SID, ...e });
    return entered(was, s);
  });
}

describe("what enters needs-you", () => {
  it("an agent's ask after the turn ended notifies. the turn it interrupted coming back does not", () => {
    expect(
      told([
        { event: "UserPromptSubmit", at: 1 },
        { event: "Stop", at: 2, message: "Should I keep going?" },
        { event: "PermissionRequest", at: 3, toolName: "Bash", agentId: "a1" },
        { event: "PostToolUse", at: 4, agentId: "a1" },
        { event: "PostToolUse", at: 5, agentId: "a1" },
      ]),
    ).toEqual([false, true, true, false, false]);
  });

  it("a new ask, a new turn's end and an error do. the same status again, or a seen one, do not", () => {
    const waiting: LiveStatus = { state: "waiting", at: 2, lastEventAt: 2 };
    expect(entered(undefined, waiting)).toBe(true);
    expect(entered({ state: "running", at: 1, lastEventAt: 1 }, waiting)).toBe(true);
    expect(entered(waiting, { ...waiting, at: 5, lastEventAt: 5 })).toBe(true);
    expect(entered(waiting, { ...waiting, state: "failed", at: 5 })).toBe(true);
    expect(entered(waiting, { ...waiting, lastEventAt: 9 })).toBe(false);
    expect(entered(undefined, { ...waiting, seen: true })).toBe(false);
    expect(entered(waiting, undefined)).toBe(false);
  });
});
