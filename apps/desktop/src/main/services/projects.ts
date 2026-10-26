// the join: the sessions grove knows, where each runs and what the person dismissed, turned into
// what the page gets: the projects, the inbox and a project's sessions. also the session search,
// and the stopped diff its notification fires on.
import { statSync } from "node:fs";
import {
  buildInbox,
  type InboxRow,
  inboxOrder,
  liveTasks,
  type ProjectId,
  projectIdOf,
  type Runtime,
  recapLine,
  runtimeOf,
  type SessionTask,
  snippetAround,
  squash,
  tokenize,
} from "@grove/core";
import { rowHaystack } from "../../shared/haystack.ts";
import type {
  InboxRowView,
  InboxView,
  LandingTarget,
  ProjectView,
  SessionHit,
  SessionRef,
  SessionRow,
  TaskView,
} from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";
import { working } from "../keepAwake.ts";
import type { ChatHost } from "./chat.ts";
import type { ComboService } from "./combos.ts";
import type { Interruption } from "./interrupted.ts";
import type { LiveService } from "./live.ts";
import { openPlanOf } from "./openPlan.ts";
import type { RecapService } from "./recaps.ts";
import type { SessionService } from "./sessions.ts";
import { RECENT_MS, type TitleService } from "./titles.ts";

/** the person's dismissals: `<project id>/<key>` in reviewed.json (ReviewedService) */
export interface ReviewMarks {
  /** the marks under `<prefix>/`, with it taken off */
  keys(prefix: string): ReadonlySet<string>;
  set(keys: readonly string[], marked: boolean): Promise<void>;
}

export interface ProjectsOptions {
  combos: Pick<ComboService, "list" | "views" | "syncReport" | "problemMessage">;
  sessions: Pick<SessionService, "list" | "get" | "search">;
  live: Pick<LiveService, "interruptions" | "holder" | "isAlive" | "markSeen" | "taskLine">;
  reviewed: ReviewMarks;
  /** each session's recap, and where to ask for one */
  recaps?: Pick<RecapService, "view" | "want">;
  /** where to ask for a session's title and description. they come back on its row */
  titles?: Pick<TitleService, "want">;
  /** grove chat's host: the sessions grove runs itself, known by id before any registry is read */
  chat?: Pick<ChatHost, "hosts" | "running">;
  /** a row came, went or changed */
  onInbox?: (inbox: InboxView) => void;
  /** what a project's sessions list shows may have changed: the page asks again */
  onSessions?: () => void;
  /** a session in a project stopped mid-turn after start() */
  onStopped?: (s: { sessionId: string; title?: string; project: ProjectId }) => void;
  debounceMs?: number;
}

interface Project {
  id: ProjectId;
  name: string;
  root: string;
  goal?: string;
  /** put away. still a project in everything here but what the home screen lists */
  archived?: boolean;
}

interface Index {
  /** the newest row of each session id */
  rows: Map<string, SessionRow>;
  /** combo name -> project id */
  projectOf: Map<string, ProjectId>;
  /** the combo names of the archived projects */
  archived: Set<string>;
  /** by project: the sessions in it that are live or were interrupted. the others make no row */
  active: Map<ProjectId, SessionRow[]>;
}

const REVIEW_KEY = /^(stopped:[A-Za-z0-9-]{1,64}@(\d{1,16}|failed)|seen:[A-Za-z0-9-]{1,64})$/;

