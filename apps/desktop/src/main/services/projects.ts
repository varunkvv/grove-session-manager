// the join (app.md 3.4, 3.5): each project's record, the sessions grove knows and the person's
// review marks, turned into what the page gets. also the pending starts, the review keys, the
// session search, and the question and stopped diffs the notifications fire on.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import {
  type AgentRef,
  type AgentState,
  agentRef,
  agentState,
  buildInbox,
  cardDisplayStatus,
  type InboxRow,
  inboxOrder,
  modelLabel,
  type ProjectId,
  projectIdOf,
  type Runtime,
  runtimeOf,
  type SessionFacts,
  squash,
  tokenize,
  trayCount,
} from "@grove/core";
import { callAsPerson, readCard } from "@grove/record";
import type { Author, Card, Conclusion } from "@grove/record/types";
import { rowHaystack } from "../../shared/haystack.ts";
import type {
  AgentPanel,
  ArtifactView,
  CardHead,
  CardView,
  ConclusionView,
  InboxRowView,
  InboxView,
  LandingTarget,
  PendingStart,
  ProjectRecordView,
  ProjectView,
  RecordProblem,
  ServerCheck,
  SessionHit,
  SessionRow,
  ThreadItem,
} from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";
import { diffRows } from "../patchCoalescer.ts";
import type { ComboService } from "./combos.ts";
import type { Interruption } from "./interrupted.ts";
import type { LiveService } from "./live.ts";
import { openPlanOf } from "./openPlan.ts";
import type { ProjectRecordService } from "./projectRecord.ts";
import type { SessionService } from "./sessions.ts";
import type { StartCard } from "./startAgent.ts";

/** the person's review marks: `<PREFIX>/<key>` in reviewed.json (ReviewedService) */
export interface ReviewMarks {
  /** the marks under `<prefix>/`, with it taken off */
  keys(prefix: string): ReadonlySet<string>;
  set(keys: readonly string[], marked: boolean): Promise<void>;
}

/** what the page has to be told about one project's record. the pusher stamps the rev */
export interface RecordPatch {
  /** only the heads that changed, or every head with `replace` */
  cards?: CardHead[];
  removedCards?: string[];
  replace?: boolean;
  /** the whole list */
  conclusions?: ConclusionView[];
  problems?: RecordProblem[];
  readAt?: number;
}

export interface ProjectsOptions {
  combos: Pick<ComboService, "list" | "views" | "syncReport" | "problemMessage">;
  /** the self-check's last result for a root */
  server: (root: string) => ServerCheck | undefined;
  record: Pick<ProjectRecordService, "setProjects" | "snapshot" | "check">;
  sessions: Pick<SessionService, "list" | "get" | "search">;
  live: Pick<LiveService, "list" | "interruptions" | "holder" | "isAlive" | "markSeen">;
  reviewed: ReviewMarks;
  onRecord?: (project: ProjectId, patch: RecordPatch) => void;
  /** a row or the tray count changed */
  onInbox?: (inbox: InboxView) => void;
  /** a pending start came or went */
  onProjects?: () => void;
  /** an open question to the person appeared after its project's first read */
  onQuestion?: (q: {
    project: ProjectId;
    projectName: string;
    card: string;
    sessionId: string;
    text: string;
  }) => void;
  /** a session in a project, or holding one of its cards, stopped mid-turn after start() */
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
  active: Map<ProjectId, string[]>;
}

