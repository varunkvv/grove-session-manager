import { describe, expect, it } from "vitest";
import { AppError } from "../../src/main/errors.ts";
import {
  parseStartAgent,
  type StartCard,
  type StartFacts,
  startPrompt,
} from "../../src/main/services/startAgent.ts";

const BASE: StartFacts = {
  root: "/ws/chat",
  rootExists: true,
  goal: "Ship the leave planner to the pilot team",
};
const CARD: StartCard = { id: "CHAT-4", title: "Fix the accrual rounding", status: "todo" };

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
  it("no card: works the goal", () => {
    expect(startPrompt(BASE)).toBe(
      "Call record_state first, then work toward this project's goal: Ship the leave planner to the pilot team\n\nClaim a card nobody holds with card_claim, or create one with card_create for work that has no card yet. Record what you decide or find with conclusion_record as you go.",
    );
  });

  it("a card nobody holds: claims it", () => {
    expect(startPrompt({ ...BASE, cardId: "CHAT-4", card: CARD })).toBe(
      "Call record_state first, then claim CHAT-4 with card_claim and work on it: Fix the accrual rounding\n\nRead it with card_show before you start.",
    );
  });

  it("a card whose holder is closed or stopped: takes it over", () => {
    const takeover =
      "Call record_state first. I want you to take over CHAT-4 from rounding fix, whose session is no longer running: Fix the accrual rounding\n\nTake it with card_takeover, then read it with card_show and carry on from where it stopped.";
    const held = (runtime: "closed" | "vscode", interrupted: boolean): StartFacts => ({
      ...BASE,
      cardId: "CHAT-4",
      card: {
        ...CARD,
        status: "in_progress",
        holder: { name: "rounding fix", runtime, interrupted },
      },
    });
    expect(startPrompt(held("closed", false))).toBe(takeover);
    // stopped mid-turn: the registry can still name it for a moment
    expect(startPrompt(held("vscode", true))).toBe(takeover);
  });
});

describe("what it refuses", () => {
  it("a root that is gone, before anything else", () => {
    expect(refusal({ ...BASE, rootExists: false, cardId: "CHAT-9" })).toEqual({
      code: "cwd-missing",
      message: "/ws/chat does not exist.",
    });
  });

  it("no goal, when no card is named", () => {
    const noGoal = {
      code: "no-goal",
      message: "Write the project's goal first. Agents start from it.",
    };
    expect(refusal({ root: "/ws/chat", rootExists: true })).toEqual(noGoal);
    expect(refusal({ ...BASE, goal: "  \n " })).toEqual(noGoal);
    // a card needs no goal
    expect(startPrompt({ ...BASE, goal: "", cardId: "CHAT-4", card: CARD })).toContain("CHAT-4");
  });

  it("a card that is not in the project", () => {
    expect(refusal({ ...BASE, cardId: "CHAT-9" })).toEqual({
      code: "no-card",
      message: "CHAT-9 is not in this project.",
    });
  });

  it("a done or canceled card", () => {
    expect(refusal({ ...BASE, cardId: "CHAT-4", card: { ...CARD, status: "done" } })).toEqual({
      code: "card-closed",
      message: "CHAT-4 is done. Start an agent on a card that is still open.",
    });
    expect(refusal({ ...BASE, cardId: "CHAT-4", card: { ...CARD, status: "canceled" } })).toEqual({
      code: "card-closed",
      message: "CHAT-4 is canceled. Start an agent on a card that is still open.",
    });
  });

  it("a card whose holder is still running, wherever it runs", () => {
    for (const runtime of ["vscode", "terminal", "background", "elsewhere"] as const) {
      const card: StartCard = {
        ...CARD,
        status: "in_progress",
        holder: { name: "rounding fix", runtime, interrupted: false },
      };
      expect(refusal({ ...BASE, cardId: "CHAT-4", card }), runtime).toEqual({
        code: "held",
        message: "CHAT-4 is held by rounding fix, which is still running.",
      });
    }
  });
});

describe("the request as the page sent it", () => {
  it("keeps what it knows and upper-cases the card", () => {
    expect(parseStartAgent({ project: "chat", where: "editor", cardId: "chat-4" })).toEqual({
      project: "chat",
      where: "editor",
      cardId: "CHAT-4",
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
      { project: "chat", where: "editor", cardId: "D-1" },
      { project: "chat", where: "editor", cardId: "../../etc" },
      { project: "chat", where: "editor", cardId: 4 },
    ]) {
      expect(() => parseStartAgent(raw), JSON.stringify(raw)).toThrow(AppError);
    }
  });
});