const newest = (a: SessionRow, b: SessionRow) => b.activityMs - a.activityMs;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class ProjectsService {
  private readonly o: ProjectsOptions;
  private timer?: NodeJS.Timeout;
  private computed = false;
  private inboxView: InboxView = { rows: [] };
  private inboxJson = "";
  /** what the sessions lists were last built from, less what moves on every tool call */
  private sessionsJson = "";
  /** interrupted session ids. undefined until start() takes the baseline */
  private stopped?: Set<string>;
  /** the inbox rows of the last compute, as `id:kind:at`. undefined until the first one */
  private entered?: Set<string>;

  constructor(o: ProjectsOptions) {
    this.o = o;
  }

  /**
   * call it after live.start() resolved: the interruptions found until then are the stopped
   * baseline, so a reboot does not notify. call it again whenever the combo model changes.
   */
  start(): void {
    this.stopped ??= new Set(this.o.live.interruptions().keys());
    this.schedule();
  }

  /** a session's row, its status or where it runs moved */
  sessionsChanged(): void {
    this.schedule();
  }

  /** recaps were switched on or off: every row is looked at again */
  recapsSwitched(): void {
    this.entered = undefined;
    this.schedule();
  }

  /** LiveService's onInterrupted. it is called on every change with the same map, so the keys are copied */
  interruptedChanged(m: ReadonlyMap<string, Interruption>): void {
    this.schedule();
    const before = this.stopped;
    if (!before) return;
    this.stopped = new Set(m.keys());
    const fresh = [...this.stopped].filter((id) => !before.has(id));
    if (!fresh.length) return;
    const index = this.index(this.list().projects);
    for (const sessionId of fresh) {
      const row = index.rows.get(sessionId);
      const project = row && projectOf(row, index);
      if (project) this.o.onStopped?.({ sessionId, title: row.title, project });
    }
  }

  /** one session as the lists have it, whether a list shows it or not: what a chat window names */
  hitFor(sessionId: string): SessionHit | undefined {
    const index = this.index(this.list().projects);
    const row = index.rows.get(sessionId);
    return row && this.hit(row, index);
  }

  /** the project a session's folder is in */
  projectOf(sessionId: string): ProjectId | undefined {
    const index = this.index(this.list().projects);
    const row = index.rows.get(sessionId);
    return row && projectOf(row, index);
  }

  /**
   * where a click on a notification about this session lands: its inbox row when it has one, else
   * its row in its project's sessions. undefined for a session grove lists nowhere, which opens in
   * the editor
   */
  landing(sessionId: string): LandingTarget | undefined {
    const index = this.index(this.list().projects);
    const row = index.rows.get(sessionId);
    const project = row && projectOf(row, index);
    if (!row || !project) return undefined;
    if (this.inbox().rows.some((r) => r.sessionId === sessionId)) {
      return { view: "inbox", session: sessionId };
    }
    return listed(row, false, true) ? { view: "sessions", project, session: sessionId } : undefined;
  }

  views(): { projects: ProjectView[]; problem?: string } {
    const { projects, problem } = this.list();
    const combos = new Map(this.o.combos.views().map((v) => [v.name, v]));
    return {
      problem,
      projects: projects.map((p) => {
        // both come from the same combo list
        const v = combos.get(p.name)!;
        const report = this.o.combos.syncReport(p.root);
        return {
          id: p.id,
          name: p.name,
          root: p.root,
          goal: p.goal,
          workspaceFile: v.workspaceFile,
          longWork: v.longWork,
          ...(v.model ? { model: v.model } : {}),
          ...(v.effort ? { effort: v.effort } : {}),
          folders: v.folders,
          status: v.status,
          checkedAt: v.checkedAt,
          rootExists: isDir(p.root),
          syncProblem: report?.warnings.map((w) => w.message).join(" ") || undefined,
          ...(p.archived ? { archived: true } : {}),
        };
      }),
    };
  }

  inbox(): InboxView {
    if (this.timer || !this.computed) this.compute();
    return this.inboxView;
  }

  /**
   * rows came into sight: a session older than a week is named now. the ones from the last week
   * are named without being asked
   */
  nameSessions(keys: readonly unknown[]): void {
    const index = this.index(this.list().projects);
    for (const key of keys.slice(0, 200)) {
      const row = typeof key === "string" ? this.o.sessions.get(key) : undefined;
      if (row) void this.o.titles?.want(row, () => siblings(row, index));
    }
  }

  /** Dismiss: a stop is marked in reviewed.json, a status that needs the person is marked seen */
  async review(project: ProjectId, keys: readonly string[], reviewed: boolean): Promise<void> {
    if (
      !Array.isArray(keys) ||
      keys.length > 2000 ||
      !keys.every((k) => typeof k === "string" && REVIEW_KEY.test(k))
    ) {
      throw new AppError("invalid", "Nothing to dismiss: those are not a row's keys.");
    }
    const p = this.list().projects.find((x) => x.id === project);
    if (!p) throw new AppError("no-project", `There is no project called "${project}".`);
    const on = reviewed === true;
    const marks = keys.filter((k) => k.startsWith("stopped:")).map((k) => `${p.id}/${k}`);
    if (marks.length) await this.o.reviewed.set(marks, on);
    // looking at a session is not a decision: nothing is stored, and its next event shows again
    if (on) {
      this.o.live.markSeen(keys.filter((k) => k.startsWith("seen:")).map((k) => k.slice(5)));
    }
    this.compute();
  }

  /**
   * the session search: by a session's own fields, then by what was said in it. with no scope it
   * is the palette's, over every session grove knows, 50 of them. with one it is a screen's: the
   * sessions `listSessions` gives that screen and no other, up to 200, so every hit is a row it has
   */
  async findSessions(query: string, scope?: ProjectId | null): Promise<SessionHit[]> {
    const q = query.trim().slice(0, 500);
    const index = this.index(this.list().projects);
    const hit = (row: SessionRow, snippet?: string) => this.hit(row, index, snippet);
    const screen = scope !== undefined;
    const rows = screen ? this.scoped(scope, index) : this.o.sessions.list();
    const max = screen ? 200 : 50;
    if (!q)
      return screen
        ? []
        : [...rows]
            .sort(newest)
            .slice(0, 20)
            .map((r) => hit(r));
    const tokens = tokenize(q);
    // on a project's screen its name and its folder find nothing: every row there has them
    const fields =
      typeof scope === "string"
        ? (r: SessionRow) => rowHaystack({ ...r, comboName: undefined, cwdBase: undefined })
        : rowHaystack;
    // found by what was asked in it, not by its title or what it is for: that prompt is why the
    // row is there. on the home screen one found by its branch says the branch: a row there shows
    // it nowhere else
    const why = (r: SessionRow) =>
      snippetAround(r.title ?? r.firstPrompt ?? "", tokens) ||
      snippetAround(r.description ?? "", tokens)
        ? undefined
        : (snippetAround(r.lastPrompt ?? "", tokens) ??
          snippetAround(r.firstPrompt ?? "", tokens) ??
          (scope === null ? snippetAround(r.gitBranch ?? "", tokens) : undefined));
    const out = rows
      .filter((r) => tokens.every((t) => fields(r).includes(t)))
      .sort(newest)
      .slice(0, max)
      .map((r) => hit(r, why(r)));
    if (out.length < max) {
      const mine = new Set(rows.map((r) => r.key));
      // full text: only rows the line above did not already match
      for (const h of await this.o.sessions.search(q, fields)) {
        const row = this.o.sessions.get(h.key);
        if (row && (!screen || mine.has(row.key))) out.push(hit(row, h.snippet));
        if (out.length >= max) break;
      }
    }
    return out;
  }

  /**
   * the sessions a screen lists, newest first, every one of them. a project's: the ones started in
   * its folder, and the ones started in a subfolder or a working copy that need the person or are
   * running now. with null every project's, and the ones in no project that a person started. an
   * archived project's are in that one only while they need the person or run.
   *
   * a finished one in a subfolder is left to the palette. Open takes it to that folder's own
   * window, not the project's, and a project's `artifacts/` can hold hundreds of scripted runs
   */
  listSessions(scope: ProjectId | null): SessionHit[] {
    const index = this.index(this.list().projects);
    return this.scoped(scope, index)
      .sort(newest)
      .map((r) => this.hit(r, index));
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  // --- the compute ----------------------------------------------------------

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.compute(), this.o.debounceMs ?? 100);
  }

  private compute(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.computed = true;
    const { projects } = this.list();
    const index = this.index(projects);
    const built: InboxRow[] = [];
    for (const p of projects) {
      const sessions = index.active.get(p.id);
      if (!sessions) continue;
      built.push(...buildInbox({ project: p.id, sessions, reviewed: this.o.reviewed.keys(p.id) }));
    }
    const before = this.entered;
    const entered = new Set<string>();
    const inbox: InboxView = {
      rows: built.sort(inboxOrder).map((r): InboxRowView => {
        // a row is only ever built from an indexed session
        const row = index.rows.get(r.id)!;
        // a permission prompt is answered from its row, which says the tool and what it would act
        // on, and a turn raises many of them: its recap waits for its panel to open
        const told = r.kind !== "permission";
        const entry = `${r.id}:${r.kind}:${r.at}`;
        entered.add(entry);
        // it just started needing the person: a recap is written, so it is there when they look.
        // what was already in the inbox when grove started is only looked at
        if (told && !before?.has(entry)) void this.o.recaps?.want(row, { moved: !!before });
        const ref = this.ref(row, index);
        const recap = told && !ref.recap?.old ? ref.recap?.lines : undefined;
        return {
          ...ref,
          project: r.project,
          kind: r.kind,
          at: r.at,
          summary: recap ? recapLine(recap) : r.summary,
          reviewKeys: r.reviewKeys,
        };
      }),
    };
    this.entered = entered;
    const json = JSON.stringify(inbox);
    if (json !== this.inboxJson) {
      this.inboxJson = json;
      this.inboxView = inbox;
      this.o.onInbox?.(inbox);
    }
    // what the sessions lists draw, without the activity time: that moves on every line an agent
    // writes, and the page asks again on its own clock for it. every project's list is in this
    // one, an archived project's quiet rows too: its own screen still draws them. then which of
    // them the home screen has
    const listed = this.scoped(null, index, true);
    const sessions = JSON.stringify([
      listed.map((r) => {
        const { activityMs: _, ...shown } = this.hit(r, index);
        return shown;
      }),
      this.scoped(null, index).map((r) => r.sessionId),
    ]);
    if (sessions !== this.sessionsJson) {
      this.sessionsJson = sessions;
      this.o.onSessions?.();
    }
    // names: what a list holds from the last week, and what is still open. a look is cheap for a
    // session that has not moved, and waits for the Stop of one that is in a turn. not before
    // start(): until then no session is known to be in a turn
    const now = Date.now();
    for (const r of this.stopped ? listed : []) {
      if (now - r.activityMs < RECENT_MS || this.o.live.isAlive(r.sessionId)) {
        void this.o.titles?.want(r, () => siblings(r, index));
      }
    }
  }

  // --- the pieces -----------------------------------------------------------

  /** every combo, the first of any two whose roots share a basename */
  private list(): { projects: Project[]; problem?: string } {
    const projects: Project[] = [];
    const problems: string[] = [];
    const combos = this.o.combos.problemMessage();
    if (combos) problems.push(combos);
    for (const c of this.o.combos.list()) {
      const id = projectIdOf(c);
      const first = projects.find((p) => p.id === id);
      if (first) {
        problems.push(
          `Two combos have folders called "${id}". Only "${first.name}" is shown. Move one of them.`,
        );
        continue;
      }
      projects.push({ id, name: c.name, root: c.root, goal: c.note, archived: c.archived });
    }
    return { projects, problem: problems.join(" ") || undefined };
  }

  private index(projects: readonly Project[]): Index {
    const rows = new Map<string, SessionRow>();
    for (const r of this.o.sessions.list()) {
      const had = rows.get(r.sessionId);
      if (!had || r.activityMs > had.activityMs) rows.set(r.sessionId, r);
    }
    const index: Index = {
      rows,
      projectOf: new Map(projects.map((p) => [p.name, p.id])),
      archived: new Set(projects.filter((p) => p.archived).map((p) => p.name)),
      active: new Map(),
    };
    for (const r of rows.values()) {
      const id = r.live || r.interrupted ? projectOf(r, index) : undefined;
      if (id) index.active.set(id, [...(index.active.get(id) ?? []), r]);
    }
    return index;
  }

  /**
   * the rows `listSessions` is made of. no project by that id has none. with null an archived
   * project's quiet sessions are left out, unless `putAway` asks for them too
   */
  private scoped(scope: ProjectId | null, index: Index, putAway = false): SessionRow[] {
    const name =
      scope === null ? undefined : this.list().projects.find((p) => p.id === scope)?.name;
    if (scope !== null && !name) return [];
    const needs = new Set(this.inbox().rows.map((r) => r.sessionId));
    // archiving is about noise, never about muting: one that needs the person, runs or has left
    // something running still shows
    const quiet = (r: SessionRow) =>
      !needs.has(r.sessionId) && !working(r.live, Date.now()) && !watching(r);
    const hidden = (r: SessionRow) =>
      scope === null && !putAway && index.archived.has(r.comboName ?? "") && quiet(r);
    return [...index.rows.values()].filter(
      (r) =>
        (scope === null || r.comboName === name) &&
        listed(r, needs.has(r.sessionId), !!projectOf(r, index)) &&
        !hidden(r),
    );
  }

  /** a session as every list names it: where it is and how it opens */
  private ref(row: SessionRow, index: Index): SessionRef {
    const runtime = this.runtimeFor(row.sessionId, row);
    return {
      key: row.key,
      sessionId: row.sessionId,
      title: row.title ?? (row.firstPrompt ? squash(row.firstPrompt, 120) : "Untitled session"),
      where: (projectOf(row, index) && row.comboName) || row.projectLabel,
      runtime,
      branch: row.gitBranch,
      open: openPlanOf(runtime, row, this.o.chat?.running(row.sessionId)),
      recap: this.o.recaps?.view(row.key),
      ...(row.description ? { description: row.description } : {}),
      ...(row.prs ? { prs: row.prs } : {}),
    };
  }

  private hit(row: SessionRow, index: Index, snippet?: string): SessionHit {
    const prompts = new Set([row.firstPrompt, row.lastPrompt].flatMap((p) => p ?? []));
    // the hooks name no tool for a running session: what it was last asked is what it is doing.
    // working as the menu bar has it: a turn over with its agents still at work counts
    const running = working(row.live, Date.now()) ? row.live : undefined;
    const asked = row.lastPrompt ?? row.firstPrompt;
    const tasks = liveTasks(row.tasks, Date.now()).map((t) =>
      taskView(t, this.o.live.taskLine(t.id)),
    );
    return {
      ...this.ref(row, index),
      project: projectOf(row, index),
      activityMs: row.activityMs,
      live: running ? "running" : row.live?.state,
      prompt: [...prompts].map((p) => squash(p, 160)).join("\n") || undefined,
      doing: running && asked ? squash(asked, 200) : undefined,
      // a status the process registry gave has no turn: it has been busy since `at`
      since: running && (running.turnStart ?? running.at),
      tasks: tasks.length ? tasks : undefined,
      snippet,
    };
  }

  /**
   * where a session's process is right now. openSession asks again at call time. grove's own come
   * first: claude's registry calls them sdk apps, which is everyone's
   */
  runtimeFor(id: string, row?: SessionRow): Runtime {
    if (this.o.chat?.hosts(id)) return "grove";
    return runtimeOf({
      held: row?.background?.held,
      holder: this.o.live.holder(id),
      alive: this.o.live.isAlive(id),
    });
  }
}

