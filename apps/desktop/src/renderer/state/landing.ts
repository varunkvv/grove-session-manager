import type { Landing } from "../../shared/ipc.ts";
import { go, openCard, openConclusion, switchProject } from "./actions.ts";
import { useStore } from "./store.ts";

/**
 * a notification click or a tray row, in the page: the card, with the screen main named behind it
 * so Back goes there, or that row of the inbox, or that conclusion. looking is not reviewing:
 * nothing is marked.
 */
export function applyLanding(landing: Landing): void {
  const s = useStore.getState();
  const t = landing.target;
  s.set({ overlay: null, dialog: null });
  // the project went while the click was on its way: the inbox of the one on screen
  if (t.project && !s.projects.some((p) => p.id === t.project)) {
    go("inbox");
    return;
  }
  if (t.project && t.project !== s.project) switchProject(t.project);
  if (t.view === "card") {
    go(t.back);
    openCard(t.cardId);
  } else if (t.view === "conclusions") {
    go("conclusions");
    if (t.conclusionId) openConclusion(t.conclusionId);
  } else {
    go("inbox");
    // that row is the keyboard's, and shows it: its buttons are what the click was about
    if (t.rowId) {
      s.set({ active: { ...useStore.getState().active, inbox: t.rowId }, keys: true });
    }
  }
}

export async function takeLanding(): Promise<void> {
  const landing = await window.grove.takeLanding().catch(() => null);
  if (landing) applyLanding(landing);
}