/** a start nobody claimed from by then is dropped: a VS Code prompt never sent never claims */
export const START_TTL_MS = 30 * 60_000;
const ANSWER = "answered in the agent's chat";
const REVIEW_KEY =
  /^(conclusion:[DFV]-[1-9]\d*|card:[A-Z][A-Z0-9]{0,7}-[1-9]\d*|(finished|question):[A-Z][A-Z0-9]{0,7}-[1-9]\d*#[1-9]\d*|stopped:[A-Za-z0-9-]{1,64}@(\d{1,16}|failed)|seen:[A-Za-z0-9-]{1,64})$/;

const ms = (iso: string) => Date.parse(iso);

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function problemCount(c: Card): number {
  let n = c.problems.length;
  for (const x of [...c.comments, ...c.claims]) n += x.problems.length;
  return n;
}

/** a claim or a takeover since the start was asked for */
function claimedSince(cards: readonly Card[], s: PendingStart): boolean {
  const claimed = (c: Card) =>
    c.claims.some((e) => (e.event === "claim" || e.event === "takeover") && ms(e.at) >= s.at);
  if (s.cardId) return cards.some((c) => c.id === s.cardId && claimed(c));
  return cards.some((c) => ms(c.at) >= s.at || claimed(c));
}

export class ProjectsService {
  private readonly o: ProjectsOptions;
  private timer?: NodeJS.Timeout;
  private computed = false;
  /** when each agent's state last changed. LiveStatus.at moves on every tool call, so it is not "since" */
  private stateSince = new Map<string, { state: AgentState; at?: number }>();
  private pending = new Map<ProjectId, PendingStart[]>();
  /** what the page was last sent, per project */
  private sent = new Map<
    ProjectId,
    { view: ProjectRecordView; heads: Map<string, CardHead>; conclusions: string; problems: string }
  >();
  private inboxView: InboxView = { rows: [], tray: 0 };
  private inboxJson = "";
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

  sessionsChanged(): void {
    this.schedule();
  }

  /** ProjectRecordService's onChange. the question diff runs here, so the baseline is the first read */
  recordChanged(id: ProjectId): void {
    this.schedule();
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
    const { projects } = this.list();
    const index = this.index(projects);
    for (const sessionId of fresh) {
      const row = index.rows.get(sessionId);
      const project =
        this.heldBy(sessionId, projects)?.project ??
        (row?.comboName ? index.projectOf.get(row.comboName) : undefined);
      if (project) this.o.onStopped?.({ sessionId, title: row?.title, project });
    }
  }

  /** where a click on a notification about this session lands (app.md 5.1). undefined: open it in the editor */
  landing(sessionId: string, row: "asked" | "stopped"): LandingTarget | undefined {
    const { projects } = this.list();
    const held = this.heldBy(sessionId, projects);
    if (held) return { view: "card", project: held.project, cardId: held.card.id, back: "inbox" };
    const comboName = this.index(projects).rows.get(sessionId)?.comboName;
    const project = projects.find((p) => p.name === comboName)?.id;
    if (!project) return undefined;
    const rowId = row === "stopped" ? `stopped:${sessionId}` : `asked:session:${sessionId}`;
    return { view: "inbox", project, rowId };
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
          server: this.o.server(p.root) ?? { state: "unknown" },
          shadowed: report?.shadowed ?? [],
          syncProblem: report?.warnings.map((w) => w.message).join(" ") || undefined,
          starting: this.pending.get(p.id) ?? [],
        };
      }),
    };
  }

  recordViews(): Record<ProjectId, ProjectRecordView> {
    this.ensure();
    const out: Record<ProjectId, ProjectRecordView> = {};
    for (const p of this.list().projects) {
      out[p.id] = this.sent.get(p.id)?.view ?? { cards: [], conclusions: [], problems: [] };
    }
    return out;
  }

  inbox(): InboxView {
    this.ensure();
    return this.inboxView;
  }

  card(project: ProjectId, cardId: string): CardView | null {
    const { projects } = this.list();
    const p = projects.find((x) => x.id === project);
    const snap = p && this.o.record.snapshot(p.id);
    const c = snap?.cards.get(cardId.toUpperCase());
    if (!p || !snap || !c) return null;
    const index = this.index(projects);
    const head = this.head(
      c,
      c.holder ? this.facts(c.holder.session, index) : undefined,
      index,
      snap.conclusions,
    );
    const marks = this.o.reviewed.keys(p.prefix);
    const who = (x: Author): AgentRef | "person" =>
      x.by === "person" ? "person" : refOf(x, index);
    const thread: ThreadItem[] = [
      ...c.comments.map((x) => {
        const q = c.questions.find((y) => y.seq === x.seq);
        return {
          kind: x.kind,
          seq: x.seq,
          at: ms(x.at),
          who: who(x),
          text: x.text,
          to: q?.to ?? x.to,
          open: q?.open,
          answeredBy: q?.answeredBy,
          answers: x.answers,
          artifacts: x.artifacts.map((a) => ({ ...a, at: ms(x.at), who: who(x) })),
        };
      }),
      ...c.claims.map((e) => ({
        kind: "event" as const,
        seq: e.seq,
        at: ms(e.at),
        who: who(e),
        event: e.event,
        text: e.body,
      })),
    ].sort(
      (a, b) =>
        a.at - b.at || Number(b.kind === "event") - Number(a.kind === "event") || a.seq - b.seq,
    );
    const artifacts: ArtifactView[] = [];
    const seen = new Set<string>();
    for (const x of [...c.comments, ...c.claims].sort((a, b) => ms(b.at) - ms(a.at))) {
      for (const a of x.artifacts) {
        if (seen.has(`${a.type} ${a.ref}`)) continue;
        seen.add(`${a.type} ${a.ref}`);
        artifacts.push({ type: a.type, ref: a.ref, at: ms(x.at), who: who(x) });
      }
    }
    // the holder, else whoever wrote the last claim event as an agent: a done card still shows who did it
    const last = c.claims.findLast((e) => e.by === "agent");
    const agent = c.holder
      ? this.panel(c.holder.session, c.holder.agent, true, index)
      : last && this.panel(last.session, last.agent, false, index);
    const dir = path.join("cards", c.id) + path.sep;
    return {
      project: p.id,
      id: c.id,
      title: c.title,
      body: c.body,
      status: head.status,
      recordStatus: c.status,
      agent,
      thread,
      artifacts,
      from: c.from,
      needs: c.needs,
      conclusions: snap.conclusions
        .filter((x) => x.card === c.id)
        .map((x) => this.conclusionView(x, snap.cards, marks, index)),
      problems: snap.problems.filter((x) => x.file.startsWith(dir)),
      version: head.version,
    };
  }

  /** a card as startPrompt wants it: its holder joined with where it runs (app.md 5.4) */
  startCard(project: ProjectId, cardId: string): StartCard | undefined {
    const c = this.o.record.snapshot(project)?.cards.get(cardId);
    if (!c) return undefined;
    const index = this.index(this.list().projects);
    const f = c.holder && this.facts(c.holder.session, index);
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      ...(c.holder && f
        ? {
            holder: {
              name: refOf({ session: c.holder.session, agent: c.holder.agent }, index).name,
              runtime: f.runtime,
              interrupted: !!f.interrupted,
            },
          }
        : {}),
    };
  }

  /** an agent grove started that has not claimed anything yet (app.md 5.4) */
  addStart(project: ProjectId, where: PendingStart["where"], cardId?: string): PendingStart {
    const s: PendingStart = {
      id: randomUUID(),
      where,
      at: Date.now(),
      ...(cardId ? { cardId } : {}),
    };
    this.pending.set(project, [...(this.pending.get(project) ?? []), s]);
    setTimeout(() => this.schedule(), START_TTL_MS + 1000).unref();
    this.o.onProjects?.();
    return s;
  }

  /** app.md 3.3: a mark, a seen session, or an open question answered as the person */
  async review(project: ProjectId, keys: readonly string[], reviewed: boolean): Promise<void> {
    if (
      !Array.isArray(keys) ||
      keys.length > 2000 ||
      !keys.every((k) => typeof k === "string" && REVIEW_KEY.test(k))
    ) {
      throw new AppError("invalid", "Nothing to review: those are not review keys.");
    }
    const p = this.list().projects.find((x) => x.id === project);
    if (!p) throw new AppError("no-project", `There is no project called "${project}".`);
    const on = reviewed === true;
    const marks: string[] = [];
    const seen: string[] = [];
    const questions: Array<[string, number]> = [];
    for (const k of keys) {
      const rest = k.slice(k.indexOf(":") + 1);
      if (k.startsWith("seen:")) seen.push(rest);
      else if (k.startsWith("question:")) {
        const [card = "", seq = ""] = rest.split("#");
        questions.push([card, Number(seq)]);
      } else marks.push(`${p.prefix}/${k}`);
    }
    if (marks.length) await this.o.reviewed.set(marks, on);
    let failed: AppError | undefined;
    if (on) {
      if (seen.length) this.o.live.markSeen(seen);
      for (const [card, question] of questions) {
        // the record takes a second answer to an answered question without complaint, so look first
        const q = readCard(p.root, card)?.questions.find((x) => x.seq === question);
        if (q && !q.open) continue;
        const r = callAsPerson(p.root, "question_answer", {
          card,
          question,
          text: ANSWER,
          by: "person",
        });
        if (!r.ok) failed ??= new AppError(r.code ?? "record", r.text);
      }
      // read the answers now rather than when the watch fires, so the row goes with this compute
      if (questions.length) this.o.record.check(p.id);
    }
    this.compute();
    if (failed) throw failed;
  }

  /** the palette's session search (app.md 3.7) */
  async findSessions(query: string): Promise<SessionHit[]> {
    const q = query.trim().slice(0, 500);
    const index = this.index(this.list().projects);
    const hit = (row: SessionRow, snippet?: string): SessionHit => {
      const project = row.comboName ? index.projectOf.get(row.comboName) : undefined;
      const runtime = this.runtimeFor(row.sessionId, row);
      return {
        key: row.key,
        sessionId: row.sessionId,
        title: row.title ?? (row.firstPrompt ? squash(row.firstPrompt, 120) : "Untitled session"),
        project,
        where: project ? (row.comboName ?? row.projectLabel) : row.projectLabel,
        activityMs: row.activityMs,
        runtime,
        live: row.live?.state,
        snippet,
        open: openPlanOf(runtime, row),
      };
    };
    const rows = this.o.sessions.list();
    const newest = (a: SessionRow, b: SessionRow) => b.activityMs - a.activityMs;
    if (!q)
      return [...rows]
        .sort(newest)
        .slice(0, 20)
        .map((r) => hit(r));
    const tokens = tokenize(q);
    const out = rows
      .filter((r) => tokens.every((t) => rowHaystack(r).includes(t)))
      .sort(newest)
      .slice(0, 50)
      .map((r) => hit(r));
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

  dispose(): void {
    clearTimeout(this.timer);
  }

  // --- the compute ----------------------------------------------------------

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.compute(), this.o.debounceMs ?? 100);
  }

  /** a getter wants it now: run a pending compute instead of waiting for it */
  private ensure(): void {
    if (this.timer || !this.computed) this.compute();
  }

  private compute(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.computed = true;
    const { projects } = this.list();
    const index = this.index(projects);
    const rows: InboxRowView[] = [];
    for (const id of this.sent.keys()) if (!projects.some((p) => p.id === id)) this.sent.delete(id);
    for (const p of projects) {
      const snap = this.o.record.snapshot(p.id);
      if (!snap) continue;
      const cards = [...snap.cards.values()];
      const facts = new Map<string, SessionFacts>();
      for (const id of index.active.get(p.id) ?? []) facts.set(id, this.facts(id, index));
      for (const c of cards) {
        if (c.holder) facts.set(c.holder.session, this.facts(c.holder.session, index));
      }
      const marks = this.o.reviewed.keys(p.prefix);
      this.send(p.id, {
        cards: cards.map((c) =>
          this.head(c, facts.get(c.holder?.session ?? ""), index, snap.conclusions),
        ),
        conclusions: snap.conclusions.map((c) => this.conclusionView(c, snap.cards, marks, index)),
        problems: snap.problems,
        readAt: snap.readAt,
      });
      const built = buildInbox({
        project: { id: p.id, name: p.name },
        cards,
        conclusions: snap.conclusions,
        sessions: facts,
        reviewed: marks,
      });
      for (const r of built) rows.push(this.rowView(r, p.name, index));
    }
    rows.sort(inboxOrder);
    const inbox: InboxView = { rows, tray: trayCount(rows) };
    const json = JSON.stringify(inbox);
    if (json !== this.inboxJson) {
      this.inboxJson = json;
      this.inboxView = inbox;
      this.o.onInbox?.(inbox);
    }
    if (this.settleStarts()) this.o.onProjects?.();
  }

  /** only the heads that changed. the conclusions and problems whole, and only when they did */
  private send(id: ProjectId, view: ProjectRecordView): void {
    const had = this.sent.get(id);
    const next = {
      view,
      heads: new Map(view.cards.map((h) => [h.id, h])),
      conclusions: JSON.stringify(view.conclusions),
      problems: JSON.stringify(view.problems),
    };
    this.sent.set(id, next);
    if (!had) {
      this.o.onRecord?.(id, {
        cards: view.cards,
        replace: true,
        conclusions: view.conclusions,
        problems: view.problems,
        readAt: view.readAt,
      });
      return;
    }
    const { upserts, removes } = diffRows(had.heads, view.cards, (h) => h.id);
    const patch: RecordPatch = {};
    if (upserts.length) patch.cards = upserts;
    if (removes.length) patch.removedCards = removes;
    if (next.conclusions !== had.conclusions) patch.conclusions = view.conclusions;
    if (next.problems !== had.problems) patch.problems = view.problems;
    if (Object.keys(patch).length) this.o.onRecord?.(id, { ...patch, readAt: view.readAt });
  }

  /** drops the starts that were claimed from, or waited too long */
  private settleStarts(): boolean {
    let moved = false;
    for (const [id, starts] of this.pending) {
      const cards = [...(this.o.record.snapshot(id)?.cards.values() ?? [])];
      const left = starts.filter(
        (s) => Date.now() - s.at < START_TTL_MS && !claimedSince(cards, s),
      );
      if (left.length === starts.length) continue;
      moved = true;
      if (left.length) this.pending.set(id, left);
      else this.pending.delete(id);
    }
    return moved;
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
    const projectOf = new Map(projects.map((p) => [p.name, p.id]));
    const active = new Map<ProjectId, string[]>();
    for (const r of rows.values()) {
      const id = r.comboName && (r.live || r.interrupted) ? projectOf.get(r.comboName) : undefined;
      if (id) active.set(id, [...(active.get(id) ?? []), r.sessionId]);
    }
    return { rows, projectOf, active };
  }

  /** the in-progress card a session holds, the one it took last */
  private heldBy(sessionId: string, projects: readonly Project[]) {
    let best: { project: ProjectId; card: Card; since: string } | undefined;
    for (const p of projects) {
      for (const c of this.o.record.snapshot(p.id)?.cards.values() ?? []) {
        if (c.status !== "in_progress" || c.holder?.session !== sessionId) continue;
        if (!best || c.holder.since > best.since)
          best = { project: p.id, card: c, since: c.holder.since };
      }
    }
    return best;
  }

  /** where a session's process is right now. openSession asks again at call time */
  runtimeFor(id: string, row?: SessionRow): Runtime {
    return runtimeOf({
      held: row?.background?.held,
      holder: this.o.live.holder(id),
      alive: this.o.live.isAlive(id),
    });
  }

  /** from the session's newest row. one grove has not indexed yet gets LiveService's word alone */
  private facts(id: string, index: Index): SessionFacts {
    const row = index.rows.get(id);
    const runtime = this.runtimeFor(id, row);
    if (row) {
      return {
        sessionId: id,
        title: row.title,
        project: row.comboName ? index.projectOf.get(row.comboName) : undefined,
        live: row.live,
        interrupted: row.interrupted,
        runtime,
        lastPrompt: row.lastPrompt,
      };
    }
    const cut = this.o.live.interruptions().get(id);
    return {
      sessionId: id,
      live: this.o.live.list().get(id),
      interrupted: cut ? { why: "gone", at: cut.at } : undefined,
      runtime,
    };
  }

  /** moves only when the state does, so a tool call changes no head */
  private since(id: string, state: AgentState, f: SessionFacts): number | undefined {
    const had = this.stateSince.get(id);
    if (had?.state === state) return had.at;
    // the first look has no "before": no time is better than the app's start time
    const at = f.live?.at ?? f.interrupted?.at ?? (had ? Date.now() : undefined);
    this.stateSince.set(id, { state, at });
    return at;
  }

  private head(
    c: Card,
    f: SessionFacts | undefined,
    index: Index,
    conclusions: readonly Conclusion[],
  ): CardHead {
    const status = cardDisplayStatus(c, f);
    let agent: CardHead["agent"];
    if (c.holder && f) {
      const state = agentState(f);
      agent = {
        ref: refOf({ session: c.holder.session, agent: c.holder.agent }, index),
        runtime: f.runtime,
        state,
        stateAt: this.since(c.holder.session, state, f),
      };
    }
    const lastActivity = ms(c.lastActivity);
    const problems = problemCount(c);
    // the card page shows the conclusions that name it: a new one, or one replaced, is a change
    // ponytail: every conclusion per card on each compute. index by card when a project has thousands
    const concluded = conclusions
      .filter((x) => x.card === c.id)
      .map((x) => (x.superseded ? `${x.id}~` : x.id))
      .join();
    return {
      id: c.id,
      title: c.title,
      status,
      at: ms(c.at),
      lastActivity,
      agent,
      // no live.at in it: a tool call by the holder resends nothing. the status is, for a markSeen
      version: `${c.comments.length}.${c.claims.length}.${lastActivity}.${problems}.${status}.${agent?.state}.${agent?.stateAt}.${concluded}`,
      problems,
    };
  }

  private panel(session: string, name: string, holding: boolean, index: Index): AgentPanel {
    const row = index.rows.get(session);
    const f = this.facts(session, index);
    const state = agentState(f);
    return {
      ref: refOf({ session, agent: name }, index),
      sessionKey: row?.key,
      runtime: f.runtime,
      model: row?.model ? modelLabel(row.model) : undefined,
      state,
      stateAt: this.since(session, state, f),
      subagents: (row?.agents ?? []).map((a) => ({
        id: a.id,
        type: a.agentType,
        label: a.description ?? a.asked ?? a.agentType,
        state: a.state,
        lastActivityAt: a.lastActivityAt,
        lastTool: a.lastTool,
      })),
      open: openPlanOf(f.runtime, row),
      holding,
    };
  }

  private conclusionView(
    c: Conclusion,
    cards: ReadonlyMap<string, Card>,
    marks: ReadonlySet<string>,
    index: Index,
  ): ConclusionView {
    const row = index.rows.get(c.session);
    return {
      id: c.id,
      kind: c.kind,
      what: c.what,
      why: c.why,
      by: c.by,
      // for by: person, the agent whose chat it was said in
      who: c.session === "person" ? undefined : refOf(c, index),
      card: c.card ? { id: c.card, title: cards.get(c.card)?.title } : undefined,
      replaces: c.replaces,
      replacedBy: c.replacedBy,
      superseded: c.superseded,
      related: c.related,
      changesPlan: c.changesPlan,
      area: c.area,
      at: ms(c.at),
      needsReview: c.by === "agent" && !c.superseded && (c.kind !== "finding" || c.changesPlan),
      reviewed: marks.has(`conclusion:${c.id}`),
      sessionKey: row?.key,
      open: row ? openPlanOf(this.runtimeFor(c.session, row), row) : undefined,
      problems: c.problems.length,
    };
  }

  private rowView(r: InboxRow, projectName: string, index: Index): InboxRowView {
    const { sessionId, ...rest } = r;
    const row = sessionId ? index.rows.get(sessionId) : undefined;
    const runtime = sessionId ? this.runtimeFor(sessionId, row) : undefined;
    return {
      ...rest,
      projectName,
      runtime,
      sessionKey: row?.key,
      open: row && runtime ? openPlanOf(runtime, row) : undefined,
    };
  }
}

/** the session's title, else the name the record has, else the start of the id */
function refOf(x: { session: string; agent: string; sub?: string }, index: Index): AgentRef {
  return agentRef(x.session, undefined, index.rows.get(x.session)?.title || x.agent, x.sub);
}
