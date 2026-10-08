import type { OpenPlan, ProjectId, SessionKey, StartAgentRequest } from "../../shared/ipc.ts";
import type { Intent } from "../logic/keyboard.ts";
import { sessionOrder } from "../logic/views.ts";
import { rememberProject, type Section, type State, useStore } from "./store.ts";

const api = () => window.grove;
const state = () => useStore.getState();
const editorLabel = () => state().editor?.label ?? "the editor";
const nameOf = (id: ProjectId) => state().projects.find((p) => p.id === id)?.name ?? id;

/** a refusal as an error toast. true when it went through */
export function report(
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

// ---------- navigation ----------

/** a list from the sidebar, the menu or the palette: nothing to go back to */
export function go(section: Section): void {
  state().set({ section, view: { name: section }, back: [], overlay: null, peek: null });
}

export function back(): void {
  const s = state();
  s.set({ view: s.back.at(-1) ?? { name: s.section }, back: s.back.slice(0, -1) });
}

/** a project's sessions */
export function switchProject(id: ProjectId): void {
  const s = state();
  s.set({
    project: id,
    section: "sessions",
    view: { name: "sessions" },
    back: [],
    overlay: null,
    peek: null,
    filter: "",
    active: { ...s.active, sessions: null },
    // another project's rows never show under this one's name
    sessions: s.sessions?.project === id ? s.sessions : null,
  });
  rememberProject(id);
}

let asked = 0;
/** the sessions of the project on screen, from main. an answer that came too late is dropped */
export async function loadSessions(): Promise<void> {
  const project = state().project;
  if (!project) return;
  const mine = ++asked;
  // main did not answer: what is on screen stays
  const hits = await api()
    .projectSessions(project)
    .catch(() => null);
  if (hits && mine === asked && state().project === project) {
    state().set({ sessions: { project, hits } });
  }
}

/** the menu's accelerator and the page's key can both ask: a second ask changes nothing */
export function newProject(): void {
  const s = state();
  if (s.view.name === "new-project") return;
  s.set({ back: [...s.back, s.view], view: { name: "new-project" }, overlay: null });
}

/** the project on screen. the inbox shows none, so there it does nothing */
export function editProject(): void {
  const s = state();
  if (s.view.name !== "sessions") return;
  s.set({ back: [...s.back, s.view], view: { name: "edit-project" }, overlay: null });
}

/** puts the keyboard back where the screen wants it. a form does it itself, with autoFocus */
export function focusScreen(): void {
  if (typeof document === "undefined") return;
  const { name } = state().view;
  if (name === "inbox" || name === "sessions") {
    // a list taller than the window would be scrolled to its own top edge, under the padding
    document.querySelector<HTMLElement>("[data-list]")?.focus({ preventScroll: true });
  }
}

/** the DOM id of a list row, for aria-activedescendant and for scrolling the keyboard's row into view */
export const optionId = (id: string): string => `row-${id}`;

// ---------- what a row does ----------

/** the one function every Open in {editor} control calls. one toast per open, after main answers */
export function openWith(
  key: SessionKey | undefined,
  plan: OpenPlan | undefined,
  label: string,
): void {
  if (!key) return;
  // a button never gets here: it is disabled. a key does, and has to be told why nothing opened
  if (plan?.disabled) {
    state().toast({ level: "error", title: `Could not open ${label}: ${plan.disabled}` });
    return;
  }
  const run = async () => {
    const res = await api().openSession(key);
    if (!res.ok) return void report(`Could not open ${label}`, res);
    state().toast({
      level: "info",
      title: res.value.message ?? `Opening ${label} in ${editorLabel()}`,
    });
  };
  // stopping a background agent that is working is asked first
  if (plan?.confirm) state().set({ dialog: { kind: "confirm", ...plan.confirm, run } });
  else void run();
}

/**
 * a click or Enter on a row: its session opens in the panel beside the list and is the keyboard's.
 * never a toggle, a double-click is two of these first. and never the editor: that is the
 * double-click
 */
export function openRow(screen: Section, id: string): void {
  const s = state();
  s.set({ peek: id, active: { ...s.active, [screen]: id } });
}

/** the same for every start button in the app */
export async function startAgent(req: StartAgentRequest): Promise<void> {
  const res = await api().startAgent(req);
  if (res.ok) {
    state().toast({ level: "info", title: res.value.message, body: res.value.body });
    return;
  }
  if (res.error.code === "not-trusted" && !req.throughTerminal) {
    state().set({
      dialog: {
        kind: "confirm",
        title: "Start it in Terminal?",
        body: `Claude Code has not been allowed to work in ${nameOf(req.project)} yet. Grove runs the same command in Terminal, where you answer its trust prompt once.`,
        label: "Start in Terminal",
        run: () => void startAgent({ ...req, throughTerminal: true }),
      },
    });
    return;
  }
  report("Could not start an agent", res);
}

/**
 * Dismiss. the rows these keys clear leave at once, and main's next inbox is the truth either way.
 * a refusal puts them back, unless main has spoken since. true when it went through
 */
export async function review(project: ProjectId, keys: string[]): Promise<boolean> {
  const before = state().inbox;
  const marked = new Set(keys);
  const optimistic = {
    rows: before.rows.filter(
      (r) => !(r.project === project && r.reviewKeys.every((k) => marked.has(k))),
    ),
  };
  state().set({ inbox: optimistic });
  const ok = report("Could not dismiss it", await api().review(project, keys, true));
  if (!ok && state().inbox === optimistic) state().set({ inbox: before });
  return ok;
}

export async function openProject(id: ProjectId): Promise<void> {
  const name = nameOf(id);
  state().toast({ level: "info", title: `Opening ${name} in ${editorLabel()}` });
  report(`Could not open ${name}`, await api().openProject(id));
}

export async function refresh(): Promise<void> {
  report("Could not refresh", await api().refresh());
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

// ---------- the keyboard and the menu ----------

/** the list on screen, in the order it is drawn, and the keyboard's row in it */
function listOf(s: State): { screen: Section; ids: string[]; at: string | null } | null {
  const { name } = s.view;
  if (name !== "inbox" && name !== "sessions") return null;
  const ids =
    name === "inbox"
      ? s.inbox.rows.map((r) => r.sessionId)
      : sessionOrder(s.sessions?.project === s.project ? s.sessions.hits : [], s.inbox, s.filter);
  const active = s.active[name];
  // on a fresh list the first row is the keyboard's
  return { screen: name, ids, at: active && ids.includes(active) ? active : (ids[0] ?? null) };
}

function moveTo(s: State, list: NonNullable<ReturnType<typeof listOf>>, index: number): void {
  const id = list.ids[Math.min(list.ids.length - 1, Math.max(0, index))];
  if (id === undefined) return;
  s.set({
    active: { ...s.active, [list.screen]: id },
    keys: true,
    // an open panel goes where the keyboard goes. it never follows the mouse
    ...(s.peek ? { peek: id } : {}),
  });
  if (typeof document !== "undefined") {
    document.getElementById(optionId(id))?.scrollIntoView({ block: "nearest" });
  }
}

/** Enter, cmd-Enter and cmd-D on the keyboard's row */
function act(s: State, list: NonNullable<ReturnType<typeof listOf>>, type: Intent["type"]): void {
  // nothing shows which row the keyboard is on yet: show it, and let the next press act
  if (!s.keys) {
    s.set({ keys: true });
    return;
  }
  const { at } = list;
  if (!at) return;
  // its inbox row, when it needs the person: what Dismiss clears
  const row = s.inbox.rows.find((r) => r.sessionId === at);
  const session = list.screen === "inbox" ? row : s.sessions?.hits.find((h) => h.sessionId === at);
  if (!session) return;
  if (type === "open") openRow(list.screen, at);
  else if (type === "open-editor") openWith(session.key, session.open, session.title);
  else if (row) void review(row.project, row.reviewKeys);
}

function focusSearch(): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById("search") as HTMLInputElement | null;
  el?.focus();
  el?.select();
}

/** what a key or a menu item does */
export function perform(intent: Intent): void {
  const s = state();
  const list = listOf(s);
  switch (intent.type) {
    case "move":
      if (list) {
        // the open row always shows, so an arrow steps from it at once, wherever the mouse has been
        const open = s.peek && list.ids.includes(s.peek) ? s.peek : null;
        const from = open ?? list.at;
        // nothing shows which row the keyboard is on yet: the first arrow shows it, like the first Enter
        moveTo(s, list, (from ? list.ids.indexOf(from) : -1) + (s.keys || open ? intent.delta : 0));
      }
      break;
    case "move-to":
      if (list) moveTo(s, list, intent.where === "first" ? 0 : list.ids.length - 1);
      break;
    case "open":
    case "open-editor":
    case "review":
      if (list) act(s, list, intent.type);
      break;
    case "back":
      back();
      break;
    case "close-panel":
      s.set({ peek: null });
      focusScreen();
      break;
    case "clear-query":
      s.set({ filter: "" });
      break;
    case "close-overlay":
      s.set({ overlay: null });
      focusScreen();
      break;
    case "go":
      go(intent.section);
      focusScreen();
      break;
    case "palette":
      s.set({ overlay: "palette" });
      break;
    case "project-step": {
      // the sidebar's order: the inbox, then the projects
      const ids = s.projects.map((p) => p.id);
      const at = s.view.name === "inbox" ? -1 : ids.indexOf(s.project ?? "");
      const to = Math.min(ids.length - 1, at + intent.delta);
      const next = ids[to];
      if (next && to !== at) switchProject(next);
      else if (to < 0 && at >= 0) go("inbox");
      break;
    }
    case "new-project":
      newProject();
      break;
    case "edit-project":
      editProject();
      break;
    case "open-project":
      if (s.project && s.view.name === "sessions") void openProject(s.project);
      break;
    case "refresh":
      void refresh();
      break;
    case "settings":
      s.set({ dialog: { kind: "settings" } });
      break;
    case "focus-search":
      // the filter is a project's: from the inbox, the project that was last on screen. full text
      // is the palette's
      if (s.view.name !== "sessions") go("sessions");
      // the field is drawn with the screen, a frame from now
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusSearch);
      break;
  }
}
