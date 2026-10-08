import type { Landing } from "../../shared/ipc.ts";
import { go, switchProject } from "./actions.ts";
import { useStore } from "./store.ts";

/**
 * a notification click or a tray row, in the page: that session's row in the list main named, with
 * its panel open. looking is not dismissing: nothing is marked.
 */
export function applyLanding(landing: Landing): void {
  const s = useStore.getState();
  const t = landing.target;
  s.set({ dialog: null });
  // the project went while the click was on its way: the inbox still lists what needs him
  if (t.view === "sessions" && s.projects.some((p) => p.id === t.project)) switchProject(t.project);
  else go("inbox");
  // that row is the keyboard's, and shows it. the list closes the panel again if the row has left
  if (t.session) {
    const now = useStore.getState();
    now.set({ peek: t.session, active: { ...now.active, [now.section]: t.session }, keys: true });
  }
}

export async function takeLanding(): Promise<void> {
  const landing = await window.grove.takeLanding().catch(() => null);
  if (landing) applyLanding(landing);
}
