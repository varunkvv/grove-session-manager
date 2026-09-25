// what a new session in a combo is started with. pure: the caller runs it.
import {
  isObject,
  type LongWorkMode,
  longWorkPromptLine,
  longWorkSessionPolicy,
} from "@grove/core";
import {
  EFFORTS,
  MODELS,
  type NewSessionRequest,
  PERMISSION_MODES,
} from "../../shared/newSession.ts";
import { AppError } from "../errors.ts";

/** the longest prompt grove hands over. anything longer belongs in a plan file. */
export const PROMPT_MAX = 20_000;
export const NAME_MAX = 100;

/** the first companion that can start a conversation rather than only land on one */
export const NEW_CONVERSATION_COMPANION = "0.3.0";

type CliSettings = Pick<NewSessionRequest, "model" | "mode" | "effort" | "longWork" | "name">;

/**
 * the flags a CLI session starts with. fixed-list values go as their own argument, the only free
 * text (a name) as `--name=<name>` in one, so it can never read as a flag. the long-work override
 * is our own text, one argument too.
 */
export function cliFlags(s: CliSettings): string[] {
  return [
    ...(s.model ? ["--model", s.model] : []),
    ...(s.mode ? ["--permission-mode", s.mode] : []),
    ...(s.effort ? ["--effort", s.effort] : []),
    ...(s.longWork ? [`--append-system-prompt=${longWorkSessionPolicy(s.longWork)}`] : []),
    ...(s.name ? [`--name=${s.name}`] : []),
  ];
}

/**
 * an interactive claude in Terminal. a prompt after `--` is its first message, sent as typed, and
 * never a flag however it starts. no prompt: nothing after the flags.
 */
export function terminalArgs(s: CliSettings, prompt: string): string[] {
  return [...cliFlags(s), ...(prompt ? ["--", prompt] : [])];
}

/** `claude --bg`: a background session has nothing to do without a prompt, so there always is one */
export function backgroundArgs(s: CliSettings, prompt: string): string[] {
  return ["--bg", ...cliFlags(s), "--", prompt];
}

/**
 * what goes in the Claude panel's input box. the panel takes nothing but a prompt, so an override
 * of where long work goes is its first line, where the person sees it before sending.
 */
export function editorPrompt(prompt: string, longWork?: LongWorkMode): string {
  if (!longWork) return prompt;
  const line = longWorkPromptLine(longWork);
  return prompt ? `${line}\n\n${prompt}` : line;
}

function oneOf<T extends string>(
  list: ReadonlyArray<{ value: T }>,
  raw: unknown,
  what: string,
): T | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const hit = list.find((o) => o.value === raw);
  if (!hit) throw new AppError("invalid", `${String(raw).slice(0, 40)} is not a ${what}.`);
  return hit.value;
}

/**
 * the request as the page sent it, held to the lists. anything off a list is refused rather than
 * dropped: a session that quietly started without the setting someone picked is worse than none.
 */
export function parseNewSession(raw: unknown): NewSessionRequest {
  if (!isObject(raw) || typeof raw.combo !== "string") {
    throw new AppError("invalid", "Nothing to start.");
  }
  const where = raw.where;
  if (where !== "editor" && where !== "terminal" && where !== "background") {
    throw new AppError("invalid", "Start it in the editor, in Terminal or in the background.");
  }
  // the editor's box keeps what was typed. a CLI prompt is trimmed like every other hand-over.
  const typed = typeof raw.prompt === "string" ? raw.prompt : "";
  const prompt = where === "editor" ? typed.replace(/\s+$/, "") : typed.trim();
  if (where === "background" && !prompt) {
    throw new AppError("empty-prompt", "Say what it should do first.");
  }
  if (prompt.length > PROMPT_MAX) {
    throw new AppError("long-prompt", "That prompt is too long. Put it in a plan file.");
  }
  const longWork =
    raw.longWork === "background" || raw.longWork === "foreground" ? raw.longWork : undefined;
  if (raw.longWork !== undefined && !longWork) {
    throw new AppError("invalid", "Long work is either background or foreground.");
  }
  const req: NewSessionRequest = {
    combo: raw.combo,
    where,
    prompt,
    ...(longWork ? { longWork } : {}),
  };
  // the Claude panel picks its own model and mode: nothing of the CLI's reaches the editor
  if (where === "editor") return req;

  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
  if (name.length > NAME_MAX) throw new AppError("long-name", "That name is too long.");
  const model = oneOf(MODELS, raw.model, "model");
  const mode = oneOf(PERMISSION_MODES, raw.mode, "permission mode");
  const effort = oneOf(EFFORTS, raw.effort, "effort level");
  return {
    ...req,
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(effort ? { effort } : {}),
    ...(name ? { name } : {}),
    ...(where === "background" && raw.throughTerminal === true ? { throughTerminal: true } : {}),
  };
}
