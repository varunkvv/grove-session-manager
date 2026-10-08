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
import { loadSessions, switchProject } from "./actions.ts";
import { takeLanding } from "./landing.ts";

/** the two lists: every project's inbox, and one project's sessions */
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
  /** the sessions of one project, newest first. null until main has answered for `project` */
  sessions: { project: ProjectId; hits: SessionHit[] } | null;
  /** what is typed in the sessions list's filter */
  filter: string;
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

/** the project the sessions screen is on left the list, or the first one arrived */
function followProjects(projects: ProjectView[]): void {
  const s = useStore.getState();
  if (s.project !== null && projects.some((p) => p.id === s.project)) return;
  const first = projects[0]?.id ?? null;
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
    window.grove.on("inbox:changed", (p) =>
      gate("inbox", p.rev, () => set({ inbox: { rows: p.rows } })),
    ),
    // a nudge with nothing in it: the list on screen asks main again
    window.grove.on("sessions:changed", () => {
      if (useStore.getState().view.name === "sessions") void loadSessions();
    }),
    window.grove.on("editor:status", (editor) => set({ editor })),
    window.grove.on("toast", (t) => toast(t)),
    // a notification or a tray row was clicked: take where it lands, now that the page is here
    window.grove.on("app:land", () => {
      if (revs) void takeLanding();
    }),
  ];

  const boot = await window.grove.bootstrap();
  const saved = rememberedProject();
  set({
    ready: true,
    env: boot.env,
    settings: boot.settings,
    editor: boot.editor,
    projects: boot.projects,
    projectsProblem: boot.projectsProblem,
    inbox: boot.inbox,
    project: boot.projects.some((p) => p.id === saved) ? saved : (boot.projects[0]?.id ?? null),
  });
  revs = { ...boot.revs };
  for (const replay of buffered.splice(0)) replay();
  // the click that started the app, or one that came while the page was loading
  void takeLanding();

  return () => {
    for (const off of offs) off();
  };
}
