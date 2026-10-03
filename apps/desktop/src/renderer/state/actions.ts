import type {
  ArtifactView,
  InboxRowView,
  OpenPlan,
  ProjectId,
  SessionKey,
  StartAgentRequest,
} from "../../shared/ipc.ts";
import type { Intent } from "../logic/keyboard.ts";
import { webLink } from "../logic/refs.ts";
import {
  artifactName,
  cardOrder,
  filterConclusions,
  projectRows,
  prUrl,
  revealConclusion,
} from "../logic/views.ts";
import { rememberProject, type Section, type State, useStore } from "./store.ts";

const api = () => window.grove;
const state = () => useStore.getState();
const editorLabel = () => state().editor?.label ?? "the editor";
const nameOf = (id: ProjectId) => state().projects.find((p) => p.id === id)?.name ?? id;

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

// ---------- navigation ----------

const NO_CONCLUSIONS = { query: "", kind: "all", open: null } as const;

/** a screen from the nav, the menu or the palette: nothing to go back to */
export function go(section: Section): void {
  state().set({
    section,
    view: { name: section },
    back: [],
    overlay: null,
    ...(section === "conclusions" ? { conclusions: NO_CONCLUSIONS } : {}),
  });
}

/** the nav keeps saying where the card was opened from */
export function openCard(cardId: string): void {
  const s = state();
  s.set({ back: [...s.back, s.view], view: { name: "card", cardId } });
}

/** that conclusion, open, on the Conclusions screen. a search or a kind that hides it is reset */
export function openConclusion(id: string): void {
  const s = state();
  const list = (s.project ? s.records[s.project]?.conclusions : undefined) ?? [];
  s.set({
    ...(s.view.name === "conclusions"
      ? {}
      : { back: [...s.back, s.view], section: "conclusions", view: { name: "conclusions" } }),
    conclusions: revealConclusion(list, s.conclusions, id),
  });
}

export function back(): void {
  const s = state();
  s.set({ view: s.back.at(-1) ?? { name: s.section }, back: s.back.slice(0, -1) });
}

/** the same screen in the other project */
export function switchProject(id: ProjectId): void {
  const s = state();
  s.set({
    project: id,
    view: { name: s.section },
    back: [],
    card: null,
    active: { inbox: null, cards: null, conclusions: null },
    conclusions: NO_CONCLUSIONS,
  });
  rememberProject(id);
}

/** the menu's accelerator and the page's key can both ask: a second ask changes nothing */
export function newProject(): void {
  const s = state();
  if (s.view.name === "new-project") return;
  s.set({ back: [...s.back, s.view], view: { name: "new-project" }, overlay: null });
}

export function editProject(): void {
  const s = state();
  if (!s.project || s.view.name === "edit-project") return;
  s.set({
    back: [...s.back, s.view],
    view: { name: "edit-project" },
    section: "cards",
    overlay: null,
  });
}

/** puts the keyboard back where the screen wants it. a form does it itself, with autoFocus */
export function focusScreen(): void {
  if (typeof document === "undefined") return;
  const { name } = state().view;
  const target =
    name === "inbox" || name === "cards"
      ? "[data-list]"
      : name === "conclusions"
        ? "#search"
        : name === "card"
          ? '[data-testid="card-main"]'
          : null;
  if (target) document.querySelector<HTMLElement>(target)?.focus();
}

/** the DOM id of a list row, for aria-activedescendant and for scrolling the keyboard's row into view */
export const optionId = (id: string): string => `row-${id}`;

// ---------- what a row, a card or a chip does ----------

