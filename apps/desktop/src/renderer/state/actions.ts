import type {
  InboxView,
  OpenPlan,
  ProjectId,
  SessionKey,
  StartAgentRequest,
} from "../../shared/ipc.ts";
import type { Intent } from "../logic/keyboard.ts";
import { nextActiveKey } from "../logic/rows.ts";
import { CLOSED, groupSessions, PAGE, sessionOrder } from "../logic/views.ts";
import {
  listInput,
  rememberProject,
  type Section,
  type State,
  scopeOf,
  useStore,
} from "./store.ts";

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

/**
 * a list from the sidebar, the menu or the palette: nothing to go back to, Older closed, and
 * nothing typed. a search never narrows a list it was not typed on
 */
export function go(section: Section): void {
  state().set({
    section,
    view: { name: section },
    back: [],
    overlay: null,
    peek: null,
    filter: "",
    older: CLOSED,
  });
}

/** the Usage screen, from the sidebar, the menu or the palette. Back has nowhere to go from it */
export function goUsage(): void {
  state().set({ view: { name: "usage" }, back: [], overlay: null, peek: null, filter: "" });
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
    older: CLOSED,
    active: { ...s.active, sessions: null },
    // another list's rows never show under this project's name
    sessions: s.sessions?.scope === id ? s.sessions : null,
  });
  rememberProject(id);
}

/** a list is on screen, not a form */
const onList = (s: State): boolean => s.view.name === "inbox" || s.view.name === "sessions";

