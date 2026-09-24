import type { BackgroundView } from "../../shared/ipc.ts";

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