/** the one function every Open in {editor} control calls. one toast per open, after main answers */
export function openWith(
  key: SessionKey | undefined,
  plan: OpenPlan | undefined,
  label: string,
): void {
  if (!key || plan?.disabled) return;
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

/** a row with a card opens the card. one with only a session has no screen here, so the editor */
export function openRow(row: InboxRowView): void {
  if (row.card) openCard(row.card.id);
  else openWith(row.sessionKey, row.open, row.title);
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
 * the rows these keys clear leave at once, and main's next inbox is the truth either way. a
 * refusal puts them back, unless main has spoken since
 */
export async function review(project: ProjectId, keys: string[], reviewed = true): Promise<void> {
  const before = state().inbox;
  const marked = new Set(keys);
  const optimistic = {
    ...before,
    rows: before.rows.filter(
      (r) =>
        !(
          reviewed &&
          r.project === project &&
          r.reviewKeys.length > 0 &&
          r.reviewKeys.every((k) => marked.has(k))
        ),
    ),
  };
  state().set({ inbox: optimistic });
  const res = await api().review(project, keys, reviewed);
  if (!report("Could not mark it reviewed", res) && state().inbox === optimistic) {
    state().set({ inbox: before });
  }
}

/** a file is shown in Finder, never opened: an agent wrote the path, and Finder runs nothing */
export async function openArtifact(project: ProjectId, a: ArtifactView): Promise<void> {
  const name = artifactName(a);
  if (a.type === "file") {
    report(`Could not show ${name}`, await api().reveal(project, a.ref));
    return;
  }
  const url = a.type === "pr" ? prUrl(a.ref) : a.type === "link" ? webLink(a.ref) : null;
  if (url) report(`Could not open ${name}`, await api().openExternal(url));
  else if (report(`Could not copy ${name}`, await api().copyText(a.ref))) {
    state().toast({ level: "info", title: `Copied ${name}` });
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
  if (!s.project || (name !== "inbox" && name !== "cards" && name !== "conclusions")) return null;
  const record = s.records[s.project];
  const ids =
    name === "inbox"
      ? projectRows(s.inbox, s.project).map((r) => r.id)
      : name === "cards"
        ? cardOrder(record?.cards ?? [])
        : filterConclusions(record?.conclusions ?? [], s.conclusions.query, s.conclusions.kind).map(
            (c) => c.id,
          );
  const active = s.active[name];
  // on a fresh list the first row is the keyboard's
  return { screen: name, ids, at: active && ids.includes(active) ? active : (ids[0] ?? null) };
}

function moveTo(s: State, list: NonNullable<ReturnType<typeof listOf>>, index: number): void {
  const id = list.ids[Math.min(list.ids.length - 1, Math.max(0, index))];
  if (id === undefined) return;
  s.set({ active: { ...s.active, [list.screen]: id }, keys: true });
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
  if (!at || !s.project) return;
  if (list.screen === "inbox") {
    const row = s.inbox.rows.find((r) => r.project === s.project && r.id === at);
    if (!row) return;
    if (type === "open") openRow(row);
    else if (type === "open-editor") openWith(row.sessionKey, row.open, row.card?.id ?? row.title);
    else void review(s.project, row.reviewKeys);
  } else if (list.screen === "cards") {
    // a card head carries no session to open, and a card is not reviewed: its inbox rows are
    if (type === "open") openCard(at);
  } else {
    const c = s.records[s.project]?.conclusions.find((x) => x.id === at);
    if (!c) return;
    if (type === "open") {
      s.set({ conclusions: { ...s.conclusions, open: s.conclusions.open === at ? null : at } });
    } else if (type === "open-editor") openWith(c.sessionKey, c.open, c.id);
    else if (c.needsReview && !c.reviewed) void review(s.project, [`conclusion:${c.id}`]);
  }
}

function focusSearch(select: boolean): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById("search") as HTMLInputElement | null;
  el?.focus();
  if (select) el?.select();
}

/** what a key or a menu item does */
export function perform(intent: Intent): void {
  const s = state();
  const list = listOf(s);
  switch (intent.type) {
    case "move":
      if (list) moveTo(s, list, (list.at ? list.ids.indexOf(list.at) : -1) + intent.delta);
      break;
    case "move-to":
      if (list) moveTo(s, list, intent.where === "first" ? 0 : list.ids.length - 1);
      break;
    case "open":
    case "review":
      if (list) act(s, list, intent.type);
      break;
    case "open-editor":
      if (list) act(s, list, intent.type);
      // a card: its header's button, and only when it opens. never a start
      else if (s.view.name === "card" && typeof document !== "undefined") {
        document
          .querySelector<HTMLElement>('[data-testid="card-primary"][data-action="open"]')
          ?.click();
      }
      break;
    case "back":
      back();
      break;
    case "collapse":
      s.set({ conclusions: { ...s.conclusions, open: null } });
      break;
    case "clear-query":
      s.set({ conclusions: { ...s.conclusions, query: "" } });
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
      const ids = s.projects.map((p) => p.id);
      const next =
        ids[Math.min(ids.length - 1, Math.max(0, ids.indexOf(s.project ?? "") + intent.delta))];
      if (next && next !== s.project) switchProject(next);
      break;
    }
    case "new-project":
      newProject();
      break;
    case "edit-project":
      editProject();
      break;
    case "open-project":
      if (s.project) void openProject(s.project);
      break;
    case "refresh":
      void refresh();
      break;
    case "settings":
      s.set({ dialog: { kind: "settings" } });
      break;
    case "focus-search":
      // search means the record: sessions are searched in the palette. the screen focuses its
      // field when it mounts
      if (s.view.name !== "conclusions") go("conclusions");
      focusSearch(true);
      break;
    case "type-through":
      focusSearch(false);
      break;
  }
}
