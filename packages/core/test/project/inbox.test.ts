import { describe, expect, it } from "vitest";
import type { SessionFacts } from "../../src/project/derive.ts";
import { buildInbox, type InboxRow } from "../../src/project/inbox.ts";
import type { LiveState, LiveStatus } from "../../src/types.ts";

const T0 = Date.parse("2026-10-02T10:00:00.000Z");
const ms = (min: number) => T0 + min * 60_000;

const live = (state: LiveState, at: number, o: Partial<LiveStatus> = {}): LiveStatus => ({
  state,
  at: ms(at),
  lastEventAt: ms(at),
  ...o,
});

const session = (id: string, o: Partial<SessionFacts> = {}): SessionFacts => ({
  sessionId: id,
  ...o,
});

const inbox = (sessions: SessionFacts[], reviewed: string[] = []): InboxRow[] =>
  buildInbox({ project: "p", sessions, reviewed: new Set(reviewed) });

describe("the inbox", () => {
  it("has one row for each session that needs the person, newest first, and none for the others", () => {
    const rows = inbox([
      session("perm", {
        live: live("permission", 1, { detail: "Bash", target: "pnpm test --filter hooks" }),
      }),
      session("turn", {
        live: live("waiting", 4, { detail: "Done. Want me to…", question: "Want me to open it?" }),
      }),
      session("failed", { live: live("failed", 2, { detail: "API Error: 529 Overloaded" }) }),
      session("cut", { interrupted: { why: "gone", at: ms(3) }, lastPrompt: "Wire  the\nroute" }),
      session("working", { live: live("running", 9) }),
      session("seen", { live: live("waiting", 9, { seen: true }) }),
      session("idle"),
    ]);
    expect(rows.map((r) => [r.id, r.kind, r.at, r.summary])).toEqual([
      ["turn", "turn", ms(4), "Want me to open it?"],
      ["cut", "stopped", ms(3), "Wire the route"],
      ["failed", "failed", ms(2), "API Error: 529 Overloaded"],
      ["perm", "permission", ms(1), "Bash pnpm test --filter hooks"],
    ]);
    expect(rows[0]?.project).toBe("p");
    expect(rows.map((r) => r.reviewKeys)).toEqual([
      ["seen:turn"],
      [`stopped:cut@${ms(3)}`],
      ["seen:failed"],
      ["seen:perm"],
    ]);
  });

  it("says what it can when a status carries little", () => {
    const rows = inbox([
      session("a", { live: live("permission", 1) }),
      session("b", { live: live("failed", 2) }),
      session("c", { live: live("waiting", 3, { detail: "Done." }) }),
      session("d", { interrupted: { why: "failed" }, live: live("running", 4) }),
    ]);
    expect(rows.map((r) => [r.id, r.summary, r.at])).toEqual([
      // a failure the supervisor reported has no time of its own: the status's
      ["d", "", ms(4)],
      ["c", "Done.", ms(3)],
      ["b", "Stopped on an API error", ms(2)],
      ["a", "", ms(1)],
    ]);
    expect(rows[0]?.reviewKeys).toEqual(["stopped:d@failed"]);
  });

  it("a session that stopped while it asked is one Stopped row, and Dismiss clears both", () => {
    const both = session("s", {
      interrupted: { why: "gone", at: ms(5) },
      live: live("permission", 2, { detail: "Bash" }),
    });
    const [row, ...rest] = inbox([both]);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ kind: "stopped", at: ms(5) });
    expect(row?.reviewKeys).toEqual([`stopped:s@${ms(5)}`, "seen:s"]);
  });

  it("a mark hides the stop it was made for, and not what the session asks after it or a later stop", () => {
    const mark = `stopped:s@${ms(5)}`;
    const cut = { why: "gone", at: ms(5) } as const;
    expect(inbox([session("s", { interrupted: cut })], [mark])).toEqual([]);
    expect(
      inbox([session("s", { interrupted: cut, live: live("waiting", 7) })], [mark]),
    ).toMatchObject([{ kind: "turn", at: ms(7), reviewKeys: ["seen:s"] }]);
    expect(
      inbox([session("s", { interrupted: { why: "gone", at: ms(8) } })], [mark]),
    ).toMatchObject([{ kind: "stopped", reviewKeys: [`stopped:s@${ms(8)}`] }]);
  });
});
