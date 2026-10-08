import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationFold } from "../../src/sessions/conversation.ts";
import { readConversation } from "../../src/sessions/conversationFile.ts";
import {
  parseRecap,
  RECAP_LINE_MAX,
  recapDigest,
  recapLine,
  recapPrompt,
} from "../../src/sessions/recap.ts";
import {
  apiErrorMessage,
  call,
  compactBoundary,
  compactSummary,
  prompt,
  queued,
  result,
  says,
  taskNotification,
  text,
  userLine,
} from "../helpers/sessionTranscript.ts";

// a stretch of a real 107MB session, every string replaced: three compactions, 30 turns
const FIXTURE = path.join(
  import.meta.dirname,
  "../fixtures/conversation/78b60000-0000-4000-8000-000000000001.jsonl",
);

function digest(lines: object[], o: { title?: string; now?: string } = {}): string {
  const fold = new ConversationFold();
  let offset = 0;
  for (const l of lines) {
    const line = JSON.stringify(l);
    fold.line(line, offset, line.length);
    offset += line.length + 1;
  }
  return recapDigest(fold.state, o);
}

describe("the digest a recap is written from", () => {
  it("is every part of a real session, in order, and small", async () => {
    const d = recapDigest(await readConversation(FIXTURE), { title: "the fixture" });
    const parts = [
      "title: the fixture",
      "what the person typed, oldest first:",
      "more …",
      "claude code's own summary of the earlier part of the session:",
      "files it edited: ",
      // its last turn called no tool: a question about two pasted images, answered in words
      "the message its last turn ended on:",
    ];
    const at = parts.map((p) => d.indexOf(p));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // the first 3 prompts and the last 8, with the count of what was left out between them
    const typed = d.slice(at[1], at[3]).split("\n").slice(1, -2);
    expect(typed).toHaveLength(12);
    expect(typed[3]).toMatch(/^ {2}… \d+ more …$/);
    expect(d.length).toBeLessThan(12_000);
  });

  it("keeps what was typed while it worked, and a command only when it has words", () => {
    const d = digest([
      prompt("look at the logs", 0),
      says("m1", call("t1", "Read", { file_path: "/work/api/app.log" }), 2),
      result("t1", "THE TOOL OUTPUT", 3),
      queued("and the metrics too", 4),
      says("m2", text("Both say the same."), 6),
      userLine([text("<command-name>/model</command-name><command-args></command-args>")], 7),
      userLine(
        [text("<command-name>/loop</command-name><command-args>watch the rollout</command-args>")],
        8,
      ),
    ]);
    expect(d).toContain(
      "  - look at the logs\n  - and the metrics too\n  - /loop watch the rollout",
    );
    expect(d).not.toContain("/model");
    expect(d).not.toContain("THE TOOL OUTPUT");
  });

  it("names the files edited, and the last turn's tool calls by name and target", () => {
    const d = digest([
      prompt("fix the parser", 0),
      says("m1", call("t1", "Edit", { file_path: "/work/api/src/parse.ts" }), 1),
      result("t1", "ok", 2),
      says("m2", text("Fixed."), 3),
      prompt("now run the tests", 10),
      says("m3", call("t2", "Bash", { command: "pnpm test" }), 11),
      result("t2", "40 passed", 12),
      says("m4", call("t3", "Write", { file_path: "/work/api/notes.md" }), 13),
      result("t3", "ok", 14),
      says("m5", text("All 40 pass. Shall I commit?"), 15),
    ]);
    expect(d).toContain("files it edited: parse.ts, notes.md");
    expect(d).toContain(
      "its last turn (2 tool calls). the last of them:\n  Bash pnpm test\n  Write",
    );
    expect(d).not.toContain("Edit /work");
    expect(d).toContain("the message its last turn ended on:\nAll 40 pass. Shall I commit?");
  });

  it("a background task's news is not the person: the message before it is still the last word", () => {
    const d = digest([
      prompt("start the build", 0),
      says("m1", call("t1", "Bash", { command: "make", run_in_background: true }), 1),
      result("t1", "started", 2),
      says("m2", text("The build is running."), 3),
      taskNotification("Background command make completed", 60),
      says("m3", call("t2", "Bash", { command: "ls dist" }), 61),
      result("t2", "app.js", 62),
    ]);
    expect(d).toContain("its last turn (2 tool calls)");
    expect(d).toContain("the message its last turn ended on:\nThe build is running.");
  });

  it("a turn that stopped before it said anything hands the last word to the person", () => {
    const d = digest(
      [
        prompt("which db?", 0),
        says("m1", text("Postgres or mysql. Which one?"), 1),
        prompt("postgres, and add the migration", 10),
        userLine([text("[Request interrupted by user]")], 11),
      ],
      { now: "it stopped mid-turn" },
    );
    const before = d.indexOf("the message it ended on BEFORE the person last typed:");
    const answered = d.indexOf(
      "the person answered that with the last thing they typed: postgres, and add the migration",
    );
    expect(before).toBeGreaterThan(0);
    expect(answered).toBeGreaterThan(before);
    expect(d).toContain("its last turn was interrupted before it finished.");
    expect(d.endsWith("right now: it stopped mid-turn")).toBe(true);
  });

  it("says what it put to the person and has no answer to, and what it stopped on", () => {
    const asked = digest([
      prompt("plan it", 0),
      says(
        "m1",
        call("q1", "AskUserQuestion", {
          questions: [{ question: "Which db?", options: [{ label: "pg" }, { label: "mysql" }] }],
        }),
        1,
      ),
    ]);
    expect(asked).toContain("it asked the person, who has not answered: Which db? (pg / mysql)");
    const planned = digest([
      prompt("plan it", 0),
      says("m1", call("p1", "ExitPlanMode", { plan: "# the plan\n\n1. migrate" }), 1),
    ]);
    expect(planned).toContain(
      "it proposed a plan and waits for the person to approve it: # the plan",
    );
    const failed = digest([prompt("go", 0), says("m1", text("Starting."), 1), apiErrorMessage(2)]);
    expect(failed).toContain("its last turn stopped on an error: API Error: 529");
    expect(failed).toContain(
      "its last turn did not end on a message. the last thing it said in it:",
    );
  });

  it("stays small whatever the session holds, and keeps the end of a long message", () => {
    const long = (word: string, n: number) => `${word} `.repeat(n);
    const lines: object[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(prompt(`${i} ${long("prompt", 2000)}`, i * 10));
      for (let t = 0; t < 30; t++) {
        lines.push(
          says(
            `m${i}-${t}`,
            call(`t${i}-${t}`, "Edit", { file_path: `/work/${long("d", 40)}/f${i}-${t}.ts` }),
            i * 10 + 1,
          ),
        );
      }
      lines.push(says(`a${i}`, text(`${long("said", 3000)} THE END ${i}`), i * 10 + 5));
    }
    lines.splice(
      200,
      0,
      compactBoundary(55),
      compactSummary(`Summary: ${long("earlier", 5000)}`, 55),
    );
    const d = digest(lines, { title: long("title", 200), now: long("now", 200) });
    expect(recapPrompt(d).length).toBeLessThan(13_000);
    expect(d).toContain("THE END 39");
    expect(d).toContain("… 29 more …");
  });

  it("has something to say of a session nobody typed in", () => {
    expect(digest([])).toBe("title: (none)\n\nwhat the person typed, oldest first:\n  (nothing)");
  });
});

