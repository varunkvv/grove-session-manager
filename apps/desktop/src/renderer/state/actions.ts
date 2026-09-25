import type { SessionActionId, SessionKey } from "../../shared/ipc.ts";
import { continuePrompt } from "../logic/background.ts";
import { agentIdOf, sessionKeyOf, splitQuery } from "../logic/rows.ts";
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

/**
 * the pane on what this session's agents did, or the active row's. it follows the selection from
 * then on.
 */
export function openInspector(key?: SessionKey): void {
  const s = state();
  s.set({
    ...(key ? { activeKey: key } : {}),
    inspector: { agent: null, detail: null, ...s.inspector, view: "agents" },
  });
}

/**
 * the pane on this session's own conversation: what a click on a row does. `find` is a search
 * that led here, and the conversation opens at the turn that matched it.
 */
export function openConversation(key: SessionKey, opts: { find?: string } = {}): void {
  const s = state();
  s.set({
    activeKey: key,
    inspector: {
      view: "conversation",
      agent: s.inspector?.agent ?? null,
      detail: null,
      ...(opts.find ? { find: opts.find } : {}),
    },
  });
}

/** into the inspector's list, when it has one. false when there is nothing there to move through. */
export function focusInspector(): boolean {
  const list = document.querySelector<HTMLElement>("[data-inspector-list]");
  list?.focus();
  return !!list;
}

/**
 * a view that replaces another inside the pane takes the keyboard on its first render, when the
 * one it replaced had it. set just before the swap, read once by whatever mounts next.
 */
export const paneFocus: { pending: boolean } = { pending: false };

const focusInPane = () =>
  !!document.activeElement?.closest?.('[data-testid="inspector"]') &&
  document.activeElement !== document.body;

/**
 * one agent's detail in place of the list. `step` brings that step into view. the keyboard goes
 * with it when it was in the pane already, or when asked to.
 */
export function openAgent(
  key: SessionKey,
  id: string,
  opts: { step?: number; focus?: boolean; find?: string } = {},
): void {
  const s = state();
  const step = opts.step;
  const find = opts.find;
  const showing = s.inspector?.detail?.key === key && s.inspector.detail.id === id;
  paneFocus.pending = opts.focus || focusInPane();
  // already on screen, nothing mounts to take the keyboard
  if (showing && opts.focus) focusInspector();
  s.set({
    inspector: {
      view: "agents",
      agent: id,
      detail: { key, id },
      ...(step !== undefined ? { step } : {}),
      ...(find ? { find } : {}),
    },
  });
}

/**
 * the agent a search found this session through, when the query on screen is the one it answered.
 * the inspector opens on that agent, at the step that matched.
 */
export function agentHit(key: SessionKey): { agent: string; find: string } | null {
  const s = state();
  const text = splitQuery(s.query).text;
  const hit = s.deep && s.deep.query === text ? s.deep.hits.get(key) : undefined;
  return hit?.agent ? { agent: hit.agent, find: text } : null;
}

/** back from an agent to the list, with the row it came from still the one the keyboard is on */
export function closeAgent(): void {
  const s = state();
  const detail = s.inspector?.detail;
  if (!detail) return;
  paneFocus.pending = focusInPane();
  s.set({ inspector: { view: "agents", agent: detail.id, detail: null } });
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
  // nothing is sent before the person has seen the prompt and pressed the button
  if (action === "continue-bg") {
    const row = state().sessions.find((r) => r.key === key);
    state().set({
      dialog: {
        kind: "background",
        target: { kind: "continue", key },
        prompt: continuePrompt(row),
      },
    });
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

/** the actions of the row's session. an agent's row offers its session's. */
export async function openMenu(key: SessionKey): Promise<void> {
  const session = sessionKeyOf(key);
  const actions = await api().sessionActions(session);
  const first = Math.max(
    0,
    actions.findIndex((a) => a.enabled),
  );
  state().set({ activeKey: key, menu: { key: session, actions, index: first } });
}

/**
 * Enter and a double-click do the same thing (a click reads the session in the pane). a session
 * that lives at a combo's root opens that combo and lands on it. anything else gets the offer
 * list, because there is more than one sensible way in.
 */
export async function activate(key: SessionKey): Promise<void> {
  // an agent's row opens that agent, keyboard and all
  const agent = agentIdOf(key);
  if (agent) {
    state().set({ activeKey: key });
    openAgent(sessionKeyOf(key), agent, { focus: true });
    return;
  }
  const row = state().sessions.find((r) => r.key === key);
  if (!row) return;
  state().set({ activeKey: key });
  // held by Claude Code's supervisor, the editor would be refused. cut off mid-turn, picking it
  // up in the background is likelier than opening it. either way the offers decide.
  if (row.comboName && row.comboRelation === "root" && !row.background?.held && !row.interrupted) {
    return openCombo(row.comboName, key);
  }
  return openMenu(key);
}

/** Cmd+Enter, and the pane's open button: the first enabled offer, without showing the list */
export async function activateDefault(key: SessionKey): Promise<void> {
  const row = state().sessions.find((r) => r.key === key);
  if (!row) return;
  if (row.comboName && row.comboRelation === "root" && !row.background?.held && !row.interrupted) {
    return openCombo(row.comboName, key);
  }
  const first = (await api().sessionActions(key)).find((a) => a.enabled);
  // an offer that interrupts something is never run without asking. one that asks for a prompt
  // opens its dialog: runAction does that.
  if (first?.confirm) return state().set({ dialog: { kind: "confirm", key, action: first } });
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
