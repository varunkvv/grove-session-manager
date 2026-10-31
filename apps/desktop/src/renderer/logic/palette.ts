// what cmd-K lists for a query, in the main window and in a chat window. pure: the palettes draw
// the items and run them by id.
import { tokenize } from "@grove/core/pure";
import type { ChatWindowView, ProjectView, SessionHit } from "../../shared/ipc.ts";
import type { ChatAction } from "./chatKeys.ts";
import { rank } from "./fuzzy.ts";
import { type SessionItem, startBlocked, stateOf } from "./views.ts";

export type PaletteSection =
  | "Windows"
  | "Go to"
  | "Projects"
  | "Archived"
  | "This project"
  | "App"
  | "Sessions";

export interface PaletteItem {
  /** what it runs: `go-inbox`, `project:{id}`, `session:{key}` ... */
  id: string;
  section: PaletteSection;
  label: string;
  /** words it also answers to */
  keywords?: string;
  /** the shortcut on the right */
  kbd?: string;
  /** the project on screen, checked */
  current?: boolean;
  /** a Sessions row's hit */
  hit?: SessionHit;
  /** a Windows row's open chat window */
  window?: SessionItem;
}

export interface PaletteContext {
  /** the project on screen. none while the inbox is, which is every project's */
  project: ProjectView | null;
  /** every project, in combos.json order */
  projects: readonly ProjectView[];
  /** `VS Code` or `Cursor` */
  editor: string;
  /** findSessions' newest answer and the query it answered */
  sessions?: { query: string; hits: readonly SessionHit[] };
  /** the open chat windows, the one looked at last first */
  windows?: readonly ChatWindowView[];
}

/** every word starts a word of the text: `sess` finds Sessions, `ssions` does not */
export function matchCommand(text: string, words: readonly string[]): boolean {
  const hay = text.toLowerCase();
  return words.every((w) => {
    for (let i = hay.indexOf(w); i >= 0; i = hay.indexOf(w, i + 1)) {
      if (i === 0 || !/[\p{L}\p{N}]/u.test(hay.charAt(i - 1))) return true;
    }
    return false;
  });
}

const REPAIRABLE = new Set(["absent", "stale", "foreign"]);

/**
 * an open chat window as a row says it: the inbox row's parts. what it is at is what its own
 * header says: what it asks, then grove's claude for it, then the hooks
 */
const windowItem = ({ hit, row, asking, running }: ChatWindowView): SessionItem => ({
  hit,
  state: row?.kind ?? (asking ? "turn" : running ? "working" : stateOf(hit)),
  ...(row ? { row } : {}),
});

/**
 * the open windows a query keeps: a word that starts a word of the title, the project, the
 * description or what it asks. not fuzzy, or `ren` would put windows above Rename
 */
function windowsFor(windows: readonly ChatWindowView[], words: readonly string[]): SessionItem[] {
  return windows
    .map(windowItem)
    .filter(
      (w) =>
        words.length === 0 ||
        matchCommand(
          `${w.hit.title} ${w.hit.where} ${w.hit.description ?? ""} ${w.row?.summary ?? ""}`,
          words,
        ),
    );
}

function commands(ctx: PaletteContext): PaletteItem[] {
  const p = ctx.project;
  const items: PaletteItem[] = [];
  if (ctx.projects.length > 0) {
    items.push({
      id: "go-inbox",
      section: "Go to",
      label: "All sessions",
      // what the screen was called until 0.12
      keywords: "go inbox",
      kbd: "⌘1",
    });
  }
  // the whole machine's, so it is there with no project too
  items.push({
    id: "go-usage",
    section: "Go to",
    label: "Usage",
    keywords: "go cost spend tokens agent time",
    kbd: "⌘3",
  });
  // a project is its sessions. an archived one is put away here too, and found by its name. it
  // does not answer to `archive`: that word is for the command, which Enter must land on
  for (const q of ctx.projects) {
    items.push({
      id: `project:${q.id}`,
      section: q.archived ? "Archived" : "Projects",
      label: q.name,
      keywords: "switch project sessions",
      current: q.id === p?.id,
    });
  }
  if (p) {
    const mine = (id: string, label: string, keywords: string): PaletteItem => ({
      id,
      section: "This project",
      label,
      keywords,
    });
    if (!startBlocked(p)) {
      items.push(
        mine("new-session", `New session in ${ctx.editor}`, "start agent claude conversation"),
        mine("start-background", "Start a background session…", "new agent claude bg"),
      );
    }
    if (p.folders.some((f) => REPAIRABLE.has(f.state)))
      items.push(mine("repair", "Repair working copies", "worktree fix drift"));
    items.push(
      {
        ...(p.archived
          ? mine("archive-project", "Unarchive project", "archive restore bring back")
          : mine("archive-project", "Archive project", "hide put away")),
        kbd: "⌘⇧A",
      },
      mine("delete-project", "Delete project…", "remove trash disk space"),
    );
  }
  items.push({
    id: "settings",
    section: "App",
    label: "Settings…",
    keywords: "preferences appearance theme notifications",
    kbd: "⌘,",
  });
  return items;
}

