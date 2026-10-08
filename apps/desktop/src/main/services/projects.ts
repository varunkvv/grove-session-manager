// the join: the sessions grove knows, where each runs and what the person dismissed, turned into
// what the page gets: the projects, the inbox and a project's sessions. also the session search,
// and the question and stopped diffs the notifications fire on.
import { statSync } from "node:fs";
import {
  buildInbox,
  type InboxRow,
  inboxOrder,
  type ProjectId,
  projectIdOf,
  type Runtime,
  runtimeOf,
  snippetAround,
  squash,
  tokenize,
} from "@grove/core";
import type { Author } from "@grove/record/types";
import { rowHaystack } from "../../shared/haystack.ts";
import type {
  InboxRowView,
  InboxView,
  LandingTarget,
  ProjectView,
  SessionHit,
  SessionRef,
  SessionRow,
} from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";
import type { ComboService } from "./combos.ts";
import type { Interruption } from "./interrupted.ts";
import type { LiveService } from "./live.ts";
import { openPlanOf } from "./openPlan.ts";
import type { ProjectRecordService } from "./projectRecord.ts";
import type { SessionService } from "./sessions.ts";

/** the person's dismissals: `<project id>/<key>` in reviewed.json (ReviewedService) */
export interface ReviewMarks {
  /** the marks under `<prefix>/`, with it taken off */
  keys(prefix: string): ReadonlySet<string>;
  set(keys: readonly string[], marked: boolean): Promise<void>;
}

export interface ProjectsOptions {
  combos: Pick<ComboService, "list" | "views" | "syncReport" | "problemMessage">;
  record: Pick<ProjectRecordService, "setProjects" | "snapshot">;
  sessions: Pick<SessionService, "list" | "get" | "search">;
  live: Pick<LiveService, "interruptions" | "holder" | "isAlive" | "markSeen">;
  reviewed: ReviewMarks;
  /** a row came, went or changed */
  onInbox?: (inbox: InboxView) => void;
  /** what a project's sessions list shows may have changed: the page asks again */
  onSessions?: () => void;
  /** an open question to the person appeared after its project's first read */
  onQuestion?: (q: {
    project: ProjectId;
    projectName: string;
    card: string;
    sessionId: string;
    text: string;
  }) => void;
  /** a session in a project stopped mid-turn after start() */
  onStopped?: (s: { sessionId: string; title?: string; project: ProjectId }) => void;
  debounceMs?: number;
}

interface Project {
  id: ProjectId;
  name: string;
  root: string;
  prefix: string;
  goal?: string;
}

interface Index {
  /** the newest row of each session id */
  rows: Map<string, SessionRow>;
  /** combo name -> project id */
  projectOf: Map<string, ProjectId>;
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
  /** open questions to the person, per project, from its first read on */
  private questions = new Map<ProjectId, Set<string>>();
  /** interrupted session ids. undefined until start() takes the baseline */
  private stopped?: Set<string>;

  constructor(o: ProjectsOptions) {
    this.o = o;
  }

  /**
   * the projects to the record service (the first reads and watchers), then a compute. call it
   * after live.start() resolved: the interruptions found until then are the stopped baseline, so a
   * reboot does not notify. call it again whenever the combo model changes.
   */
  start(): void {
    this.stopped ??= new Set(this.o.live.interruptions().keys());
    this.o.record.setProjects(this.list().projects.map((p) => ({ id: p.id, root: p.root })));
    this.schedule();
  }

  /** a session's row, its status or where it runs moved */
  sessionsChanged(): void {
    this.schedule();
  }

