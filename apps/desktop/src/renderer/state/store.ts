import { create } from "zustand";
import type {
  AppSettings,
  Bootstrap,
  EditorStatus,
  EnvInfo,
  InboxView,
  ProjectId,
  ProjectView,
  SessionHit,
  ToastMessage,
} from "../../shared/ipc.ts";
import { CLOSED, type ListInput, type OlderView } from "../logic/views.ts";
import { loadSessions, setInbox, switchProject } from "./actions.ts";
import { takeLanding } from "./landing.ts";

/**
 * the two lists. `inbox` is the home screen, called All sessions on it: every project's sessions,
 * the ones that need the person first. `sessions` is one project's
 */
export type Section = "inbox" | "sessions";

export type View =
  | { name: "inbox" }
  | { name: "sessions" }
  | { name: "new-project" }
  | { name: "edit-project" };

export type DialogState =
  | null
  | { kind: "settings" }
  | { kind: "delete"; project: ProjectId }
  /** what a background session in this project should do */
  | { kind: "start"; project: ProjectId }
  /** one question before something that interrupts or costs. it carries its own words and what to run */
  | { kind: "confirm"; title: string; body: string; label: string; run: () => void };

export interface Toast extends ToastMessage {
  id: number;
}

export interface State {
  ready: boolean;
  env: EnvInfo | null;
  settings: AppSettings | null;
  editor: EditorStatus | null;
  /** in combos.json order */
  projects: ProjectView[];
  projectsProblem?: string;
  /**
   * the project whose sessions are on screen, or were last: the inbox is every project's. null
   * only when there are no projects at all
   */
  project: ProjectId | null;
  section: Section;
  view: View;
  /** what Back and Escape return to. a new screen from the sidebar, the menu or the palette clears it. */
  back: View[];
  /** every project's sessions that need the person, newest first */
  inbox: InboxView;
  /**
   * the sessions of the list on screen, newest first: a project's, or with a null scope every
   * project's. null until main has answered
   */
  sessions: { scope: ProjectId | null; hits: SessionHit[] } | null;
  /** what is typed in the top bar's search field, for the list on screen */
  filter: string;
  /** main's answer to what is typed: the sessions it found, by what was said in them too */
  found: { scope: ProjectId | null; query: string; hits: SessionHit[] } | null;
  /**
   * Older in the list on screen: whether its rows show, and how many of them are drawn. one for
   * both lists: `go` and `switchProject` are every way a list comes on screen, and close it
   */
  older: OlderView;
  /** the keyboard's row in each list, by session id */
  active: Record<Section, string | null>;
  /** the keyboard moved last. while false no row looks active and only hover shows a row's buttons */
  keys: boolean;
  /**
   * the session open in the panel beside its list, by id. one for both lists: only one is on
   * screen, and going to another clears it
   */
  peek: string | null;
  /** a popover the global key handler must leave alone */
  overlay: null | "palette";
  dialog: DialogState;
  toasts: Toast[];
  /** the banner reason that was dismissed. it comes back when its reason changes */
  bannerDismissed: string | null;
  now: number;

  set(patch: Partial<State>): void;
  toast(t: ToastMessage): void;
  dismissToast(id: number): void;
}

let toastId = 0;

