// what an agent started from grove is told, or why it is not started. pure: the startAgent handler
// resolves the project, its root and the card, then runs the editor or the background path.
import { isObject, type Runtime } from "@grove/core";
import { CARD_ID } from "@grove/record";
import type { CardStatus } from "@grove/record/types";
import type { StartAgentRequest } from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";

/** the request as the page sent it. the card id is upper-cased and held to the record's grammar */
export function parseStartAgent(raw: unknown): StartAgentRequest {
  if (!isObject(raw) || typeof raw.project !== "string" || !raw.project) {
    throw new AppError("invalid", "Nothing to start.");
  }
  if (raw.where !== "editor" && raw.where !== "background") {
    throw new AppError("invalid", "Start it in the editor or in the background.");
  }
  const req: StartAgentRequest = { project: raw.project, where: raw.where };
  if (raw.cardId !== undefined) {
    const id = typeof raw.cardId === "string" ? raw.cardId.toUpperCase() : "";
    if (!CARD_ID.test(id)) {
      throw new AppError("invalid", `${String(raw.cardId).slice(0, 40)} is not a card id.`);
    }
    req.cardId = id;
  }
  if (raw.where === "background" && raw.throughTerminal === true) req.throughTerminal = true;
  return req;
}

/** the card asked for, as the project's record has it, its holder joined with where it runs */
export interface StartCard {
  id: string;
  title: string;
  status: CardStatus;
  holder?: { name: string; runtime: Runtime; interrupted: boolean };
}

export interface StartFacts {
  root: string;
  /** checked at call time */
  rootExists: boolean;
  goal?: string;
  /** as asked, upper-cased */
  cardId?: string;
  /** absent when the card is not in the project */
  card?: StartCard;
}

/**
 * the agent's first message. a card whose holder is closed or stopped is taken over: the person
 * asking is the say-so decision 8 needs, and only an agent can take a card over. a running holder
 * is never handed over from here.
 */
export function startPrompt(f: StartFacts): string {
  if (!f.rootExists) throw new AppError("cwd-missing", `${f.root} does not exist.`);
  if (f.cardId === undefined) {
    const goal = f.goal?.trim();
    if (!goal) {
      throw new AppError("no-goal", "Write the project's goal first. Agents start from it.");
    }
    return `Call record_state first, then work toward this project's goal: ${goal}

Claim a card nobody holds with card_claim, or create one with card_create for work that has no card yet. Record what you decide or find with conclusion_record as you go.`;
  }
  const c = f.card;
  if (!c) throw new AppError("no-card", `${f.cardId} is not in this project.`);
  if (c.status === "done" || c.status === "canceled") {
    throw new AppError(
      "card-closed",
      `${c.id} is ${c.status}. Start an agent on a card that is still open.`,
    );
  }
  const h = c.holder;
  if (!h) {
    return `Call record_state first, then claim ${c.id} with card_claim and work on it: ${c.title}

Read it with card_show before you start.`;
  }
  if (h.runtime !== "closed" && !h.interrupted) {
    throw new AppError("held", `${c.id} is held by ${h.name}, which is still running.`);
  }
  return `Call record_state first. I want you to take over ${c.id} from ${h.name}, whose session is no longer running: ${c.title}

Take it with card_takeover, then read it with card_show and carry on from where it stopped.`;
}