const projectOf = (row: SessionRow, index: Index): ProjectId | undefined =>
  row.comboName ? index.projectOf.get(row.comboName) : undefined;

/**
 * what the other sessions where this one runs are called, the last week's: a new title must not
 * be one of them. where is its project, or its folder when it is in none
 */
function siblings(row: SessionRow, index: Index): string[] {
  const now = Date.now();
  const here = (r: SessionRow) =>
    row.comboName ? r.comboName === row.comboName : !r.comboName && r.cwd === row.cwd;
  return [...index.rows.values()]
    .filter(
      (r) => r.sessionId !== row.sessionId && now - r.activityMs < RECENT_MS && r.title && here(r),
    )
    .sort(newest)
    .map((r) => r.title ?? "");
}

/** it left something running that counts by now: a wake-up, or a command a minute old */
const watching = (row: SessionRow): boolean => liveTasks(row.tasks, Date.now()).length > 0;

/**
 * whether a list holds this session. always while it needs the person, runs or has left something
 * running. after that, one in a project when it was started in the project's folder, and one in no
 * project when a person started it: `claude -p` and SDK apps (`sdk-cli`, `sdk-ts`) are scripts,
 * and 28 of the 72 sessions outside a project on the machine this was measured on
 */
const listed = (row: SessionRow, needsYou: boolean, inProject: boolean): boolean =>
  needsYou ||
  working(row.live, Date.now()) ||
  watching(row) ||
  (inProject ? row.comboRelation === "root" : !row.entrypoint?.startsWith("sdk"));

/** what /loop schedules its next wake-up with when it paces itself: a marker, not words */
const LOOP = /^<<autonomous-loop(-dynamic)?>>$/;
const NUMBER = /^\d{1,2}$/;

/**
 * a task as a row draws it. a command's status is the last line it wrote, when its output was
 * found. a wake-up's says when: one that fires once, at an hour and a minute that are plain
 * numbers, is `wakes at 14:07` (Claude Code writes them in local time), and any other is its cron
 * as written. no cron is worked out here
 */
export function taskView(t: SessionTask, line?: string): TaskView {
  const view = (description: string, status?: string): TaskView => ({
    id: t.id,
    kind: t.kind,
    description,
    since: t.since,
    ...(status ? { status } : {}),
  });
  if (t.kind === "command") return view(squash(t.description, 200), line);
  const [minute = "", hour = ""] = t.schedule?.split(/\s+/) ?? [];
  const when =
    !t.recurring && NUMBER.test(minute) && NUMBER.test(hour)
      ? `wakes at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
      : t.schedule && (t.recurring ? `repeats · ${t.schedule}` : t.schedule);
  const prompt = squash(t.description, 200);
  return view(LOOP.test(prompt) ? "Autonomous loop" : prompt || "Scheduled wake-up", when);
}
