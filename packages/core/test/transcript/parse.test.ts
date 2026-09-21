import { describe, expect, it } from "vitest";
import { parseLines, parseTranscript } from "../../src/transcript/parse.ts";
import { pickTitle } from "../../src/transcript/title.ts";
import {
  agentName,
  aiTitle,
  assistantEntry,
  customTitle,
  lastPrompt,
  record,
  text,
  toJsonl,
  userEntry,
} from "../helpers/transcript.ts";

describe("head lifts", () => {
  it("cwd and gitBranch from head", () => {
    const meta = parseTranscript(
      toJsonl([
        record("queue-operation", { operation: "enqueue" }),
        userEntry("hello", { cwd: "/Users/you/src/api", gitBranch: "dev/eng-218" }),
      ]),
      null,
    );
    expect(meta.cwd).toBe("/Users/you/src/api");
    expect(meta.gitBranch).toBe("dev/eng-218");
    expect(meta.sessionId).toBe("e4c21fe2-66d7-4dda-b9e9-556afffba8e4");
    expect(meta.entrypoint).toBe("claude-vscode");
    expect(meta.version).toBe("2.1.278");
    expect(meta.createdAt).toBeTypeOf("number");
  });

  it("isSidechain first turn skipped, next used", () => {
    const meta = parseTranscript(
      toJsonl([
        userEntry("subagent task text", { isSidechain: true }),
        userEntry("the real first prompt"),
      ]),
      null,
    );
    expect(meta.firstPrompt).toBe("the real first prompt");
  });

  it("garbage line survives, rest parsed", () => {
    const meta = parseTranscript(
      toJsonl([
        "this is not json {{{",
        '{"truncated": ',
        userEntry("still here"),
        "[1,2,3]",
        aiTitle("Found it"),
      ]),
      null,
    );
    expect(meta.firstPrompt).toBe("still here");
    expect(meta.aiTitle).toBe("Found it");
    expect(meta.recognized).toBe(2);
  });

  it("only the FIRST cwd counts - it drifts later in real sessions", () => {
    const meta = parseTranscript(
      toJsonl([
        userEntry("start", { cwd: "/Users/you/src/docs" }),
        assistantEntry("moved", { cwd: "/Users/you/src/queue", gitBranch: "other" }),
      ]),
      null,
    );
    expect(meta.cwd).toBe("/Users/you/src/docs");
  });

  it("an all-machinery first entry falls through to the next user entry", () => {
    const meta = parseTranscript(
      toJsonl([
        userEntry([text("<ide_opened_file>x</ide_opened_file>")]),
        userEntry("second entry wins"),
      ]),
      null,
    );
    expect(meta.firstPrompt).toBe("second entry wins");
  });

  it("command-only session keeps a command as last-resort title", () => {
    const meta = parseTranscript(toJsonl([userEntry("<command-name>/mcp</command-name>")]), null);
    expect(meta.firstPrompt).toBeUndefined();
    expect(pickTitle(meta)).toEqual({ title: "/mcp", titleSource: "firstCommand" });
  });

  it("junk input never throws and yields nothing", () => {
    expect(parseTranscript("", null)).toEqual({ recognized: 0 });
    expect(parseTranscript("\n\n\u0000\u0001garbage", "more garbage")).toEqual({ recognized: 0 });
    expect(parseLines('{"a":1}\n{"broken\n')).toHaveLength(1);
  });
});

