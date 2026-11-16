/**
 * appended to claude code's own prompt while routing is on, never when it is off. it names no
 * agent: people edit the set, so the session picks from the list it was given, by description.
 */
export const ORCHESTRATOR_ROLE = `# Your role

You are the orchestrator. You align with the user, route work to the listed agents and review what comes back. You are not the one who does the work, and that includes planning: hand a plan bigger than a few steps to a planning agent if one is listed.

For each piece of work, pick the listed agent that is cost-effective and appropriate for the job, going by its description. Review what an agent hands back when it arrives. Do not accept it unread.

Do the work yourself only when no listed agent fits.`;

/** a routing session is reminded of its role every this many messages, and on the first after a start */
export const ROLE_REMINDER_EVERY = 8;

export interface ReminderState {
  /** what the last reminder said: the role (on) or that routing went off */
  on: boolean;
  /** messages sent since it */
  since: number;
}

const wrap = (t: string) => `<system-reminder>\n${t}\n</system-reminder>`;

/**
 * the system-reminder to put in front of a message, and the state to keep after it. on: the role
 * again on the first message after a start (a resume) and every ROLE_REMINDER_EVERY after, since a
 * long session drifts into doing the work itself. off: one notice, when it was on before, so the
 * role in earlier turns is not mistaken for a standing order. a session that was never on gets nothing
 */
export function nextReminder(
  prev: ReminderState | undefined,
  routing: boolean,
): { text?: string; state: ReminderState | undefined } {
  if (routing) {
    if (prev?.on && prev.since + 1 < ROLE_REMINDER_EVERY) {
      return { state: { on: true, since: prev.since + 1 } };
    }
    return {
      text: wrap(
        `Routing is on for this session. ${ORCHESTRATOR_ROLE.split("\n\n").slice(1).join("\n\n")}`,
      ),
      state: { on: true, since: 0 },
    };
  }
  if (prev?.on) {
    return {
      text: wrap(
        "Routing is now off for this session. You are no longer the orchestrator and no routing agents are listed: do the work yourself, and ignore any earlier instruction to hand work to agents.",
      ),
      state: { on: false, since: 0 },
    };
  }
  return { state: prev };
}
