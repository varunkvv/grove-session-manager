import type { PrState } from "@grove/core/pure";
import type { OutputView, PrView, SessionRef } from "../../shared/ipc";

/** the glyph's shape. colour says how it is going, shape what it is */
export type PrGlyphKind = "open" | "draft" | "merged" | "closed";

export interface PrLook {
  glyph: PrGlyphKind;
  /** ui.tsx has the colours: green ready, red failing, faint the rest */
  tone: "green" | "red" | "faint";
  done: boolean;
}

const LOOK: Record<PrState, PrLook> = {
  ready: { glyph: "open", tone: "green", done: false },
  failing: { glyph: "open", tone: "red", done: false },
  pending: { glyph: "open", tone: "faint", done: false },
  draft: { glyph: "draft", tone: "faint", done: false },
  merged: { glyph: "merged", tone: "faint", done: true },
  closed: { glyph: "closed", tone: "faint", done: true },
};

/** a PR gh has not answered for (no gh, or not yet) is an open one with nothing known */
export const lookOf = (p: PrView): PrLook => LOOK[p.state ?? "pending"];

/** the repo's name without its owner: the panel and menus have room for the short one */
export const shortRepo = (repo: string) => repo.split("/").pop() || repo;

// ---------- what an output looks like ----------

/** one small stroked icon per family of kinds: ui.tsx draws them */
export type OutputGlyphKind =
  | "pr"
  | "issue"
  | "doc"
  | "sheet"
  | "slides"
  | "design"
  | "message"
  | "artifact"
  | "deploy"
  | "calendar"
  | "link";

const FAMILY: Record<string, OutputGlyphKind> = {
  pr: "pr",
  mr: "pr",
  issue: "issue",
  jira: "issue",
  linear: "issue",
  asana: "issue",
  clickup: "issue",
  monday: "issue",
  shortcut: "issue",
  trello: "issue",
  workitem: "issue",
  pagerduty: "issue",
  confluence: "doc",
  gdoc: "doc",
  notion: "doc",
  coda: "doc",
  gist: "doc",
  gdrive: "doc",
  microsoft: "doc",
  gsheet: "sheet",
  airtable: "sheet",
  gslides: "slides",
  figma: "design",
  canva: "design",
  miro: "design",
  slack: "message",
  discord: "message",
  teams: "message",
  claude: "artifact",
  deploy: "deploy",
  release: "deploy",
  gcal: "calendar",
};

export const glyphOf = (kind: string): OutputGlyphKind => FAMILY[kind] ?? "link";

/** the filter chips' words */
export const FAMILY_WORD: Record<OutputGlyphKind, string> = {
  pr: "Pull requests",
  issue: "Cards",
  doc: "Docs",
  sheet: "Sheets",
  slides: "Slides",
  design: "Designs",
  message: "Messages",
  artifact: "Artifacts",
  deploy: "Deploys",
  calendar: "Events",
  link: "Links",
};

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** what a row's kind says in a line: `#2352` for a PR, its key, else the short label */
export function shortKey(o: OutputView): string {
  const n = o.kind === "pr" ? /#(\d+)$/.exec(o.key ?? "")?.[1] : undefined;
  return n ? `#${n}` : (o.key ?? cap(o.label));
}

const newest = (a: OutputView, b: OutputView) => b.last - a.last;

/** one section of the session card: a kind's outputs, or the fork's copies */
export interface Section {
  title: string;
  items: OutputView[];
  tone: "made" | "other" | "inherited";
}

/** the card: made by kind, then updated and commented on by kind, then what came with a fork */
export function sectionsOf(outputs: readonly OutputView[] | undefined): Section[] {
  const all = [...(outputs ?? [])].sort(newest);
  const by = (list: OutputView[], tone: "made" | "other"): Section[] => {
    const groups = new Map<string, OutputView[]>();
    for (const o of list) groups.set(o.label, [...(groups.get(o.label) ?? []), o]);
    return [...groups].map(([label, items]) => ({
      title: `${cap(label)}s${tone === "other" ? " touched" : ""}`,
      items,
      tone,
    }));
  };
  const own = all.filter((o) => !o.inherited);
  const inherited = all.filter((o) => o.inherited);
  return [
    ...by(
      own.filter((o) => o.verb === "made"),
      "made",
    ),
    ...by(
      own.filter((o) => o.verb !== "made"),
      "other",
    ),
    ...(inherited.length
      ? [{ title: "From before the fork", items: inherited, tone: "inherited" as const }]
      : []),
  ];
}

/** an output and the session it came from, for the Outputs screen */
export interface Entry {
  o: OutputView;
  session: SessionRef;
}

const rank = (e: Entry) => (e.o.inherited ? 2 : e.o.verb === "made" ? 0 : 1);