describe("appended metadata records", () => {
  it("title found only in the tail", () => {
    const head = toJsonl([userEntry("first prompt")]);
    const tail = toJsonl([assistantEntry("..."), aiTitle("ENG-412 testing gap analysis")]);
    const meta = parseTranscript(head, tail);
    expect(pickTitle(meta)).toEqual({
      title: "ENG-412 testing gap analysis",
      titleSource: "aiTitle",
    });
  });

  it("the last of two ai-titles wins, and the tail beats the head", () => {
    const head = toJsonl([userEntry("p"), aiTitle("old head title")]);
    const tail = toJsonl([aiTitle("first tail title"), aiTitle("final title")]);
    expect(parseTranscript(head, tail).aiTitle).toBe("final title");
    expect(parseTranscript(toJsonl([aiTitle("one"), aiTitle("two")]), null).aiTitle).toBe("two");
  });

  it("customTitle: tail > sidecar > head", () => {
    const head = toJsonl([userEntry("p"), customTitle("head name")]);
    expect(
      parseTranscript(head, toJsonl([customTitle("tail name")]), "sidecar name").customTitle,
    ).toBe("tail name");
    expect(parseTranscript(head, toJsonl([assistantEntry("x")]), "sidecar name").customTitle).toBe(
      "sidecar name",
    );
    expect(parseTranscript(head, toJsonl([assistantEntry("x")])).customTitle).toBe("head name");
  });

  it("agent-name sits between custom title and generated title", () => {
    const meta = parseTranscript(
      toJsonl([userEntry("p"), aiTitle("generated"), agentName("named at startup")]),
      null,
    );
    expect(pickTitle(meta).titleSource).toBe("agentName");
  });

  it("lastPrompt: null is a reset marker, not a title", () => {
    const meta = parseTranscript(
      toJsonl([lastPrompt(null), userEntry("<command-name>/x</command-name>")]),
      null,
    );
    expect(meta.lastPrompt).toBeUndefined();
    expect(pickTitle(meta).title).toBe("/x");
    const later = parseTranscript(toJsonl([lastPrompt("real last"), lastPrompt(null)]), null);
    expect(later.lastPrompt).toBe("real last");
  });

  it("lastActivityMs is the newest user/assistant timestamp, not a metadata record", () => {
    const tail = toJsonl([
      assistantEntry("a", { timestamp: "2026-09-01T10:00:00.000Z" }),
      userEntry("b", { timestamp: "2026-09-02T12:30:00.000Z" }),
      aiTitle("appended two weeks later, carries no timestamp"),
    ]);
    const meta = parseTranscript(toJsonl([userEntry("p")]), tail);
    expect(meta.lastActivityMs).toBe(Date.parse("2026-09-02T12:30:00.000Z"));
  });

  it("gitBranch prefers the tail, pr-link and tag are lifted", () => {
    const head = toJsonl([userEntry("p", { gitBranch: "main" })]);
    const tail = toJsonl([
      assistantEntry("x", { gitBranch: "vv/feature" }),
      record("pr-link", {
        prNumber: 1042,
        prUrl: "https://github.com/o/r/pull/1042",
        prRepository: "o/r",
      }),
      record("tag", { tag: "incident" }),
    ]);
    const meta = parseTranscript(head, tail);
    expect(meta.gitBranch).toBe("vv/feature");
    expect(meta.pr).toEqual({ number: 1042, url: "https://github.com/o/r/pull/1042", repo: "o/r" });
    expect(meta.tag).toBe("incident");
  });

  it("'HEAD' and '.invalid' are not branches (detached checkout, reftable repo)", () => {
    const head = toJsonl([userEntry("p", { gitBranch: "vv/real" })]);
    expect(
      parseTranscript(head, toJsonl([assistantEntry("x", { gitBranch: ".invalid" })])).gitBranch,
    ).toBe("vv/real");
    expect(
      parseTranscript(toJsonl([userEntry("p", { gitBranch: "HEAD" })]), null).gitBranch,
    ).toBeUndefined();
  });

  it("only a positively identified teleport marker is a stub", () => {
    expect(parseTranscript('{"type":"teleported-from","messageCount":0}\n', null).stub).toBe(true);
    expect(parseTranscript(toJsonl([userEntry("p")]), null).stub).toBeUndefined();
    expect(parseTranscript("garbage\n", null).stub).toBeUndefined();
  });

  it("a transcript that talks about transcripts cannot hijack a field", () => {
    const meta = parseTranscript(
      toJsonl([userEntry('grep for "customTitle":"evil" and "aiTitle":"also evil" in the file')]),
      null,
    );
    expect(meta.customTitle).toBeUndefined();
    expect(meta.aiTitle).toBeUndefined();
  });
});
