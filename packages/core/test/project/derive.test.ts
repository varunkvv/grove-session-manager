import { describe, expect, it } from "vitest";
import { runtimeOf } from "../../src/project/derive.ts";

describe("where a session runs", () => {
  it("names the five runtimes", () => {
    const vscode = { kind: "interactive", entrypoint: "claude-vscode" };
    expect(runtimeOf({ holder: vscode, alive: true })).toBe("vscode");
    expect(runtimeOf({ holder: { entrypoint: "cli" }, alive: true })).toBe("terminal");
    expect(runtimeOf({ holder: { kind: "bg" }, alive: true })).toBe("background");
    expect(runtimeOf({ holder: { entrypoint: "sdk-cli" }, alive: true })).toBe("elsewhere");
    expect(runtimeOf({ holder: {}, alive: true })).toBe("elsewhere");
    expect(runtimeOf({ alive: false })).toBe("closed");
  });

  it("a holder whose process is gone is closed, and a held background session wins", () => {
    expect(runtimeOf({ holder: { entrypoint: "claude-vscode" }, alive: false })).toBe("closed");
    expect(runtimeOf({ held: true, holder: { entrypoint: "claude-vscode" }, alive: true })).toBe(
      "background",
    );
    expect(runtimeOf({ held: true, alive: false })).toBe("background");
  });
});
