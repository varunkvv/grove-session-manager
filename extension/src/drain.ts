import { claimIntent, listIntents, matchIntent, sweepIntents } from "@grove/core";
import type { Deps } from "./deps.ts";
import { type ResumeResult, resumeSession, startConversation } from "./resume.ts";

export type DrainTrigger = "activation" | "watch" | "focus";

let draining = false;

/**
 * pick up what the app left for this window: a session to resume, or a new conversation.
 *
 * activation alone is not enough: `code <workspace>` on a workspace that is already open only
 * focuses it, and this extension activated long ago. so the pending dir is also watched, and
 * checked again on focus. those two only take exact matches, otherwise a window on a parent
 * folder would steal an intent meant for a child.
 */
export async function drainIntents(
  deps: Deps,
  trigger: DrainTrigger,
): Promise<ResumeResult | null> {
  if (draining) return null;
  draining = true;
  try {
    const ws = deps.workspace();
    if (!ws.root) return null;
    const workspace = { root: ws.root, workspaceFile: ws.workspaceFile };

    let pick = (await listIntents(deps.appRoot)).find(
      (i) => matchIntent(i.intent, workspace) === "exact",
    );
    if (!pick && trigger === "activation") {
      // give a window that matches exactly the chance to claim it first
      await deps.delay(750);
      pick = (await listIntents(deps.appRoot)).find(
        (i) => matchIntent(i.intent, workspace) !== null,
      );
    }
    if (!pick) return null;

    const intent = await claimIntent(pick.file);
    if (!intent) return null;
    deps.log(
      `claimed intent for ${intent.kind === "new" ? "a new conversation" : intent.sessionId} (${trigger})`,
    );
    void sweepIntents(deps.appRoot);
    return intent.kind === "new"
      ? await startConversation(deps, intent.prompt)
      : await resumeSession(deps, intent.sessionId, intent.prompt);
  } catch (e) {
    deps.log(`drain failed: ${String(e)}`);
    return null;
  } finally {
    draining = false;
  }
}
