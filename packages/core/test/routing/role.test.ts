import { describe, expect, it } from "vitest";
import { nextReminder, ROLE_REMINDER_EVERY } from "../../src/pure.ts";
import { cleanBlockText } from "../../src/transcript/prompt.ts";

describe("nextReminder", () => {
  it("reminds on the first message of a routing session, then every nth", () => {
    let state = undefined as ReturnType<typeof nextReminder>["state"];
    const sent: boolean[] = [];
    for (let i = 0; i < ROLE_REMINDER_EVERY * 2 + 1; i++) {
      const r = nextReminder(state, true);
      sent.push(r.text !== undefined);
      state = r.state;
    }
    expect(sent.filter(Boolean)).toHaveLength(3);
    expect(sent[0]).toBe(true);
    expect(sent[ROLE_REMINDER_EVERY]).toBe(true);
    expect(sent[1]).toBe(false);
  });

  it("says once that routing went off, and nothing for a session that never had it", () => {
    const on = nextReminder(undefined, true).state;
    const off = nextReminder(on, false);
    expect(off.text).toContain("Routing is now off");
    expect(nextReminder(off.state, false).text).toBeUndefined();
    expect(nextReminder(undefined, false).text).toBeUndefined();
  });

  it("reminds again when it is switched back on", () => {
    const off = nextReminder(nextReminder(undefined, true).state, false).state;
    expect(nextReminder(off, true).text).toContain("Routing is on");
  });

  it("is hidden from what the window shows", () => {
    expect(cleanBlockText(nextReminder(undefined, true).text ?? "")).toBeNull();
  });
});
