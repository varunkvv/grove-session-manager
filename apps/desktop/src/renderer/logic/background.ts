import { formatRelativeTime } from "@grove/core/pure";
import type { BackgroundView, SessionRow } from "../../shared/ipc.ts";

/**
 * the row only says "Background". this is the rest: the id `claude attach` takes, the state in
 * Claude Code's own words (agent view uses the same ones), and what a blocked one waits on.
 */
export function backgroundTooltip(bg: BackgroundView): string {
  const parts = [bg.id ? `Background session ${bg.id}` : "Background session"];
  parts.push(bg.state ?? "state unknown");
  if (bg.waitingFor) parts.push(bg.waitingFor);
  // done or blocked for a while: the supervisor let the process go, and brings it back on attach
  if (!bg.held && (bg.state === "done" || bg.state === "blocked")) parts.push("not running now");
  return parts.join(" · ");
}

/** what continuing asks for. an interrupted one is told so: it may have been mid-tool. */
export function continuePrompt(row: Pick<SessionRow, "interrupted"> | undefined): string {
  return row?.interrupted
    ? "continue where you left off - you were interrupted"
    : "continue where you left off";
}

/** the "Interrupted" marker says no more than that. this says how grove knows. */
export function interruptedTooltip(
  cut: NonNullable<SessionRow["interrupted"]>,
  now: number,
): string {
  const when = cut.at !== undefined ? `, ${formatRelativeTime(cut.at, now)}` : "";
  return cut.why === "failed"
    ? `Its background run failed${when}. Continue in background picks it up where it stopped.`
    : `Its process went away mid-turn${when}: a closed window, a crash or a restart. Continue in background picks it up where it stopped.`;
}
