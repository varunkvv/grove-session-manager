import { describe, expect, it } from "vitest";
import { buildResumeCommand, isValidSessionId, shellQuote } from "../../src/sessions/resume.ts";
import {
  highlightRanges,
  searchSessions,
  snippetAround,
  tokenize,
} from "../../src/sessions/search.ts";
import { dayBucket, formatRelativeTime } from "../../src/time.ts";
import type { SessionView } from "../../src/types.ts";
import { SID } from "../helpers/transcript.ts";

function view(partial: Partial<SessionView>): SessionView {
  return {
    path: `/p/${partial.sessionId ?? "x"}.jsonl`,
    projectDirName: "-x",
    sessionId: "x",
    mtimeMs: 1,
    size: 1,
    parsed: true,
    activityMs: 1,
    recognized: 1,
    ...partial,
  };
}

const rows = [
  view({
    sessionId: "1",
    title: "ENG-412 testing gap analysis",
    comboName: "prod-debug",
    gitBranch: "dev/eng-412",
  }),
  view({
    sessionId: "2",
    title: "Fix flaky invoice sync",
    firstPrompt: "the queue scheduler drops callbacks",
    cwd: "/Users/you/src/queue",
  }),
  view({
    sessionId: "3",
    title: "Helm chart bump",
    pr: { number: 1042, repo: "acme/queue" },
    lastPrompt: "ok commit it",
  }),
];

describe("searchSessions", () => {
  it("tokens are ANDed, case-insensitive, across title, prompts, combo, branch, cwd basename, PR", () => {
    expect(searchSessions(rows, "eng gap").map((r) => r.sessionId)).toEqual(["1"]);
    expect(searchSessions(rows, "PROD-DEBUG").map((r) => r.sessionId)).toEqual(["1"]);
    expect(searchSessions(rows, "scheduler").map((r) => r.sessionId)).toEqual(["2"]);
    expect(searchSessions(rows, "queue").map((r) => r.sessionId)).toEqual(["2", "3"]);
    expect(searchSessions(rows, "#1042").map((r) => r.sessionId)).toEqual(["3"]);
    expect(searchSessions(rows, "commit").map((r) => r.sessionId)).toEqual(["3"]);
    expect(searchSessions(rows, "queue nothing")).toEqual([]);
  });

  it("an empty query returns everything, in the order given (recency is the ranking)", () => {
    expect(searchSessions(rows, "   ").map((r) => r.sessionId)).toEqual(["1", "2", "3"]);
  });

  it("a raw path is not searchable beyond its basename", () => {
    expect(searchSessions(rows, "/Users/you")).toEqual([]);
  });

  it("quoted phrases stay whole", () => {
    expect(tokenize('flaky "invoice sync" ')).toEqual(["flaky", "invoice sync"]);
    expect(searchSessions(rows, '"sync invoice"')).toEqual([]);
  });

  it("highlight ranges are merged and sorted", () => {
    expect(highlightRanges("Fix flaky invoice sync", ["fla", "laky", "sync"])).toEqual([
      [4, 9],
      [18, 22],
    ]);
    expect(highlightRanges("İstanbul", ["i"])).toEqual([]);
  });

  it("snippet shows why a row matched", () => {
    expect(snippetAround("the queue scheduler drops callbacks", ["scheduler"], 6)).toBe(
      "…queue scheduler drops…",
    );
  });
});

describe("relative time", () => {
  const now = Date.parse("2026-09-20T15:00:00");
  it("never a timestamp", () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe("now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatRelativeTime(now - 21 * 86_400_000, now)).toBe("3w ago");
    expect(formatRelativeTime(now + 60_000, now)).toBe("now");
  });

  it("day buckets", () => {
    // 2026-09-20 is a sunday
    expect(dayBucket(now - 3_600_000, now)).toBe("Today");
    expect(dayBucket(Date.parse("2026-09-19T23:00:00"), now)).toBe("Yesterday");
    expect(dayBucket(Date.parse("2026-09-15T09:00:00"), now)).toBe("This week");
    expect(dayBucket(Date.parse("2026-09-10T09:00:00"), now)).toBe("Last week");
    expect(dayBucket(Date.parse("2026-08-10T09:00:00"), now)).toBe("Older");
  });
});

describe("resume command", () => {
  it("quotes a hostile cwd and refuses a non-uuid id", () => {
    expect(buildResumeCommand(SID.a, "/Users/you/it's here; rm -rf ~")).toBe(
      `cd '/Users/you/it'\\''s here; rm -rf ~' && claude --resume ${SID.a}`,
    );
    expect(buildResumeCommand(SID.a)).toBe(`claude --resume ${SID.a}`);
    expect(() => buildResumeCommand("x; rm -rf ~")).toThrow();
    expect(isValidSessionId(`${SID.a}\n`)).toBe(false);
    expect(shellQuote("a b")).toBe("'a b'");
  });
});
