// what cmd-K lists for a query. pure: the palette draws the items and runs them by id.
import { tokenize } from "@grove/core/pure";
import type { CardHead, InboxRowView, ProjectView, SessionHit } from "../../shared/ipc.ts";
import { startBlocked } from "./views.ts";

export type PaletteSection = "Go to" | "Projects" | "This project" | "App" | "Sessions";

export interface PaletteItem {
  /** what it runs: `go-inbox`, `project:{id}`, `takeover:{card}`, `session:{key}` ... */
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
  /** the project on screen */
  project: ProjectView | null;
  /** every project, in combos.json order */
  projects: readonly ProjectView[];
  /** `VS Code` or `Cursor` */
  editor: string;
  /** the project's inbox rows */
  rows: readonly InboxRowView[];
  /** the project's cards */
  cards: readonly CardHead[];
  /** findSessions' newest answer and the query it answered */
  sessions?: { query: string; hits: readonly SessionHit[] };
}

/** every word starts a word of the text: `conc` finds Conclusions, `lusions` does not */
export function matchCommand(text: string, words: readonly string[]): boolean {
  const hay = text.toLowerCase();
  return words.every((w) => {
    for (let i = hay.indexOf(w); i >= 0; i = hay.indexOf(w, i + 1)) {
      if (i === 0 || !/[\p{L}\p{N}]/u.test(hay.charAt(i - 1))) return true;
    }
    return false;
  });
}

const REVIEWABLE = new Set(["decided", "verdict", "found", "new", "finished"]);

/** what `Mark all reviewed` marks: never an Asked or a Stopped row */
export function reviewAllKeys(rows: readonly InboxRowView[]): string[] {
  return rows.filter((r) => REVIEWABLE.has(r.kind)).flatMap((r) => r.reviewKeys);
}

const REPAIRABLE = new Set(["absent", "stale", "foreign"]);

function commands(ctx: PaletteContext, typed: boolean): PaletteItem[] {
  const p = ctx.project;
  const items: PaletteItem[] = [];
  if (p) {
    items.push(
      { id: "go-inbox", section: "Go to", label: "Inbox", keywords: "go", kbd: "⌘1" },
      { id: "go-cards", section: "Go to", label: "Cards", keywords: "go", kbd: "⌘2" },
      {
        id: "go-conclusions",
        section: "Go to",
        label: "Conclusions",
        keywords: "go decisions findings verdicts",
        kbd: "⌘3",
      },
    );
  }
  for (const q of ctx.projects) {
    items.push({
      id: `project:${q.id}`,
      section: "Projects",
      label: q.name,
      keywords: "switch project",
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
    if (!startBlocked(p, true)) {
      items.push(
        mine("start-editor", `Start an agent in ${ctx.editor}`, "new agent session claude"),
        mine("start-background", "Start an agent in the background", "new agent session claude"),
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
    if (reviewAllKeys(ctx.rows).length > 0)
      items.push(mine("review-all", `Mark all reviewed in ${p.name}`, "mark read clear inbox"));
    // a row per card can be long on a busy project, so these wait for a word, like Sessions
    if (typed) {
      for (const c of ctx.cards) {
        if (c.agent?.state !== "closed") continue;
        items.push(
          mine(
            `takeover:${c.id}`,
            `Start a new agent on ${c.id}`,
            `takeover reassign card ${c.id} ${c.title}`,
          ),
        );
      }
    }
    items.push(mine("delete-project", "Delete project…", "remove"));
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

const ORDER: PaletteSection[] = ["Go to", "Projects", "This project", "App", "Sessions"];

export interface PaletteList {
  sections: Array<{ label: PaletteSection; items: PaletteItem[] }>;
  /** `No matches.`: nothing at all, and the session search has answered this query */
  none: boolean;
}

export function paletteItems(ctx: PaletteContext, query: string): PaletteList {
  const words = tokenize(query);
  const typed = words.length > 0;
  const items = commands(ctx, typed).filter(
    (i) => !typed || matchCommand(`${i.label} ${i.keywords ?? ""}`, words),
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
