import { describe, expect, it } from "vitest";
import { CLAUDE_OPEN_COMMAND, resumeSession, startConversation } from "../src/resume.ts";
import { fakeDeps, SID, writeSession } from "./helpers/fakeDeps.ts";

describe("landing on a session", () => {
  it("uses the Claude extension's own command, in this window, with the session and prompt", async () => {
    const f = fakeDeps();
    writeSession(f.deps.projectsDir, "/Users/you/src/api", SID.a);
    expect(await resumeSession(f.deps, SID.a, "carry on")).toBe("command");
    expect(f.commands).toEqual([{ id: CLAUDE_OPEN_COMMAND, args: [SID.a, "carry on"] }]);
    expect(f.uris).toEqual([]);
  });

  it("falls back to the documented deep link when the command throws", async () => {
    const f = fakeDeps({ commandFails: "boom" });
    writeSession(f.deps.projectsDir, "/Users/you/src/api", SID.a);
    expect(await resumeSession(f.deps, SID.a)).toBe("uri");
    expect(f.commands).toHaveLength(1);
    expect(f.uris).toEqual([`vscode://anthropic.claude-code/open?session=${SID.a}`]);
  });

  it("'command not found' is retried: the Claude extension may still be registering", async () => {
    const f = fakeDeps({ commandFails: "command 'claude-vscode.primaryEditor.open' not found" });
    writeSession(f.deps.projectsDir, "/Users/you/src/api", SID.a);
    expect(await resumeSession(f.deps, SID.a)).toBe("uri");
    expect(f.commands).toHaveLength(3);
  });

  it("cursor gets cursor:// links", async () => {
    const f = fakeDeps({ commandFails: "boom", uriScheme: "cursor" });
    writeSession(f.deps.projectsDir, "/Users/you/src/api", SID.a);
    await resumeSession(f.deps, SID.a);
    expect(f.uris[0]).toMatch(/^cursor:\/\/anthropic\.claude-code\/open/);
  });

  it("an expired transcript says so instead of silently starting a fresh conversation", async () => {
    const f = fakeDeps();
    expect(await resumeSession(f.deps, SID.a)).toBe("expired");
    expect(f.commands).toEqual([]);
    expect(f.warnings[0]).toContain("30 days");
  });

  it("a session id that is not a uuid never reaches a command or a link", async () => {
    const f = fakeDeps();
    expect(await resumeSession(f.deps, "../../x")).toBe("invalid");
    expect(f.commands).toEqual([]);
    expect(f.uris).toEqual([]);
  });

  it("no Claude Code extension -> one warning, nothing thrown", async () => {
    const f = fakeDeps({ activateClaude: async () => false });
    writeSession(f.deps.projectsDir, "/Users/you/src/api", SID.a);
    expect(await resumeSession(f.deps, SID.a)).toBe("missing-claude");
    expect(f.warnings).toHaveLength(1);
  });

  it("the deep link waits for this window to have focus", async () => {
    let focus: (() => void) | undefined;
    const f = fakeDeps({
      commandFails: "boom",
      isFocused: () => false,
      onDidFocus: (cb) => {
        focus = cb;
        return { dispose() {} };
      },
    });
    writeSession(f.deps.projectsDir, "/Users/you/src/api", SID.a);
    const pending = resumeSession(f.deps, SID.a);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.uris).toEqual([]);
    focus!();
    expect(await pending).toBe("uri");
  });
});

describe("starting a new conversation", () => {
  it("the same command with no session: a new panel, the prompt in its input box", async () => {
    const f = fakeDeps();
    expect(await startConversation(f.deps, "tidy the logs")).toBe("command");
    expect(f.commands).toEqual([{ id: CLAUDE_OPEN_COMMAND, args: [undefined, "tidy the logs"] }]);
    expect(f.uris).toEqual([]);
  });

  it("needs no transcript, and an empty prompt is no prompt", async () => {
    const f = fakeDeps();
    expect(await startConversation(f.deps)).toBe("command");
    expect(f.commands[0]!.args).toEqual([undefined, undefined]);
    expect(f.warnings).toEqual([]);
  });

  it("falls back to the deep link without a session, pinned to this window", async () => {
    const f = fakeDeps({ commandFails: "command 'claude-vscode.primaryEditor.open' not found" });
    expect(await startConversation(f.deps, "go & see")).toBe("uri");
    expect(f.commands).toHaveLength(3);
    expect(f.uris).toEqual(["vscode://anthropic.claude-code/open?prompt=go+%26+see"]);
  });

  it("no Claude Code extension -> one warning, no command, no link", async () => {
    const f = fakeDeps({ activateClaude: async () => false });
    expect(await startConversation(f.deps, "x")).toBe("missing-claude");
    expect(f.warnings).toHaveLength(1);
    expect(f.commands).toEqual([]);
    expect(f.uris).toEqual([]);
  });
});