/**
 * every output of the sessions, newest first. one url once and one (kind, key) once, so the same
 * jira card by two site names is one. the one kept is the earliest maker's, and its time the
 * newest any copy had
 */
export function screenOutputs(sessions: readonly SessionRef[]): Entry[] {
  const all = sessions.flatMap((session) =>
    (session.outputs ?? []).map((o): Entry => ({ o, session })),
  );
  all.sort((a, b) => rank(a) - rank(b) || a.o.first - b.o.first);
  const kept = new Map<string, Entry>();
  const out: Entry[] = [];
  for (const e of all) {
    const ids = [
      ...(e.o.url ? [`u ${e.o.url}`] : []),
      ...(e.o.key ? [`k ${e.o.kind} ${e.o.key}`] : []),
    ];
    const twin = ids.map((i) => kept.get(i)).find(Boolean);
    if (twin) {
      twin.o = { ...twin.o, last: Math.max(twin.o.last, e.o.last) };
      for (const i of ids) kept.set(i, twin);
      continue;
    }
    const mine = { ...e };
    for (const i of ids) kept.set(i, mine);
    out.push(mine);
  }
  return out.sort((a, b) => b.o.last - a.o.last);
}

/** the first instant of the local day `ms` is in */
export const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** the last millisecond of that local day */
export const endOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
};

/** the days between two picks, in whichever order they came, whole days both ends. one day is fine */
export const dayRange = (a: number, b: number): { from: number; to: number } => ({
  from: startOfDay(Math.min(a, b)),
  to: endOfDay(Math.max(a, b)),
});

/** a window of local days, ends included. none set is any time */
export interface DayRange {
  from?: number;
  to?: number;
}

export type Shortcut = "any" | "today" | "week" | "month" | "thisMonth" | "quarter";

export const SHORTCUTS: Array<{ value: Shortcut; label: string }> = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 30 days" },
  { value: "thisMonth", label: "This month" },
  { value: "quarter", label: "Last 90 days" },
];

/** a shortcut's days as of `now`: the last n days are today and the n - 1 before it */
export function shortcutRange(name: Shortcut, now: number): DayRange {
  const d = new Date(now);
  const back = (n: number) =>
    dayRange(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n + 1).getTime(), now);
  switch (name) {
    case "any":
      return {};
    case "today":
      return back(1);
    case "week":
      return back(7);
    case "month":
      return back(30);
    case "quarter":
      return back(90);
    case "thisMonth":
      return dayRange(new Date(d.getFullYear(), d.getMonth(), 1).getTime(), now);
  }
}

const SHORT_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** what the When button says: `Any time`, `Nov 1`, or `Oct 26 – Nov 1` */
export function rangeLabel(r: DayRange): string {
  if (r.from === undefined || r.to === undefined) return "Any time";
  const a = SHORT_DAY.format(r.from);
  const b = SHORT_DAY.format(r.to);
  return a === b ? a : `${a} \u2013 ${b}`;
}

/** the filters on the Outputs screen. an empty list is no filter on that axis */
export interface OutputFilter {
  projects: readonly string[];
  kinds: readonly OutputGlyphKind[];
  /** the first instant a touch may be at, or no start */
  from?: number;
  /** the last instant, or no end */
  to?: number;
}

/** entries that pass every filter that is set: a project's name is `where`, a kind is its family */
export function filterOutputs(entries: readonly Entry[], f: OutputFilter): Entry[] {
  return entries.filter(
    (e) =>
      (f.projects.length === 0 || f.projects.includes(e.session.where)) &&
      (f.kinds.length === 0 || f.kinds.includes(glyphOf(e.o.kind))) &&
      (f.from === undefined || e.o.last >= f.from) &&
      (f.to === undefined || e.o.last <= f.to),
  );
}

/** the projects present, for the filter chips, most outputs first */
export function projectsOf(entries: readonly Entry[]): Array<{ name: string; n: number }> {
  const n = new Map<string, number>();
  for (const e of entries) n.set(e.session.where, (n.get(e.session.where) ?? 0) + 1);
  return [...n]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** the families present, for the filter chips, most first */
export function familiesOf(
  entries: readonly Entry[],
): Array<{ glyph: OutputGlyphKind; n: number }> {
  const n = new Map<OutputGlyphKind, number>();
  for (const e of entries) n.set(glyphOf(e.o.kind), (n.get(glyphOf(e.o.kind)) ?? 0) + 1);
  return [...n].map(([glyph, n]) => ({ glyph, n })).sort((a, b) => b.n - a.n);
}

/** what a row's outputs look like: equal keys draw the same */
export const outputsKey = (outputs: readonly OutputView[] | undefined) =>
  (outputs ?? [])
    .map(
      (o) =>
        `${o.url} ${o.verb} ${o.inherited} ${o.pr?.state} ${o.pr?.review} ${o.pr?.title} ${o.pr?.stale}`,
    )
    .join("\n");
