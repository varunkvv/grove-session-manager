// what Open in {editor} will do, known before it is pressed. pure: openSession decides the rest at
// call time, from the row as it is then.
import type { Runtime } from "@grove/core";
import type { OpenPlan, SessionRow } from "../../shared/ipc.ts";

// ponytail: re-exported until the swap moves them here and deletes sessionActions.ts
export { daemonHeld, heldWhere } from "./sessionActions.ts";

const STOP_CONFIRM = {
  title: "Stop it while it works?",
  body: "It is still working - stopping it interrupts the turn. The conversation is kept, and it opens where you left it.",
  label: "Stop and open",
};

/**
 * only a background agent needs anything before the click: a confirm when stopping it would cut a
 * turn short, or no button while Claude Code has not said which background session it is. every
 * other runtime opens, or says why it did not, after the click.
 */
export function openPlanOf(runtime: Runtime, row?: SessionRow): OpenPlan {
  if (runtime !== "background") return {};
  if (!row?.background?.id) return { disabled: "running in the background" };
  return row.background.state === "working" ? { confirm: STOP_CONFIRM } : {};
}
