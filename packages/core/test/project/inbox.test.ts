import type { Card, ClaimEvent, Conclusion, Question } from "@grove/record/types";
import { describe, expect, it } from "vitest";
import type { SessionFacts } from "../../src/project/derive.ts";
import { buildInbox, type InboxRow, oneLine, trayCount } from "../../src/project/inbox.ts";
import type { LiveState, LiveStatus } from "../../src/types.ts";

const T0 = Date.parse("2026-10-02T10:00:00.000Z");
/** minutes after T0, as the record writes it */
const t = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ms = (min: number) => T0 + min * 60_000;

const agent = (session: string, at: string) =>
  ({ by: "agent", session, agent: `agent ${session}`, at }) as const;

function card(id: string, o: Partial<Card> = {}): Card {
  return {
    ...agent("s1", t(0)),
    id,
    title: `title ${id}`,
    body: `\nfirst line of ${id}\nsecond line`,
    needs: [],
    file: "",
    problems: [],
    status: "todo",
    holder: null,
    claims: [],
    comments: [],
    questions: [],
    asksPerson: false,
    lastActivity: t(0),
    ...o,
  };
}

/** an in-progress card held by `session` since `since` */
function held(id: string, session: string, since: number, o: Partial<Card> = {}): Card {
  return card(id, {
    status: "in_progress",
    holder: { session, agent: `agent ${session}`, pid: 1, pidStart: "", host: "", since: t(since) },
    claims: [claim(id, 1, "claim", session, since)],
    ...o,
  });
}

function claim(c: string, seq: number, event: string, session: string, at: number, body = "") {
  return {
    ...agent(session, t(at)),
    card: c,
    seq,
    event,
    pid: 1,
    pidStart: "",
    host: "",
    via: "mcp",
    prev: seq - 1,
    prevSession: "",
    note: "",
    body,
    artifacts: [],
    file: "",
    problems: [],
  } satisfies ClaimEvent;
}

function question(c: string, seq: number, session: string, at: number, text: string): Question {
  return {
    ...agent(session, t(at)),
    card: c,
    seq,
    kind: "question",
    to: "person",
    text,
    artifacts: [],
    file: "",
    problems: [],
    open: true,
    answeredBy: [],
  };
}

function conclusion(id: string, o: Partial<Conclusion> = {}): Conclusion {
  const kind = id.startsWith("D") ? "decision" : id.startsWith("F") ? "finding" : "verdict";
  return {
    ...agent("s1", t(0)),
    id,
    kind,
    what: `what ${id}`,
    why: "",
    related: [],
    changesPlan: false,
    sources: [],
    file: "",
    problems: [],
    replacedBy: [],
    superseded: false,
    ...o,
  };
}

const live = (state: LiveState, at: number, o: Partial<LiveStatus> = {}): LiveStatus => ({
  state,
  at: ms(at),
  lastEventAt: ms(at),
  ...o,
});

function session(id: string, o: Partial<SessionFacts> = {}): [string, SessionFacts] {
  return [id, { sessionId: id, title: `session ${id}`, project: "p", runtime: "vscode", ...o }];
}

function inbox(o: {
  cards?: Card[];
  conclusions?: Conclusion[];
  sessions?: [string, SessionFacts][];
  reviewed?: string[];
}): InboxRow[] {
  return buildInbox({
    project: { id: "p", name: "project" },
    cards: o.cards ?? [],
    conclusions: o.conclusions ?? [],
    sessions: new Map(o.sessions ?? []),
    reviewed: new Set(o.reviewed ?? []),
  });
}

const brief = (rows: InboxRow[]) => rows.map((r) => [r.id, r.reviewKeys]);

