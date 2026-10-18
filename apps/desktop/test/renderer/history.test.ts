import { describe, expect, it } from "vitest";
import { walk } from "../../src/renderer/logic/history.ts";

describe("the composer's prompt history", () => {
  const said = ["first", "second", "third"];
  it("walks back to the oldest, forward again, and past the newest gives the draft back", () => {
    let at = walk(said, null, "half typed", true);
    expect(at?.text).toBe("third");
    at = walk(said, at?.walk ?? null, "third", true);
    expect(at?.text).toBe("second");
    at = walk(said, at?.walk ?? null, "second", true);
    at = walk(said, at?.walk ?? null, "first", true);
    // nothing older: the key moves the caret
    expect(at).toBeNull();
    let down = walk(said, { at: 1, draft: "half typed" }, "second", false);
    expect(down?.text).toBe("third");
    down = walk(said, down?.walk ?? null, "third", false);
    expect(down).toEqual({ walk: null, text: "half typed" });
    // down with no walk under way is the caret's
    expect(walk(said, null, "x", false)).toBeNull();
    expect(walk([], null, "", true)).toBeNull();
  });
});
