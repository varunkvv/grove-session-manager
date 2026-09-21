import { describe, expect, it } from "vitest";
import { parseTranscript } from "../../src/transcript/parse.ts";
import { pickTitle } from "../../src/transcript/title.ts";
import { summary, toJsonl, userEntry } from "../helpers/transcript.ts";

describe("title precedence", () => {
  it("summary record beats first prompt", () => {
    const meta = parseTranscript(
      toJsonl([userEntry("first prompt text"), summary("short title")]),
      null,
    );
    expect(pickTitle(meta)).toEqual({ title: "short title", titleSource: "summary" });
    expect(meta.firstPrompt).toBe("first prompt text");
  });

  it("explicit name > agent name > generated title > summary > first prompt > last prompt > command", () => {
    const all = {
      customTitle: "custom",
      agentName: "agent",
      aiTitle: "ai",
      summary: "sum",
      firstPrompt: "first",
      lastPrompt: "last",
      firstCommand: "/cmd",
    };
    const order = [
      "customTitle",
      "agentName",
      "aiTitle",
      "summary",
      "firstPrompt",
      "lastPrompt",
      "firstCommand",
    ] as const;
    const remaining: Record<string, string> = { ...all };
    for (const source of order) {
      expect(pickTitle(remaining).titleSource).toBe(source);
      delete remaining[source];
    }
    expect(pickTitle(remaining)).toEqual({});
  });

  it("whitespace collapsed and capped at 200 chars", () => {
    const { title } = pickTitle({ firstPrompt: `a\n\n  b ${"x".repeat(400)}` });
    expect(title!.startsWith("a b x")).toBe(true);
    expect(title!.length).toBe(200);
    expect(title!.endsWith("…")).toBe(true);
  });

  it("blank values are skipped", () => {
    expect(pickTitle({ customTitle: "   ", aiTitle: "real" }).titleSource).toBe("aiTitle");
  });
});
