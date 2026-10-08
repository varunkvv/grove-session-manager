// a session started from grove, as the page asked for it. pure: the startAgent handler resolves
// the project and its root, then runs the editor or the background path.
import { isObject } from "@grove/core";
import type { StartAgentRequest } from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";

/** a prompt is typed text. past this it was pasted by mistake */
const PROMPT_MAX = 20_000;

/** the request as the page sent it */
export function parseStartAgent(raw: unknown): StartAgentRequest {
  if (!isObject(raw) || typeof raw.project !== "string" || !raw.project) {
    throw new AppError("invalid", "Nothing to start.");
  }
  if (raw.where !== "editor" && raw.where !== "background") {
    throw new AppError("invalid", "Start it in the editor or in the background.");
  }
  // the editor takes none: what a session there should do is typed there
  const prompt =
    raw.where === "background" && typeof raw.prompt === "string"
      ? raw.prompt.trim().slice(0, PROMPT_MAX)
      : "";
  // `claude --bg` has nothing to do without one
  if (raw.where === "background" && !prompt) {
    throw new AppError(
      "no-prompt",
      "Say what it should do. A background session starts from that.",
    );
  }
  const req: StartAgentRequest = { project: raw.project, where: raw.where, prompt };
  if (raw.where === "background" && raw.throughTerminal === true) req.throughTerminal = true;
  return req;
}
