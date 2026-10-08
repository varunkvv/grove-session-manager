import { describe, expect, it } from "vitest";
import { AppError } from "../../src/main/errors.ts";
import { parseStartAgent } from "../../src/main/services/startAgent.ts";

describe("the request as the page sent it", () => {
  it("keeps a background session's ask as typed, trimmed", () => {
    expect(
      parseStartAgent({ project: "chat", where: "background", prompt: "  run the suite\n" }),
    ).toEqual({ project: "chat", where: "background", prompt: "run the suite" });
    expect(
      parseStartAgent({
        project: "chat",
        where: "background",
        prompt: "run the suite",
        throughTerminal: true,
      }),
    ).toEqual({
      project: "chat",
      where: "background",
      prompt: "run the suite",
      throughTerminal: true,
    });
  });

  it("the editor takes no ask: a plain new conversation, whatever was sent", () => {
    for (const raw of [
      { project: "chat", where: "editor" },
      { project: "chat", where: "editor", prompt: "fix the login page" },
      // the editor path has no terminal either
      { project: "chat", where: "editor", prompt: 4, throughTerminal: true },
    ]) {
      expect(parseStartAgent(raw), JSON.stringify(raw)).toEqual({
        project: "chat",
        where: "editor",
        prompt: "",
      });
    }
  });

  it("the background needs one: claude --bg has nothing to do without it", () => {
    for (const raw of [
      { project: "chat", where: "background" },
      { project: "chat", where: "background", prompt: " \n " },
    ]) {
      try {
        parseStartAgent(raw);
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe("no-prompt");
        continue;
      }
      throw new Error(`started: ${JSON.stringify(raw)}`);
    }
  });

  it("a pasted wall of text is cut", () => {
    const got = parseStartAgent({
      project: "chat",
      where: "background",
      prompt: "x".repeat(30_000),
    });
    expect(got.prompt).toHaveLength(20_000);
  });

  it("refuses anything else", () => {
    for (const raw of [
      null,
      "chat",
      { where: "editor" },
      { project: "", where: "editor" },
      { project: "chat", where: "terminal" },
    ]) {
      expect(() => parseStartAgent(raw), JSON.stringify(raw)).toThrow(AppError);
    }
  });
});