export const useStore = create<State>((set) => ({
  ready: false,
  env: null,
  settings: null,
  editor: null,
  projects: [],
  project: null,
  section: "inbox",
  view: { name: "inbox" },
  back: [],
  inbox: { rows: [] },
  sessions: null,
  filter: "",
  found: null,
  older: CLOSED,
  active: { inbox: null, sessions: null },
  keys: false,
  peek: null,
  overlay: null,
  dialog: null,
  toasts: [],
  bannerDismissed: null,
  now: Date.now(),

  set: (patch) => set(patch),
  toast: (t) => set((s) => ({ toasts: [...s.toasts.slice(-2), { ...t, id: ++toastId }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** the project on screen */
export const currentProject = (s: State): ProjectView | undefined =>
  s.projects.find((p) => p.id === s.project);

/** which sessions the list on screen holds: a project's, or with null every project's */
export const scopeOf = (s: State): ProjectId | null => (s.view.name === "inbox" ? null : s.project);

/** what the list on screen is drawn from. the screen and the keyboard both read this */
export function listInput(s: State): ListInput {
  const scope = scopeOf(s);
  return {
    scope,
    // another list's rows never show on this one
    hits: s.sessions?.scope === scope ? s.sessions.hits : null,
    inbox: s.inbox,
    query: s.filter,
    // an answer to an older query, or to another list's, is nobody's
    found: s.found?.query === s.filter && s.found.scope === scope ? s.found.hits : undefined,
    now: s.now,
    older: s.older,
    peek: s.peek,
  };
}

const PROJECT_KEY = "grove.project";

/** localStorage can throw. nothing here is worth failing for */
export function rememberProject(id: ProjectId): void {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {}
}

function rememberedProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

/**
 * the project a screen falls back to: the first that is not archived. an archived one only when
 * all of them are, since no project at all is what the first-run form is drawn for
 */
const firstProject = (projects: readonly ProjectView[]): ProjectId | null =>
  (projects.find((p) => !p.archived) ?? projects[0])?.id ?? null;

/**
 * the project the app opens with: the one it was left on, unless that is gone or was archived
 * since. going to an archived one on purpose always works. this is only where a launch starts
 */
export const startProject = (
  projects: readonly ProjectView[],
  saved: string | null,
): ProjectId | null =>
  projects.some((p) => p.id === saved && !p.archived) ? saved : firstProject(projects);

/** the project the sessions screen is on left the list, or the first one arrived */
function followProjects(projects: ProjectView[]): void {
  const s = useStore.getState();
  if (s.project !== null && projects.some((p) => p.id === s.project)) return;
  const first = firstProject(projects);
  // its screen went with it. the inbox is every project's, so it stays
  if (first && s.view.name !== "inbox") switchProject(first);
  else s.set({ project: first, sessions: null });
}

/**
 * subscribe first and buffer, then take the snapshot, then replay only what is newer than it.
 * the other order loses any event that lands between the snapshot and the subscription.
 */
export async function connect(): Promise<() => void> {
  const { set, toast } = useStore.getState();
  type Domain = keyof Bootstrap["revs"];
  let revs: Bootstrap["revs"] | null = null;
  const buffered: Array<() => void> = [];
  const gate = (domain: Domain, rev: number, apply: () => void) => {
    if (!revs) return void buffered.push(() => gate(domain, rev, apply));
    if (rev <= revs[domain]) return;
    revs[domain] = rev;
    apply();
  };

  const offs = [
    window.grove.on("projects:changed", (p) =>
      gate("projects", p.rev, () => {
        set({ projects: p.projects, projectsProblem: p.problem });
        followProjects(p.projects);
      }),
    ),
    window.grove.on("projects:folders", (p) =>
      gate("projects", p.rev, () =>
        set({
          projects: useStore
            .getState()
            .projects.map((x) =>
              x.id === p.id
                ? { ...x, status: p.status, checkedAt: p.checkedAt, folders: p.folders }
                : x,
            ),
        }),
      ),
    ),
    window.grove.on("inbox:changed", (p) => gate("inbox", p.rev, () => setInbox({ rows: p.rows }))),
    // a nudge with nothing in it: the list on screen asks main again
    window.grove.on("sessions:changed", () => void loadSessions()),
    window.grove.on("editor:status", (editor) => set({ editor })),
    window.grove.on("toast", (t) => toast(t)),
    // a notification or a tray row was clicked: take where it lands, now that the page is here
    window.grove.on("app:land", () => {
      if (revs) void takeLanding();
    }),
  ];

  const boot = await window.grove.bootstrap();
  set({
    ready: true,
    env: boot.env,
    settings: boot.settings,
    editor: boot.editor,
    projects: boot.projects,
    projectsProblem: boot.projectsProblem,
    inbox: boot.inbox,
    project: startProject(boot.projects, rememberedProject()),
  });
  revs = { ...boot.revs };
  for (const replay of buffered.splice(0)) replay();
  // the click that started the app, or one that came while the page was loading
  void takeLanding();

  return () => {
    for (const off of offs) off();
  };
}