describe("the inbox", () => {
  it("puts Asked and Stopped first, newest first, then every other row newest first", () => {
    const rows = inbox({
      cards: [
        card("P-1", { at: t(30) }),
        card("P-2", { questions: [question("P-2", 1, "s1", 10, "8h or 24h?")], asksPerson: true }),
        held("P-3", "s3", 1),
      ],
      conclusions: [conclusion("D-1", { at: t(40) }), conclusion("V-1", { at: t(20) })],
      sessions: [session("s3", { interrupted: { why: "gone", at: ms(5) } })],
    });
    expect(rows.map((r) => r.id)).toEqual([
      "asked:P-2",
      "stopped:s3",
      "decided:D-1",
      "new:P-1",
      "verdict:V-1",
      "new:P-2",
      "new:P-3",
    ]);
    expect(rows.map((r) => r.at)).toEqual([ms(10), ms(5), ms(40), ms(30), ms(20), ms(0), ms(0)]);
    expect(trayCount(rows)).toBe(2);
    expect(rows.every((r) => r.project === "p")).toBe(true);
  });

  it("gives a card one Asked row for a question and a waiting holder both", () => {
    const rows = inbox({
      cards: [
        held("P-1", "s1", 0, {
          by: "person",
          questions: [
            question("P-1", 1, "s1", 1, "which tenant?"),
            question("P-1", 2, "s1", 3, "8h,\n to match   the policy?"),
            { ...question("P-1", 3, "s1", 4, "a question to another card"), to: "P-2" },
            { ...question("P-1", 4, "s1", 4, "answered"), open: false, answeredBy: [5] },
          ],
          asksPerson: true,
        }),
      ],
      sessions: [session("s1", { live: live("waiting", 9, { question: "anything else?" }) })],
    });
    expect(rows).toEqual([
      {
        id: "asked:P-1",
        project: "p",
        kind: "asked",
        at: ms(9),
        card: { id: "P-1", title: "title P-1" },
        title: "title P-1",
        who: { sessionId: "s1", name: "session s1" },
        sessionId: "s1",
        summary: "8h, to match the policy?",
        reviewKeys: ["question:P-1#1", "question:P-1#2", "seen:s1"],
      },
    ]);
  });

  it("asks on the session's own row when it holds no card here", () => {
    const rows = inbox({
      sessions: [
        session("s1", { live: live("permission", 3, { detail: "Bash", target: "git push" }) }),
        session("s2", { live: live("failed", 2) }),
        session("s3", { live: live("permission", 1), title: undefined }),
        session("s4", { live: live("waiting", 4, { seen: true }) }),
        session("s5", { live: live("waiting", 4), project: "other" }),
        session("s6", { live: live("running", 4) }),
      ],
    });
    expect(rows.map((r) => [r.id, r.title, r.summary, r.reviewKeys])).toEqual([
      ["asked:session:s1", "session s1", "Needs permission: Bash git push", ["seen:s1"]],
      ["asked:session:s2", "session s2", "Stopped on an API error", ["seen:s2"]],
      ["asked:session:s3", "Claude session", "Needs permission", ["seen:s3"]],
    ]);
  });

  it("a session holding two cards asks on the one it took last. its questions stay on their own", () => {
    const rows = inbox({
      cards: [
        held("P-1", "s1", 0, {
          questions: [question("P-1", 1, "s1", 1, "which one?")],
          asksPerson: true,
        }),
        held("P-2", "s1", 3),
      ],
      sessions: [session("s1", { live: live("waiting", 5, { detail: "done with the first" }) })],
      reviewed: ["card:P-1", "card:P-2"],
    });
    expect(rows.map((r) => [r.id, r.summary, r.reviewKeys])).toEqual([
      ["asked:P-2", "done with the first", ["seen:s1"]],
      ["asked:P-1", "which one?", ["question:P-1#1"]],
    ]);
  });

  it("takes agents' decisions and verdicts, and only the findings that change the plan", () => {
    const rows = inbox({
      cards: [card("P-1", { by: "person" })],
      conclusions: [
        conclusion("D-1", { card: "P-1", at: t(6) }),
        conclusion("D-2", { by: "person", at: t(5) }),
        conclusion("D-3", { superseded: true, replacedBy: ["D-4"], at: t(4) }),
        conclusion("F-1", { at: t(3) }),
        conclusion("F-2", { changesPlan: true, at: t(2) }),
        conclusion("V-1", { at: t(1), sub: "researcher" }),
      ],
    });
    expect(rows.map((r) => [r.id, r.title, r.summary, r.card?.id, r.reviewKeys])).toEqual([
      ["decided:D-1", "title P-1", "what D-1", "P-1", ["conclusion:D-1"]],
      ["found:F-2", "what F-2", "what F-2", undefined, ["conclusion:F-2"]],
      ["verdict:V-1", "what V-1", "what V-1", undefined, ["conclusion:V-1"]],
    ]);
    expect(rows[2]).toMatchObject({
      conclusionId: "V-1",
      who: { sessionId: "s1", name: "agent s1", sub: "researcher" },
      sessionId: "s1",
    });
  });

  it("a card made and finished before anyone looked is one Finished row with both keys", () => {
    const done = held("P-1", "s1", 0, {
      status: "done",
      holder: null,
      claims: [
        claim("P-1", 1, "claim", "s1", 0),
        claim("P-1", 2, "done", "s1", 7, "PR #2291 merged,\nchecks passed."),
        // an unknown word after done changes nothing
        claim("P-1", 3, "frobnicate", "s1", 8),
      ],
    });
    const rows = inbox({ cards: [done] });
    expect(rows).toMatchObject([
      {
        id: "finished:P-1",
        kind: "finished",
        at: ms(7),
        summary: "PR #2291 merged, checks passed.",
        reviewKeys: ["finished:P-1#2", "card:P-1"],
      },
    ]);
    expect(brief(inbox({ cards: [done], reviewed: ["card:P-1"] }))).toEqual([
      ["finished:P-1", ["finished:P-1#2"]],
    ]);
    expect(brief(inbox({ cards: [{ ...done, by: "person" }] }))).toEqual([
      ["finished:P-1", ["finished:P-1#2"]],
    ]);
  });

  it("a summary is the agent's markdown as one line of words: no heading, bold or code markers", () => {
    const done = (body: string) =>
      inbox({
        cards: [
          held("P-1", "s1", 0, {
            status: "done",
            holder: null,
            by: "person",
            claims: [claim("P-1", 1, "claim", "s1", 0), claim("P-1", 2, "done", "s1", 7, body)],
          }),
        ],
      })[0]?.summary;
    expect(done("## Summary\n\nOkta wants a **web** app. **Not done:** the secret.")).toBe(
      "Summary Okta wants a web app. Not done: the secret.",
    );
    // a `**` that is not bold stays, and so does a backtick with no pair on its line
    expect(done("Ran `pnpm test` over `src/**/*.ts` and lib/**/*.ts, 2**10 cases, a ` left")).toBe(
      "Ran pnpm test over src/**/*.ts and lib/**/*.ts, 2**10 cases, a ` left",
    );
    expect(oneLine("**Use** `redis` for sessions")).toBe("Use redis for sessions");
  });

  it("a new card is one an agent made, summed up by its first line", () => {
    const rows = inbox({ cards: [card("P-1"), card("P-2", { by: "person" })] });
    expect(rows).toMatchObject([
      { id: "new:P-1", summary: "first line of P-1", who: { name: "agent s1" }, sessionId: "s1" },
    ]);
  });

  it("leaves canceled cards out, questions and all", () => {
    const rows = inbox({
      cards: [
        card("P-1", {
          status: "canceled",
          questions: [question("P-1", 1, "s1", 1, "still?")],
          asksPerson: true,
        }),
      ],
    });
    expect(rows).toEqual([]);
  });

  it("a stopped session sits on the card it holds, else on its own row", () => {
    const rows = inbox({
      cards: [held("P-1", "s1", 0), held("P-2", "s1", 2)],
      sessions: [
        session("s1", {
          interrupted: { why: "gone", at: ms(9) },
          lastPrompt: "fix   the login\nredirect",
        }),
        session("s2", { interrupted: { why: "failed" }, live: live("failed", 4) }),
        session("s3", { interrupted: { why: "gone", at: ms(5) }, project: "other" }),
      ],
      reviewed: ["card:P-1", "card:P-2"],
    });
    expect(rows.map((r) => [r.id, r.at, r.card?.id, r.title, r.summary, r.reviewKeys])).toEqual([
      [
        "stopped:s1",
        ms(9),
        "P-2",
        "title P-2",
        "Stopped mid-turn. It was working on: fix the login redirect",
        [`stopped:s1@${ms(9)}`],
      ],
      ["asked:session:s2", ms(4), undefined, "session s2", "Stopped on an API error", ["seen:s2"]],
      ["stopped:s2", ms(4), undefined, "session s2", "Stopped mid-turn.", ["stopped:s2@failed"]],
    ]);
  });

  it("drops every row whose keys are all marked. an Asked row goes when its input changes", () => {
    const o = {
      cards: [
        card("P-1"),
        card("P-2", { questions: [question("P-2", 1, "s1", 1, "?")], asksPerson: true }),
        { ...held("P-3", "s3", 0), status: "done" as const, holder: null },
        held("P-4", "s4", 0),
      ],
      conclusions: [conclusion("D-1"), conclusion("V-1"), conclusion("F-1", { changesPlan: true })],
      sessions: [
        session("s3"),
        session("s4", { interrupted: { why: "gone", at: ms(3) } }),
        session("s5", { live: live("waiting", 2) }),
      ],
    } satisfies Parameters<typeof inbox>[0];
    o.cards[2]!.claims.push(claim("P-3", 2, "done", "s3", 2, "done"));
    const all = inbox(o);
    expect(new Set(all.map((r) => r.kind))).toEqual(
      new Set(["asked", "decided", "verdict", "found", "new", "finished", "stopped"]),
    );
    // what main stores. question: and seen: keys answer the question or mark the session seen
    const reviewed = all.flatMap((r) => r.reviewKeys).filter((k) => !/^(question|seen):/.test(k));
    expect(brief(inbox({ ...o, reviewed }))).toEqual([
      ["asked:session:s5", ["seen:s5"]],
      ["asked:P-2", ["question:P-2#1"]],
    ]);
  });
});
