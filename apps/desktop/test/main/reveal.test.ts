import { describe, expect, it } from "vitest";
import { Reveals } from "../../src/main/services/reveal.ts";

function setup() {
  const calls: string[] = [];
  const reveals = new Reveals({
    raise: () => calls.push("raise"),
    notify: () => calls.push("notify"),
  });
  return { reveals, calls };
}

describe("a landing, from a notification click or a tray row", () => {
  it("raises the window, tells the page, and is held until the page takes it, once", () => {
    const { reveals, calls } = setup();
    const target = { view: "card", project: "auth-sso", cardId: "AUTH-4", back: "inbox" } as const;
    expect(reveals.land(target)).toMatchObject({ target });
    expect(calls).toEqual(["raise", "notify"]);
    // the page was not listening yet: it takes the landing when it connects, and only once
    expect(reveals.take()).toMatchObject({ target });
    expect(reveals.take()).toBeNull();
  });

  it("the newest landing wins: two clicks before the page looks land on the second", () => {
    const { reveals } = setup();
    reveals.land({ view: "inbox", project: "auth-sso", rowId: "stopped:s1" });
    reveals.land({ view: "conclusions", project: "auth-sso", conclusionId: "D-4" });
    expect(reveals.take()?.target).toEqual({
      view: "conclusions",
      project: "auth-sso",
      conclusionId: "D-4",
    });
  });
});
