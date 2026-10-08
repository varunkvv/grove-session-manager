import { describe, expect, it } from "vitest";
import { AppError } from "../../src/main/errors.ts";
import {
  parseStartAgent,
  type StartFacts,
  startPrompt,
} from "../../src/main/services/startAgent.ts";

const BASE: StartFacts = {
  root: "/ws/chat",
  rootExists: true,
  goal: "Ship the leave planner to the pilot team",
};

function refusal(f: StartFacts): { code: string; message: string } {
  try {
    startPrompt(f);
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return { code: (e as AppError).code, message: (e as AppError).message };
  }
  throw new Error("started");
}

describe("the prompt an agent started from grove gets", () => {
  it("works the goal", () => {
    expect(startPrompt(BASE)).toBe(
      "Call record_state first, then work toward this project's goal: Ship the leave planner to the pilot team\n\nClaim a card nobody holds with card_claim, or create one with card_create for work that has no card yet. Record what you decide or find with conclusion_record as you go.",
    );
  });
});

describe("what it refuses", () => {
  it("a root that is gone, before anything else", () => {
    expect(refusal({ ...BASE, rootExists: false, goal: "" })).toEqual({
      code: "cwd-missing",
      message: "/ws/chat does not exist.",
    });
  });

  it("no goal", () => {
    const noGoal = {
      code: "no-goal",
      message: "Write the project's goal first. Agents start from it.",
    };
    expect(refusal({ root: "/ws/chat", rootExists: true })).toEqual(noGoal);
    expect(refusal({ ...BASE, goal: "  \n " })).toEqual(noGoal);
  });
});

describe("the request as the page sent it", () => {
  it("keeps what it knows", () => {
    expect(parseStartAgent({ project: "chat", where: "editor", cardId: "chat-4" })).toEqual({
      project: "chat",
      where: "editor",
    });
    expect(
      parseStartAgent({ project: "chat", where: "background", throughTerminal: true }),
    ).toEqual({ project: "chat", where: "background", throughTerminal: true });
    // the editor path has no terminal
    expect(parseStartAgent({ project: "chat", where: "editor", throughTerminal: true })).toEqual({
      project: "chat",
      where: "editor",
    });
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
