import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sessionTail, TAIL_PROMPT_MAX, TAIL_TEXT_MAX } from "../../src/sessions/tail.ts";
import {
  apiErrorMessage,
  call,
  command,
  hookNoise,
  jsonl,
  prompt,
  queued,
  result,
  says,
  taskNotification,
  text,
  title,
} from "../helpers/sessionTranscript.ts";
import { makeSandbox, padding } from "../helpers/transcript.ts";

const dir = makeSandbox("grove-tail-");
let n = 0;
function tail(lines: Array<object | string>) {
  const file = path.join(dir, `${++n}.jsonl`);
  writeFileSync(
    file,
    `${lines.map((l) => (typeof l === "string" ? l : jsonl([l]).trim())).join("\n")}\n`,
  );
  return sessionTail(file);
}

describe("the end of a transcript", () => {
  it("is the newest prompt and the agent's last words after it, not the ones before", () => {
    expect(
      tail([
        prompt("first thing", 0),
        says("m1", text("an older answer"), 1),
        prompt("wire the callback route", 2),
        says("m2", text("Reading the router."), 3),
        says("m2", call("t1", "Read", { file_path: "/work/api/router.ts" }), 4),
        result("t1", "export const router = 1", 5, { told: { file: "router.ts" } }),
        says("m3", text("Done. Want me to open the PR?"), 6),
        hookNoise(7),
        title("callback route"),
      ]),
    ).toEqual({ prompt: "wire the callback route", text: "Done. Want me to open the PR?" });
  });

  it("has no words while the agent has only called tools since the prompt", () => {
    expect(
      tail([
        prompt("first thing", 0),
        says("m1", text("an older answer"), 1),
        prompt("now the tests", 2),
        says("m2", call("t1", "Bash", { command: "pnpm test" }), 3),
      ]),
    ).toEqual({ prompt: "now the tests" });
  });

  it("takes what was typed mid-turn, and a slash command only with its arguments", () => {
    expect(
      tail([prompt("start", 0), says("m1", text("on it"), 1), queued("and the docs too", 2)]),
    ).toEqual({ prompt: "and the docs too" });
    expect(tail([prompt("start", 0), command("loop", "watch the rollout", 1)]).prompt).toBe(
      "/loop watch the rollout",
    );
    expect(tail([prompt("start", 0), command("model", "", 1)]).prompt).toBe("start");
  });

  it("skips what nobody typed or said: a subagent's lines, a task notification, a tool result", () => {
    expect(
      tail([
        prompt("review the diff", 0),
        says("m1", text("Looks right to me."), 1),
        says("m9", text("a subagent's words"), 2, { isSidechain: true }),
        taskNotification("the build finished", 3),
        result("t1", "ok", 4, { told: { stdout: "ok" } }),
      ]),
    ).toEqual({ prompt: "review the diff", text: "Looks right to me." });
  });

  it("an api error is what it last said", () => {
    expect(tail([prompt("go", 0), apiErrorMessage(1)]).text).toBe("API Error: 529 Overloaded");
  });

  it("finds a prompt more than a chunk back, and cuts what it sends", () => {
    const long = "x".repeat(TAIL_PROMPT_MAX + 50);
    const answer = `${"y".repeat(TAIL_TEXT_MAX)} the end?`;
    const got = tail([
      prompt("too old to matter", 0),
      prompt(long, 1),
      // three tool results of 600KB each: the prompt is in the second chunk from the end
      padding(600_000),
      padding(600_000),
      padding(600_000),
      says("m1", text(answer), 2),
    ]);
    expect(got.prompt).toBe(`${"x".repeat(TAIL_PROMPT_MAX - 1)}…`);
    expect(got.text).toHaveLength(TAIL_TEXT_MAX);
    expect(got.text?.startsWith("…y")).toBe(true);
    expect(got.text?.endsWith(" the end?")).toBe(true);
  });

  it("a file that is not there, or holds no line it knows, gives nothing", () => {
    expect(sessionTail(path.join(dir, "missing.jsonl"))).toEqual({});
    expect(tail(["not json", '{"type":"user"', title("only a title")])).toEqual({});
  });
});
