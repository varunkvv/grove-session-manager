// what a new session in a combo is started with. pure: the caller runs it.
import type { NewSessionRequest } from "../../shared/newSession.ts";

/** the first companion that can start a conversation rather than only land on one */
export const NEW_CONVERSATION_COMPANION = "0.3.0";

type CliSettings = Pick<NewSessionRequest, "model" | "mode" | "effort" | "name">;

/**
 * the flags a CLI session starts with. fixed-list values go as their own argument, the only free
 * text (a name) as `--name=<name>` in one, so it can never read as a flag.
 */
export function cliFlags(s: CliSettings): string[] {
  return [
    ...(s.model ? ["--model", s.model] : []),
    ...(s.mode ? ["--permission-mode", s.mode] : []),
    ...(s.effort ? ["--effort", s.effort] : []),
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