const ORDER: PaletteSection[] = [
  "Windows",
  "Go to",
  "Projects",
  "Archived",
  "This project",
  "App",
  "Sessions",
];

export interface PaletteList {
  sections: Array<{ label: PaletteSection; items: PaletteItem[] }>;
  /** `No matches.`: nothing at all, and the session search has answered this query */
  none: boolean;
}

export function paletteItems(ctx: PaletteContext, query: string): PaletteList {
  const words = tokenize(query);
  const typed = words.length > 0;
  // the chat windows open now, the one looked at last first: Enter goes back to it
  const items: PaletteItem[] = windowsFor(ctx.windows ?? [], words).map((w) => ({
    id: `window:${w.hit.sessionId}`,
    section: "Windows",
    label: w.hit.title,
    window: w,
  }));
  // the archived projects show only once something is typed: the keyboard can still reach one
  for (const i of commands(ctx)) {
    if (typed ? matchCommand(`${i.label} ${i.keywords ?? ""}`, words) : i.section !== "Archived")
      items.push(i);
  }
  const answered = ctx.sessions?.query === query;
  // a session open in a window is that window's row
  const open = new Set(ctx.windows?.map((w) => w.hit.sessionId));
  if (typed && answered) {
    const hits = ctx.sessions?.hits.filter((h) => !open.has(h.sessionId)) ?? [];
    for (const hit of hits.slice(0, 50)) {
      items.push({
        id: `session:${hit.key}`,
        section: "Sessions",
        label: hit.title,
        hit,
      });
    }
  }
  const sections = ORDER.map((label) => ({
    label,
    items: items.filter((i) => i.section === label),
  })).filter((s) => s.items.length > 0);
  return { sections, none: sections.length === 0 && (!typed || answered) };
}

export type ChatPaletteItem =
  | { id: string; kind: "window"; window: SessionItem }
  | { id: "all-sessions"; kind: "all" }
  | { id: string; kind: "action"; action: ChatAction }
  | { id: string; kind: "session"; hit: SessionHit };

export interface ChatPaletteContext {
  /** the window's own session: it is not a window to go to, nor a session to find */
  self: string;
  /** the open chat windows, the one looked at last first, this one among them */
  windows: readonly ChatWindowView[];
  actions: readonly ChatAction[];
  /** findSessions' newest answer and the query it answered */
  sessions?: { query: string; hits: readonly SessionHit[] };
}

const GROUPS: ChatAction["group"][] = ["Session", "Message", "Composer", "View"];

/**
 * grove chat's ⌘K: the other open windows on top, the one looked at last first, and All sessions
 * after them. then the actions by group. typed: the windows by word, the actions by their letters,
 * then the sessions found. with no other window open it is as it was before there were any
 */
export function chatPaletteItems(
  ctx: ChatPaletteContext,
  query: string,
): Array<{ label: string; items: ChatPaletteItem[] }> {
  const words = tokenize(query);
  const typed = words.length > 0;
  const others = ctx.windows.filter((w) => w.hit.sessionId !== ctx.self);
  const windows: ChatPaletteItem[] = windowsFor(others, words).map((w) => ({
    id: `window:${w.hit.sessionId}`,
    kind: "window",
    window: w,
  }));
  if (others.length > 0 && (!typed || matchCommand("All sessions inbox main window", words)))
    windows.push({ id: "all-sessions", kind: "all" });
  const live = ctx.actions.filter((a) => !a.off);
  const action = (a: ChatAction): ChatPaletteItem => ({ id: a.id, kind: "action", action: a });
  const sections = [{ label: "Windows", items: windows }];
  if (!typed) {
    for (const g of GROUPS) {
      sections.push({ label: g, items: live.filter((a) => a.group === g).map(action) });
    }
  } else {
    sections.push({
      label: "Actions",
      items: rank(live, query.trim(), (a) => a.label).map(action),
    });
    const open = new Set([ctx.self, ...ctx.windows.map((w) => w.hit.sessionId)]);
    const hits = ctx.sessions?.query === query ? ctx.sessions.hits : [];
    sections.push({
      label: "Sessions",
      items: hits
        .filter((h) => !open.has(h.sessionId))
        .slice(0, 50)
        .map((hit) => ({ id: `session:${hit.sessionId}`, kind: "session", hit })),
    });
  }
  return sections.filter((s) => s.items.length > 0);
}
