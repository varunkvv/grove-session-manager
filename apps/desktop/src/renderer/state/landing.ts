import type { Landing, SessionKey } from "../../shared/ipc.ts";
import { useStore } from "./store.ts";

/**
 * the row a landing chose. the list picks its first row when its scope or query changes, and a
 * landing changes both: this is the one row that choice must not replace. read once.
 */
export const landed: { key: SessionKey | null } = { key: null };

/**
 * a notification click, in the page: the inbox (or every session, when it stopped waiting) with the
 * query cleared, that session selected and the pane on its conversation at the end - or on the
 * agent that asked. looking is not answering: nothing is marked seen.
 */
export function applyLanding(landing: Landing): void {
  const s = useStore.getState();
  if (!s.sessions.some((r) => r.key === landing.key)) return;
  landed.key = landing.key;
  s.set({
    query: "",
    deep: null,
    menu: null,
    scope: landing.scope,
    activeKey: landing.key,
    inspector: landing.agentId
      ? {
          view: "agents",
          agent: landing.agentId,
          detail: { key: landing.key, id: landing.agentId },
        }
      : { view: "conversation", agent: null, detail: null, landAt: landing.at },
  });
}

export async function takeLanding(): Promise<void> {
  const landing = await window.grove.takeLanding().catch(() => null);
  if (landing) applyLanding(landing);
}
