import { create } from "zustand";
import type {
  AppSettings,
  Bootstrap,
  CardView,
  EditorStatus,
  EnvInfo,
  InboxView,
  ProjectId,
  ProjectRecordView,
  ProjectView,
  PushEvents,
  ToastMessage,
} from "../../shared/ipc.ts";
import type { ConclusionControls } from "../logic/views.ts";
import { switchProject } from "./actions.ts";
import { takeLanding } from "./landing.ts";

export type Section = "inbox" | "cards" | "conclusions";

export type View =
  | { name: "inbox" }
  | { name: "cards" }
  | { name: "card"; cardId: string }
  | { name: "conclusions" }
  | { name: "new-project" }
  | { name: "edit-project" };

export type DialogState =
  | null
  | { kind: "settings" }
  | { kind: "delete"; project: ProjectId }
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
  /** the project on screen. null only when there are no projects at all. */
  project: ProjectId | null;
  section: Section;
  view: View;
  /** what Back and Escape return to. a new screen from the nav, the palette or a project switch clears it. */
  back: View[];
  /** every project's inbox rows, Asked and Stopped first, and the tray count */
  inbox: InboxView;
  /** every project's cards and conclusions. `readAt` is absent until the first read */
  records: Record<ProjectId, ProjectRecordView>;
  /** the card on screen with its thread. null until `card()` has answered */
  card: CardView | null;
  /** the keyboard's row on each list screen, by id */
  active: { inbox: string | null; cards: string | null; conclusions: string | null };
  /** the keyboard moved last. while false no row looks active and only hover shows a row's buttons */
  keys: boolean;
  /**
   * the inbox row or the card open in the panel beside its list, by id. one for both screens: only
   * one list is on screen, and `go` clears it. a trip to a card page and Back keeps it
   */
  peek: string | null;
  /** the Conclusions screen's controls. they outlive a trip to a card and back. */
  conclusions: ConclusionControls;
  /** a popover the global key handler must leave alone */
  overlay: null | "palette" | "switcher";
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
  inbox: { rows: [], tray: 0 },
  records: {},
  card: null,
  active: { inbox: null, cards: null, conclusions: null },
  keys: false,
  peek: null,
  conclusions: { query: "", kind: "all", open: null },
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

/** one project's record after a push: changed heads are upserts unless `replace`, the rest comes whole */
export function applyRecord(
  had: ProjectRecordView | undefined,
  p: Omit<PushEvents["record:changed"], "rev" | "project">,
): ProjectRecordView {
  const base = had ?? { cards: [], conclusions: [], problems: [] };
  let cards = base.cards;
  if (p.replace) cards = p.cards ?? [];
  else if (p.cards || p.removedCards) {
    const byId = new Map(cards.map((c) => [c.id, c]));
    for (const id of p.removedCards ?? []) byId.delete(id);
    for (const c of p.cards ?? []) byId.set(c.id, c);
    cards = [...byId.values()];
  }
  return {
    cards,
    conclusions: p.conclusions ?? base.conclusions,
    problems: p.problems ?? base.problems,
    readAt: p.readAt ?? base.readAt,
  };
}

/** the project on screen left the list, or the first one arrived */
function followProjects(projects: ProjectView[]): void {
  const { project, set } = useStore.getState();
  if (project !== null && projects.some((p) => p.id === project)) return;
  const first = projects[0]?.id;
  if (first) switchProject(first);
  else set({ project: null });
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
    window.grove.on("record:changed", (p) =>
      gate("record", p.rev, () => {
        const { records } = useStore.getState();
        set({ records: { ...records, [p.project]: applyRecord(records[p.project], p) } });
      }),
    ),
    window.grove.on("inbox:changed", (p) =>
      gate("inbox", p.rev, () => set({ inbox: { rows: p.rows, tray: p.tray } })),
    ),
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
    records: boot.record,
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
