// what cmd-K lists for a query. pure: the palette draws the items and runs them by id.
import { tokenize } from "@grove/core/pure";
import type { ProjectView, SessionHit } from "../../shared/ipc.ts";
import { startBlocked } from "./views.ts";

export type PaletteSection =
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
    items.push(
      mine(
        "long-work",
        p.longWork === "background"
          ? "Run long work in the conversation"
          : "Run long work in the background",
        "long work background",
      ),
    );
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
  // the archived projects show only once something is typed: the keyboard can still reach one
  const items = commands(ctx).filter((i) =>
    typed ? matchCommand(`${i.label} ${i.keywords ?? ""}`, words) : i.section !== "Archived",
  );
  const answered = ctx.sessions?.query === query;
  if (typed && answered) {
    for (const hit of ctx.sessions?.hits.slice(0, 50) ?? []) {
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
