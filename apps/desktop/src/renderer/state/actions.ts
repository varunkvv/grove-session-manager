import type { SessionActionId, SessionKey } from "../../shared/ipc.ts";
import { useStore } from "./store.ts";

const api = () => window.grove;
const state = () => useStore.getState();

export function focusSearch(select = true): void {
  const el = document.getElementById("search") as HTMLInputElement | null;
  el?.focus();
  if (select) el?.select();
}

function report(
  title: string,
  outcome: { ok: true } | { ok: false; error: { message: string; detail?: string } },
): boolean {
  if (outcome.ok) return true;
  state().toast({
    level: "error",
    title,
    body: outcome.error.message,
    detail: outcome.error.detail,
  });
  return false;
}

export async function openCombo(name: string, sessionKey?: SessionKey): Promise<void> {
  const label = state().editor?.label ?? "the editor";
  state().toast({ level: "info", title: `Opening ${name} in ${label}` });
  const res = await api().openCombo(name, sessionKey);
  if (!report(`Could not open ${name}`, res)) return;
  if (sessionKey && res.ok && !res.value.landing) {
    state().toast({
      level: "info",
      title: "Opened without landing on the session",
      body: `The companion extension is not installed in ${label}.`,
    });
  }
}

/** the inspector on this session, or on the active row. it follows the selection from then on. */
export function openInspector(key?: SessionKey): void {
  const s = state();
  s.set({
    ...(key ? { activeKey: key } : {}),
    inspector: s.inspector ?? { agent: null },
  });
}

/** into the inspector's list, when it has one. false when there is nothing there to move through. */
export function focusInspector(): boolean {
  const list = document.querySelector<HTMLElement>("[data-inspector-list]");
  list?.focus();
  return !!list;
}

export function closeInspector(): void {
  state().set({ inspector: null });
  focusSearch(false);
}

export async function runAction(key: SessionKey, action: SessionActionId): Promise<void> {
  state().set({ menu: null });
  if (action === "inspect") {
    openInspector(key);
    focusSearch(false);
    return;
  }
  const res = await api().runSessionAction(key, action);
  if (report("That did not work", res) && res.ok && res.value.message) {
    state().toast({ level: "info", title: res.value.message });
  }
  focusSearch(false);
}

/** the decision goes to ~/claude-ws/archived.json, which can refuse - so this reports. */
export async function archiveSessions(keys: SessionKey[], archived: boolean): Promise<void> {
  if (keys.length === 0) return;
  report(
    archived ? "Could not archive" : "Could not unarchive",
    await api().archiveSessions(keys, archived),
  );
}

export async function openMenu(key: SessionKey): Promise<void> {
  const actions = await api().sessionActions(key);
  const first = Math.max(
    0,
    actions.findIndex((a) => a.enabled),
  );
  state().set({ activeKey: key, menu: { key, actions, index: first } });
}

/**
 * Enter and click do the same thing. a session that lives at a combo's root opens that combo and
 * lands on it. anything else gets the offer list, because there is more than one sensible way in.
 */
export async function activate(key: SessionKey): Promise<void> {
  const row = state().sessions.find((r) => r.key === key);
  if (!row) return;
  state().set({ activeKey: key });
  if (row.comboName && row.comboRelation === "root") return openCombo(row.comboName, key);
  return openMenu(key);
}

/** Cmd+Enter: the first enabled offer, without showing the list */
export async function activateDefault(key: SessionKey): Promise<void> {
  const row = state().sessions.find((r) => r.key === key);
  if (!row) return;
  if (row.comboName && row.comboRelation === "root") return openCombo(row.comboName, key);
  const first = (await api().sessionActions(key)).find((a) => a.enabled);
  if (first) await runAction(key, first.id);
}

export async function refresh(): Promise<void> {
  await Promise.all([api().reconcile(undefined, false), api().rescan()]);
}

export async function repairSelected(): Promise<void> {
  const name = state().selectedCombo;
  if (!name) return;
  report(`Could not repair ${name}`, await api().repairCombo(name));
}

export async function installCompanion(): Promise<void> {
  const res = await api().installCompanion();
  if (report("Could not install the extension", res)) {
    state().toast({
      level: "info",
      title: "Extension installed",
      body: "Reload open editor windows to activate it.",
    });
  }
}
