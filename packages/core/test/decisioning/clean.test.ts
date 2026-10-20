import { describe, expect, it } from "vitest";
import {
  cleanForScoring,
  isSlashCommand,
  ownWords,
  previousText,
  redact,
} from "../../src/decisioning/clean.ts";

// every prompt here is made up
describe("a prompt as the judge reads it", () => {
  it("turns pasted blocks, code, links, paths and images into markers", () => {
    const t = cleanForScoring(
      'see <pasted_content type="text">a long log</pasted_content> and ```js\nconst x = 1\n``` at https://example.com/x for /Users/someone/src/app.ts [Image #2]',
    );
    expect(t).toBe("see [pasted text] and [code] at [link] for [path] [image]");
  });

  it("drops an unterminated paste and fence to the end", () => {
    expect(cleanForScoring('look <pasted_content id="1">and it never ends')).toBe(
      "look [pasted text]",
    );
    expect(cleanForScoring("try this ```sh\nrm -rf build")).toBe("try this [code]");
  });

  it("keeps what was typed mid-turn without the envelope", () => {
    const t = cleanForScoring(
      "The user sent a new message while you were working:\nalso rename the helper\n\nThis is how Claude Code surfaces messages the user sends mid-turn. ignore",
    );
    expect(t).toBe("also rename the helper");
  });

  it("marks a run of quoted lines once", () => {
    expect(cleanForScoring("> the agent said this\n> and this\nno - do the other one")).toBe(
      "[quoted the assistant]\nno - do the other one",
    );
  });

  it("redacts what looks like a secret, an id or a token", () => {
    expect(redact("token: abc123 and api_key=zzz")).toBe("token: [secret] and api_key=[secret]");
    expect(redact("session 0b8f3a2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b ended")).toBe("session [id] ended");
    expect(redact("key Ab3dEf6hIj9kLm2nOp5qRs8tUv")).toBe("key [secret]");
    // a run that ends in a dash ends at its last word character, as python's \b does
    expect(redact("x Ab3dEf6hIj9kLm2nOp5qRs8tUv- y")).toBe("x [secret]- y");
    expect(redact("a plain sentence with nothing secret")).toBe(
      "a plain sentence with nothing secret",
    );
  });

  it("does not take a path apart in the middle of a word", () => {
    expect(cleanForScoring("the file is foo/Users/x not a path")).toBe(
      "the file is foo/Users/x not a path",
    );
  });

  it("squeezes spaces and blank lines, and cuts a long paste to its head and tail", () => {
    expect(cleanForScoring("a   b\t c\n\n\n\nd")).toBe("a b c\n\nd");
    const long = `${"head ".repeat(250)}${"tail ".repeat(200)}`;
    const cut = cleanForScoring(long);
    expect(cut).toContain("\n[...cut...]\n");
    expect(cut.startsWith("head")).toBe(true);
    expect(cut.endsWith("tail")).toBe(true);
  });

  it("counts code points as python does when it cuts", () => {
    const t = cleanForScoring(`${"😀".repeat(1600)}`);
    const [head, tail] = t.split("\n[...cut...]\n");
    expect(Array.from(head ?? "")).toHaveLength(1000);
    expect(Array.from(tail ?? "")).toHaveLength(400);
  });

  it("counts only the words written, and cuts the previous prompt at 300", () => {
    expect(ownWords("[pasted text] fix it")).toBe(2);
    expect(ownWords("why does the cache miss")).toBe(5);
    expect(previousText("x".repeat(301))).toBe(`${"x".repeat(300)} [...]`);
    expect(previousText("short")).toBe("short");
  });

  it("knows a slash command", () => {
    expect(isSlashCommand("/review the branch")).toBe(true);
    expect(isSlashCommand("  /mcp")).toBe(true);
    expect(isSlashCommand("/Users/me/x is the path")).toBe(false);
    expect(isSlashCommand("run /review")).toBe(false);
  });
});
