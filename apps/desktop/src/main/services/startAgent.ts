// what an agent started from grove is told, or why it is not started. pure: the startAgent handler
// resolves the project and its root, then runs the editor or the background path.
import { isObject } from "@grove/core";
import type { StartAgentRequest } from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";

/** the request as the page sent it */
export function parseStartAgent(raw: unknown): StartAgentRequest {
  if (!isObject(raw) || typeof raw.project !== "string" || !raw.project) {
    throw new AppError("invalid", "Nothing to start.");
  }
  if (raw.where !== "editor" && raw.where !== "background") {
    throw new AppError("invalid", "Start it in the editor or in the background.");
  }
  const req: StartAgentRequest = { project: raw.project, where: raw.where };
  if (raw.where === "background" && raw.throughTerminal === true) req.throughTerminal = true;
  return req;
}

export interface StartFacts {
  root: string;
  /** checked at call time */
  rootExists: boolean;
  goal?: string;
}

/** the agent's first message */
export function startPrompt(f: StartFacts): string {
  if (!f.rootExists) throw new AppError("cwd-missing", `${f.root} does not exist.`);
  const goal = f.goal?.trim();
  if (!goal) {
    throw new AppError("no-goal", "Write the project's goal first. Agents start from it.");
  }
  return `Work toward this project's goal: ${goal}

Read context/ first: it holds what other sessions here decided and learned. Write what you decide or learn there as you go.`;
}
