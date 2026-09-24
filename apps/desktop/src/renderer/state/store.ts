import { create } from "zustand";
import type {
  AppSettings,
  ComboView,
  EditorStatus,
  EnvInfo,
  IndexStatus,
  PushEvents,
  SearchHit,
  SessionAction,
  SessionKey,
  SessionRow,
  ToastMessage,
} from "../../shared/ipc.ts";
import type { Scope } from "../logic/rows.ts";

export type DialogState =
  | null
  | { kind: "combo"; editing?: string }
  | { kind: "teardown"; name: string }
  | { kind: "delete"; name: string }
  | { kind: "settings" }
  /** an action that interrupts something, asked before it runs */
  | { kind: "confirm"; key: SessionKey; action: SessionAction }
  /** hand a session, or a new one in a combo, to Claude Code's supervisor */
  | {
      kind: "background";
      target: { kind: "continue"; key: SessionKey } | { kind: "new"; combo: string };
      /** what the prompt starts as. the person can change it, and nothing goes without them. */
      prompt: string;
    };

export interface MenuState {
  key: SessionKey;
  actions: SessionAction[];
  index: number;
}

export interface Toast extends ToastMessage {
  id: number;
}

/**
 * the agent inspector beside the list. it has no session of its own: it shows whichever row is
 * active, like a mail app's reading pane.
 */
export interface InspectorState {
  /** the agent the pane's keyboard is on */
  agent: string | null;
  /** the agent whose detail is showing in place of the list, and the session it belongs to */
  detail: { key: SessionKey; id: string } | null;
  /** a step to bring into view when the detail opens */
  step?: number;
  /** the search that led here: the detail lands on the step that matched it */
  find?: string;
}

interface State {
  ready: boolean;
  env: EnvInfo | null;
  settings: AppSettings | null;
  editor: EditorStatus | null;
  index: IndexStatus;
  /** newest activity first */
  sessions: SessionRow[];
  combos: ComboView[];
  combosProblem?: string;
  selectedCombo: string | null;
  scope: Scope;
  query: string;
  /** conversation matches for `query`, from the main process. stale ones are ignored. */
  deep: { query: string; hits: Map<SessionKey, SearchHit> } | null;
  activeKey: SessionKey | null;
  menu: MenuState | null;
  dialog: DialogState;
  /** null while closed */
  inspector: InspectorState | null;
  toasts: Toast[];
  bannerDismissed: boolean;
  now: number;

  set(patch: Partial<State>): void;
  selectCombo(name: string | null): void;
  setScope(scope: Scope): void;
  toast(t: ToastMessage): void;
  dismissToast(id: number): void;
}

let toastId = 0;

export const useStore = create<State>((set) => ({
  ready: false,
  env: null,
  settings: null,
  editor: null,
  index: { phase: "cache", done: 0, total: 0 },
  sessions: [],
  combos: [],
  selectedCombo: null,
  scope: "all",
  query: "",
  deep: null,
  activeKey: null,
  menu: null,
  dialog: null,
  inspector: null,
  toasts: [],
  bannerDismissed: false,
  now: Date.now(),

  set: (patch) => set(patch),
  selectCombo: (name) => set({ selectedCombo: name, scope: name ? "combo" : "all" }),
  setScope: (scope) =>
    set((s) => ({ scope: scope === "combo" && !s.selectedCombo ? "all" : scope })),
  toast: (t) => set((s) => ({ toasts: [...s.toasts.slice(-2), { ...t, id: ++toastId }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

function applySessionPatch(rows: SessionRow[], p: PushEvents["sessions:patch"]): SessionRow[] {
  const map = new Map<SessionKey, SessionRow>(p.replace ? [] : rows.map((r) => [r.key, r]));
  for (const key of p.removes) map.delete(key);
  for (const row of p.upserts) map.set(row.key, row);
  // a few thousand rows sort in about a millisecond. not worth being clever.
  return [...map.values()].sort((a, b) => b.activityMs - a.activityMs);
}

/**
 * subscribe first and buffer, then take the snapshot, then replay only what is newer than it.
 * the other order loses any event that lands between the snapshot and the subscription.
 */
export async function connect(): Promise<() => void> {
  const { set, toast } = useStore.getState();
  let revs: { sessions: number; combos: number } | null = null;
  const buffered: Array<() => void> = [];
  const gate = (domain: "sessions" | "combos", rev: number, apply: () => void) => {
    if (!revs) return void buffered.push(() => gate(domain, rev, apply));
    if (rev <= revs[domain]) return;
    revs[domain] = rev;
    apply();
  };

  const offs = [
    window.grove.on("sessions:patch", (p) =>
      gate("sessions", p.rev, () =>
        set({ sessions: applySessionPatch(useStore.getState().sessions, p) }),
      ),
    ),
    window.grove.on("sessions:index", (index) => set({ index })),
    window.grove.on("combos:changed", (p) =>
      gate("combos", p.rev, () => {
        const { selectedCombo } = useStore.getState();
        const gone = selectedCombo !== null && !p.combos.some((c) => c.name === selectedCombo);
        set({
          combos: p.combos,
          combosProblem: p.problem,
          ...(gone ? { selectedCombo: null, scope: "all" as Scope } : {}),
        });
      }),
    ),
    window.grove.on("combos:folders", (p) =>
      gate("combos", p.rev, () =>
        set({
          combos: useStore
            .getState()
            .combos.map((c) =>
              c.name === p.name
                ? { ...c, status: p.status, checkedAt: p.checkedAt, folders: p.folders }
                : c,
            ),
        }),
      ),
    ),
    window.grove.on("editor:status", (editor) => set({ editor })),
    window.grove.on("toast", (t) => toast(t)),
  ];

  const boot = await window.grove.bootstrap();
  set({
    ready: true,
    env: boot.env,
    settings: boot.settings,
    editor: boot.editor,
    index: boot.index,
    combos: boot.combos,
    combosProblem: boot.combosProblem,
    sessions: [...boot.sessions].sort((a, b) => b.activityMs - a.activityMs),
  });
  revs = { ...boot.revs };
  for (const replay of buffered.splice(0)) replay();

  return () => {
    for (const off of offs) off();
  };
}

export const selectedComboView = (s: State): ComboView | undefined =>
  s.combos.find((c) => c.name === s.selectedCombo);