  /** ProjectRecordService's onChange. the question diff runs here, so the baseline is the first read */
  recordChanged(id: ProjectId): void {
    const snap = this.o.record.snapshot(id);
    const p = this.list().projects.find((x) => x.id === id);
    if (!snap || !p) return;
    const open = new Map<string, Author & { card: string; text: string }>();
    for (const c of snap.cards.values()) {
      if (c.status === "canceled") continue;
      for (const q of c.questions) if (q.open && q.to === "person") open.set(`${c.id}#${q.seq}`, q);
    }
    const before = this.questions.get(id);
    this.questions.set(id, new Set(open.keys()));
    if (!before) return;
    for (const [key, q] of open) {
      if (before.has(key)) continue;
      this.o.onQuestion?.({
        project: id,
        projectName: p.name,
        card: q.card,
        sessionId: q.session,
        text: q.text,
      });
    }
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
    return listed(row, false) ? { view: "sessions", project, session: sessionId } : undefined;
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
          prefix: p.prefix,
          workspaceFile: v.workspaceFile,
          longWork: v.longWork,
          folders: v.folders,
          status: v.status,
          checkedAt: v.checkedAt,
          rootExists: isDir(p.root),
          syncProblem: report?.warnings.map((w) => w.message).join(" ") || undefined,
        };
      }),
    };
  }

  inbox(): InboxView {
    if (this.timer || !this.computed) this.compute();
    return this.inboxView;
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

  /** the palette's session search */
  async findSessions(query: string): Promise<SessionHit[]> {
    const q = query.trim().slice(0, 500);
    const index = this.index(this.list().projects);
    const hit = (row: SessionRow, snippet?: string) => this.hit(row, index, snippet);
    const rows = this.o.sessions.list();
    if (!q)
      return [...rows]
        .sort(newest)
        .slice(0, 20)
        .map((r) => hit(r));
    const tokens = tokenize(q);
    // found by what was asked in it, not by its title: that prompt is why the row is there
    const why = (r: SessionRow) =>
      snippetAround(r.title ?? r.firstPrompt ?? "", tokens)
        ? undefined
        : (snippetAround(r.lastPrompt ?? "", tokens) ?? snippetAround(r.firstPrompt ?? "", tokens));
    const out = rows
      .filter((r) => tokens.every((t) => rowHaystack(r).includes(t)))
      .sort(newest)
      .slice(0, 50)
      .map((r) => hit(r, why(r)));
    if (out.length < 50) {
      // full text: only rows the line above did not already match
      for (const h of await this.o.sessions.search(q)) {
        const row = this.o.sessions.get(h.key);
        if (row) out.push(hit(row, h.snippet));
        if (out.length >= 50) break;
      }
    }
    return out;
  }

  /**
   * a project's sessions, newest first, every one of them: the ones started in its folder, and
   * the ones started in a subfolder or a working copy that need the person or are running now.
   *
   * a finished one in a subfolder is left to the palette. Open takes it to that folder's own
   * window, not the project's, and a project's `artifacts/` can hold hundreds of scripted runs
   */
  projectSessions(project: ProjectId): SessionHit[] {
    const { projects } = this.list();
    const p = projects.find((x) => x.id === project);
    if (!p) return [];
    const index = this.index(projects);
    const needs = new Set(this.inbox().rows.map((r) => r.sessionId));
    return [...index.rows.values()]
      .filter((r) => r.comboName === p.name && listed(r, needs.has(r.sessionId)))
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

  /** never waits on a project's record: the inbox is built from sessions alone */
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
    const inbox: InboxView = {
      rows: built.sort(inboxOrder).map(
        (r): InboxRowView => ({
          // a row is only ever built from an indexed session
          ...this.ref(index.rows.get(r.id)!, index),
          project: r.project,
          kind: r.kind,
          at: r.at,
          summary: r.summary,
          reviewKeys: r.reviewKeys,
        }),
      ),
    };
    const json = JSON.stringify(inbox);
    if (json !== this.inboxJson) {
      this.inboxJson = json;
      this.inboxView = inbox;
      this.o.onInbox?.(inbox);
    }
    // what a sessions list draws, without the activity time: that moves on every line an agent
    // writes, and the page asks again on its own clock for it
    const sessions = JSON.stringify(
      [...index.rows.values()]
        .filter((r) => projectOf(r, index))
        .map((r) => {
          const { activityMs: _, ...shown } = this.hit(r, index);
          return [shown, r.comboRelation];
        }),
    );
    if (sessions !== this.sessionsJson) {
      this.sessionsJson = sessions;
      this.o.onSessions?.();
    }
  }

  // --- the pieces -----------------------------------------------------------

  /** combos with a prefix, the first of any two whose roots share a basename */
  private list(): { projects: Project[]; problem?: string } {
    const projects: Project[] = [];
    const problems: string[] = [];
    const combos = this.o.combos.problemMessage();
    if (combos) problems.push(combos);
    for (const c of this.o.combos.list()) {
      // ponytail: a combo assignPrefixes could not name (a hundred sharing four letters) is left out
      if (!c.prefix) continue;
      const id = projectIdOf(c);
      const first = projects.find((p) => p.id === id);
      if (first) {
        problems.push(
          `Two combos have folders called "${id}". Only "${first.name}" is shown. Move one of them.`,
        );
        continue;
      }
      projects.push({ id, name: c.name, root: c.root, prefix: c.prefix, goal: c.note });
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
      active: new Map(),
    };
    for (const r of rows.values()) {
      const id = r.live || r.interrupted ? projectOf(r, index) : undefined;
      if (id) index.active.set(id, [...(index.active.get(id) ?? []), r]);
    }
    return index;
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
      open: openPlanOf(runtime, row),
    };
  }

  private hit(row: SessionRow, index: Index, snippet?: string): SessionHit {
    const prompts = new Set([row.firstPrompt, row.lastPrompt].flatMap((p) => p ?? []));
    return {
      ...this.ref(row, index),
      project: projectOf(row, index),
      activityMs: row.activityMs,
      live: row.live?.state,
      prompt: [...prompts].map((p) => squash(p, 160)).join("\n") || undefined,
      snippet,
    };
  }

  /** where a session's process is right now. openSession asks again at call time */
  runtimeFor(id: string, row?: SessionRow): Runtime {
    return runtimeOf({
      held: row?.background?.held,
      holder: this.o.live.holder(id),
      alive: this.o.live.isAlive(id),
    });
  }
}

const projectOf = (row: SessionRow, index: Index): ProjectId | undefined =>
  row.comboName ? index.projectOf.get(row.comboName) : undefined;

/** whether a project's sessions list holds this one of its sessions */
const listed = (row: SessionRow, needsYou: boolean): boolean =>
  row.comboRelation === "root" || needsYou || row.live?.state === "running";