let asked = 0;
/** the sessions of the list on screen, from main. an answer that came too late is dropped */
export async function loadSessions(): Promise<void> {
  if (!onList(state())) return;
  const scope = scopeOf(state());
  const mine = ++asked;
  // main did not answer: what is on screen stays
  const hits = await api()
    .listSessions(scope)
    .catch(() => null);
  if (hits && mine === asked && onList(state()) && scopeOf(state()) === scope) {
    state().set({ sessions: { scope, hits } });
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

/** a new conversation in the project's window, with nothing typed for it: the ask is typed there */
export const newSession = (project: ProjectId): void =>
  void startAgent({ project, where: "editor", prompt: "" });

/** the same for every start in the app */
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

/** the ids of the rows that need the person, as the list on screen draws them */
const needsOf = (s: State): string[] =>
  groupSessions(listInput(s))
    .find((g) => g.key === "needs")
    ?.items.map((i) => i.hit.sessionId) ?? [];

/**
 * the inbox moved. on the home screen a session that left Needs you is still listed, lower down in
 * its day's group, so the triage is kept here: the panel and the keyboard go to the row that took
 * its place in Needs you, and the panel closes with the last one. a project's screen leaves both
 * where they are
 */
export function setInbox(inbox: InboxView): void {
  const s = state();
  const home = s.view.name === "inbox";
  const was = needsOf(s);
  const now = needsOf({ ...s, inbox });
  const next = (id: string | null) =>
    home && id && was.includes(id) && !now.includes(id) ? nextActiveKey(was, now, id, false) : id;
  s.set({ inbox, peek: next(s.peek), active: { ...s.active, inbox: next(s.active.inbox) } });
}

/** Older's header: its rows show, or go. a panel on one of them goes with them */
export function toggleOlder(): void {
  const s = state();
  const older = groupSessions(listInput(s)).find((g) => g.key === "older");
  if (!older) return;
  const closes = older.open && older.items.some((i) => i.hit.sessionId === s.peek);
  s.set({ older: { open: !older.open, drawn: PAGE }, ...(closes ? { peek: null } : {}) });
}

/** the next rows of an open Older. false when all of it is drawn, or it is closed */
export function drawMore(): boolean {
  const s = state();
  const older = groupSessions(listInput(s)).find((g) => g.key === "older");
  if (!older?.open || older.items.length >= older.count) return false;
  s.set({ older: { ...s.older, drawn: older.items.length + PAGE } });
  return true;
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
  setInbox(optimistic);
  const ok = report("Could not dismiss it", await api().review(project, keys, true));
  if (!ok && state().inbox === optimistic) state().set({ inbox: before });
  return ok;
}

/**
 * put a project away, or bring it back. archiving the one on screen goes to All sessions: its row
 * has left the list for Archived. unarchiving stays on the project
 */
export async function archiveProject(id: ProjectId, archived: boolean): Promise<void> {
  const name = nameOf(id);
  const res = await api().setArchived(id, archived);
  if (!report(`Could not ${archived ? "archive" : "unarchive"} ${name}`, res)) return;
  const s = state();
  s.toast({ level: "info", title: `${archived ? "Archived" : "Unarchived"} ${name}` });
  if (archived && s.project === id && s.view.name !== "inbox") {
    go("inbox");
    focusScreen();
  }
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
  const ids = sessionOrder(listInput(s));
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
  if (typeof document === "undefined") return;
  const show = () => document.getElementById(optionId(id))?.scrollIntoView({ block: "nearest" });
  // a row Older drew for this very move is in the page a frame from now
  if (document.getElementById(optionId(id))) show();
  else requestAnimationFrame(show);
}

/** the pointer is on this row, so its buttons show: it is plain which row a key would act on */
const underPointer = (id: string): boolean =>
  typeof document !== "undefined" && !!document.getElementById(optionId(id))?.matches(":hover");

/** Enter, cmd-Enter and cmd-D on the keyboard's row */
function act(s: State, list: NonNullable<ReturnType<typeof listOf>>, type: Intent["type"]): void {
  let { at } = list;
  if (!s.keys) {
    // the mouse moved last, so no row is marked as the keyboard's. a row that shows it is the one
    // is acted on at once: the row under the pointer, else the row open in the panel, which is
    // what he is reading. with neither, the first press only shows the keyboard's row
    if (!(at && underPointer(at))) at = s.peek && list.ids.includes(s.peek) ? s.peek : null;
    if (!at) {
      s.set({ keys: true });
      return;
    }
  }
  if (!at) return;
  // its inbox row, when it needs the person: what Dismiss clears
  const row = s.inbox.rows.find((r) => r.sessionId === at);
  const session = listInput(s).hits?.find((h) => h.sessionId === at) ?? row;
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
        const to = (from ? list.ids.indexOf(from) : -1) + (s.keys || open ? intent.delta : 0);
        // past the last row an open Older has drawn: its next rows are drawn, and the arrow lands there
        const more = to >= list.ids.length && drawMore();
        moveTo(state(), (more && listOf(state())) || list, to);
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
    case "go-usage":
      goUsage();
      break;
    case "palette":
      s.set({ overlay: "palette" });
      break;
    case "project-step": {
      // the sidebar's order: the inbox, then the projects. the archived ones are put away, and
      // are not stepped through
      const ids = s.projects.filter((p) => !p.archived).map((p) => p.id);
      const here = ids.indexOf(s.project ?? "");
      // an archived project on screen sits under them all: up from it is the last of them
      const at = s.view.name === "inbox" ? -1 : here < 0 ? ids.length : here;
      const to = at + intent.delta;
      const next = ids[to];
      if (next) switchProject(next);
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
    case "archive-project": {
      // the project on screen, like cmd-O and cmd-E: All sessions shows no one project. its form
      // is left alone, where it would throw away what was typed
      const p = s.view.name === "sessions" && s.projects.find((x) => x.id === s.project);
      if (p) void archiveProject(p.id, !p.archived);
      break;
    }
    case "refresh":
      void refresh();
      break;
    case "settings":
      s.set({ dialog: { kind: "settings" } });
      break;
    case "focus-search":
      // the field is the list's on screen. a form has none: its own list comes back first
      if (!onList(s)) go(s.section);
      // the field is drawn with the screen, a frame from now
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusSearch);
      break;
  }
}