describe("the answer, parsed", () => {
  const GOOD = "goal: ship the recap\ndone: wrote the digest\nstate: tests pass\nneeds: review it";

  it("is four labelled lines, in order", () => {
    expect(parseRecap(GOOD)).toEqual({
      goal: "ship the recap",
      done: "wrote the digest",
      state: "tests pass",
      needs: "review it",
    });
    // what haiku really sends: a blank line between them, and a capital now and then
    expect(parseRecap(`\n${GOOD.replaceAll("\n", "\n\n").replace("goal", "Goal")}\n`)).toEqual(
      parseRecap(GOOD),
    );
  });

  it("is nothing when it is anything else", () => {
    for (const bad of [
      "",
      "I cannot summarise this session.",
      // a preamble
      `Here is the refresher:\n${GOOD}`,
      // a line more
      `${GOOD}\nhope that helps`,
      // a label missing, out of order, twice, or with nothing after it
      GOOD.replace("state: tests pass\n", ""),
      "done: a\ngoal: b\nstate: c\nneeds: d",
      "goal: a\ngoal: b\nstate: c\nneeds: d",
      GOOD.replace("wrote the digest", " "),
      // markdown is not the four lines
      GOOD.replace("goal:", "**goal:**"),
    ]) {
      expect(parseRecap(bad), bad).toBeNull();
    }
  });

  it("cuts a line the model let run on", () => {
    const r = parseRecap(GOOD.replace("review it", "x".repeat(900)));
    expect(r?.needs).toHaveLength(RECAP_LINE_MAX);
    expect(r?.needs.endsWith("…")).toBe(true);
  });

  it("gives a row what the person has to do, or where it stands when that is nothing", () => {
    const r = parseRecap(GOOD)!;
    expect(recapLine(r)).toBe("review it");
    expect(recapLine({ ...r, needs: "Nothing." })).toBe("tests pass");
    expect(recapLine({ ...r, needs: "nothing" })).toBe("tests pass");
    expect(recapLine({ ...r, needs: "Nothing unless you want the write scopes" })).toBe(
      "Nothing unless you want the write scopes",
    );
  });
});
