// readers. every function here takes whatever is on disk - records this package wrote, files
// edited by hand, files cut short - and returns a value. none of them throws. what could not be
// read is listed in `problems` on the thing it belongs to.
//
// status, holder, open / answered, superseded and "last activity" are derived here and nowhere
// else. no record stores them.
import fs from "node:fs";
import path from "node:path";
import {
  bool,
  CARD_ID,
  CONCLUSION_ID,
  idNumber,
  isIso,
  LETTER_KIND,
  num,
  parseRecord,
  paths,
  str,
  strList,
} from "./format.ts";
import type {
  Artifact,
  Author,
  By,
  Card,
  CardStatus,
  ClaimEvent,
  Comment,
  Conclusion,
  Holder,
  IndexLine,
  Project,
  Question,
  RecordSnapshot,
  Source,
} from "./types.ts";

export type {
  Artifact,
  Author,
  By,
  Card,
  CardStatus,
  ClaimEvent,
  ClaimEventKind,
  Comment,
  Conclusion,
  Holder,
  IndexLine,
  Project,
  Question,
  RecordSnapshot,
  Source,
} from "./types.ts";

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function mtimeIso(file: string): string {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

function author(f: Record<string, unknown>, file: string, problems: string[]): Author {
  let at = str(f.at);
  if (!isIso(at)) {
    // a hand-edited or cut file. the file's own time is the best there is
    problems.push(at ? `"at" is not a time: ${at}` : `no "at"`);
    at = mtimeIso(file);
  }
  const session = str(f.session);
  const by: By = str(f.by) === "person" || (!f.by && session === "person") ? "person" : "agent";
  return {
    by,
    session,
    agent: str(f.agent),
    sub: str(f.sub) || undefined,
    toolUseId: str(f.tool_use_id) || undefined,
    at,
  };
}

function artifacts(v: unknown): Artifact[] {
  if (!Array.isArray(v)) return [];
  const out: Artifact[] = [];
  for (const a of v) {
    if (a && typeof a === "object" && typeof (a as Artifact).ref === "string") {
      const t = (a as Artifact).type;
      out.push({
        type: t === "file" || t === "branch" || t === "pr" || t === "link" ? t : "link",
        ref: (a as Artifact).ref,
      });
    } else if (typeof a === "string" && a) out.push({ type: "link", ref: a });
  }
  return out;
}

function sources(v: unknown): Source[] {
  if (!Array.isArray(v)) return [];
  const out: Source[] = [];
  for (const s of v) {
    // a hand edit may list bare refs
    const ref = typeof s === "string" ? s : str((s as Source | null)?.ref);
    const note = typeof s === "string" ? "" : str((s as Source | null)?.note);
    if (ref) out.push(note ? { ref, note } : { ref });
  }
  return out;
}

export function readProject(root: string): Project | null {
  const text = readText(paths(root).project);
  if (text === null) return null;
  const problems: string[] = [];
  let j: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed;
    else problems.push("not a JSON object");
  } catch {
    problems.push("not valid JSON");
  }
  const prefix = str(j.prefix).toUpperCase();
  if (!prefix) problems.push("no prefix");
  return {
    v: num(j.v) || 1,
    name: str(j.name),
    prefix,
    goal: str(j.goal),
    rev: num(j.rev),
    problems,
  };
}

function numbered(dir: string): [number, string][] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: [number, string][] = [];
  for (const name of names) {
    const m = /^(\d+)\.md$/.exec(name);
    if (m) out.push([Number(m[1]), path.join(dir, name)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** every card id on disk, in number order. a directory with no card.md is not a card: a writer died before it published. */
export function listCardIds(root: string): string[] {
  const p = paths(root);
  let names: string[];
  try {
    names = fs.readdirSync(p.cards);
  } catch {
    return [];
  }
  return names
    .filter((n) => CARD_ID.test(n) && fs.existsSync(p.cardFile(n)))
    .sort((a, b) =>
      a.split("-")[0] === b.split("-")[0] ? idNumber(a) - idNumber(b) : a < b ? -1 : 1,
    );
}

function parseClaim(card: string, seq: number, file: string): ClaimEvent {
  const parsed = parseRecord(readText(file) ?? "");
  const f = parsed.fields;
  const problems = [...parsed.problems];
  if (f.seq !== undefined && num(f.seq) !== seq)
    problems.push(`"seq" says ${str(f.seq)}, the file name says ${seq}`);
  const pid = num(f.pid);
  return {
    ...author(f, file, problems),
    card,
    seq,
    event: str(f.event),
    pid: pid > 0 ? pid : null,
    pidStart: str(f.pid_start),
    host: str(f.host),
    via: str(f.via),
    prev: num(f.prev),
    prevSession: str(f.prev_session),
    note: str(f.note),
    body: parsed.body,
    artifacts: artifacts(f.artifacts),
    file,
    problems,
  };
}

export function readClaims(root: string, card: string): ClaimEvent[] {
  return numbered(paths(root).claims(card)).map(([seq, file]) => parseClaim(card, seq, file));
}

/** only the newest claim event: what every claim decision is made against. null when there is none. */
export function lastClaim(root: string, card: string): ClaimEvent | null {
  const all = numbered(paths(root).claims(card));
  const top = all[all.length - 1];
  return top ? parseClaim(card, top[0], top[1]) : null;
}

export function claimCount(root: string, card: string): number {
  return numbered(paths(root).claims(card)).length;
}

export function isHeld(e: ClaimEvent | null): boolean {
  return !!e && (e.event === "claim" || e.event === "takeover");
}

/** the state the claim log is in. an unknown event word changes nothing. */
export function deriveStatus(claims: ClaimEvent[]): { status: CardStatus; holder: Holder | null } {
  let status: CardStatus = "todo";
  let holder: Holder | null = null;
  for (const e of claims) {
    if (e.event === "claim" || e.event === "takeover") {
      const before = holder as Holder | null;
      const since: string = before && before.session === e.session ? before.since : e.at;
      holder = {
        session: e.session,
        agent: e.agent,
        pid: e.pid,
        pidStart: e.pidStart,
        host: e.host,
        since,
      };
      status = "in_progress";
    } else if (e.event === "release") {
      holder = null;
      status = "todo";
    } else if (e.event === "done") {
      status = "done";
      holder = null;
    } else if (e.event === "cancel") {
      status = "canceled";
      holder = null;
    }
  }
  return { status, holder };
}

export function readComments(root: string, card: string): Comment[] {
  return numbered(paths(root).comments(card)).map(([seq, file]) => {
    const parsed = parseRecord(readText(file) ?? "");
    const f = parsed.fields;
    const problems = [...parsed.problems];
    const kindRaw = str(f.kind);
    const kind = kindRaw === "question" || kindRaw === "answer" ? kindRaw : "comment";
    const c: Comment = {
      ...author(f, file, problems),
      card,
      seq,
      kind,
      text: parsed.body,
      artifacts: artifacts(f.artifacts),
      file,
      problems,
    };
    if (kind === "question") c.to = str(f.to) || "person";
    if (kind === "answer") c.answers = num(f.answers) || undefined;
    return c;
  });
}

export function questionsOf(comments: Comment[]): Question[] {
  const answers = new Map<number, number[]>();
  for (const c of comments) {
    if (c.kind === "answer" && c.answers)
      answers.set(c.answers, [...(answers.get(c.answers) ?? []), c.seq]);
  }
  return comments
    .filter((c) => c.kind === "question")
    .map((c) => {
      const answeredBy = answers.get(c.seq) ?? [];
      return {
        ...c,
        kind: "question" as const,
        to: c.to ?? "person",
        open: answeredBy.length === 0,
        answeredBy,
      };
    });
}

export function readCard(root: string, id: string): Card | null {
  const p = paths(root);
  const file = p.cardFile(id);
  const text = readText(file);
  if (text === null) return null;
  const parsed = parseRecord(text);
  const f = parsed.fields;
  const problems = [...parsed.problems];
  if (f.id !== undefined && str(f.id).toUpperCase() !== id)
    problems.push(`"id" says ${str(f.id)}, the folder says ${id}`);
  const claims = readClaims(root, id);
  const comments = readComments(root, id);
  const questions = questionsOf(comments);
  const who = author(f, file, problems);
  let lastActivity = who.at;
  for (const x of [...claims, ...comments]) if (x.at > lastActivity) lastActivity = x.at;
  return {
    ...who,
    id,
    title: str(f.title) || "(no title)",
    body: parsed.body,
    from: str(f.from).toUpperCase() || undefined,
    needs: strList(f.needs).map((s) => s.toUpperCase()),
    file,
    problems,
    ...deriveStatus(claims),
    claims,
    comments,
    questions,
    asksPerson: questions.some((q) => q.open && q.to === "person"),
    lastActivity,
  };
}

export function readCards(root: string): Card[] {
  const out: Card[] = [];
  for (const id of listCardIds(root)) {
    const c = readCard(root, id);
    if (c) out.push(c);
  }
  return out;
}

function conclusionFiles(root: string): string[] {
  const dir = paths(root).conclusions;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".md") && CONCLUSION_ID.test(n.slice(0, -3)))
    .map((n) => n.slice(0, -3));
}

export function listConclusionIds(root: string): string[] {
  return conclusionFiles(root);
}

export function parseConclusion(root: string, id: string): Conclusion | null {
  const file = path.join(paths(root).conclusions, `${id}.md`);
  const text = readText(file);
  if (text === null) return null;
  const parsed = parseRecord(text);
  const f = parsed.fields;
  const problems = [...parsed.problems];
  const kind = LETTER_KIND[id[0]!]!;
  if (f.kind !== undefined && str(f.kind) !== kind)
    problems.push(`"kind" says ${str(f.kind)}, the id says ${kind}`);
  const what = str(f.what) || parsed.body.split("\n")[0] || "(nothing written)";
  return {
    ...author(f, file, problems),
    id,
    kind,
    what,
    why: str(f.why),
    card: str(f.card).toUpperCase() || undefined,
    replaces: str(f.replaces).toUpperCase() || undefined,
    related: strList(f.related).map((s) => s.toUpperCase()),
    changesPlan: bool(f.changes_plan),
    area: str(f.area) || undefined,
    sources: sources(f.sources),
    said: str(f.said) || undefined,
    file,
    problems,
    replacedBy: [],
    superseded: false,
  };
}

/** every conclusion, newest first, with `superseded` worked out from the others. the older file is never edited. */
export function readConclusions(root: string): Conclusion[] {
  const all: Conclusion[] = [];
  for (const id of conclusionFiles(root)) {
    const c = parseConclusion(root, id);
    if (c) all.push(c);
  }
  markSuperseded(all);
  return all.sort((a, b) =>
    a.at === b.at ? idNumber(b.id) - idNumber(a.id) : a.at < b.at ? 1 : -1,
  );
}

export function markSuperseded<
  T extends {
    id: string;
    replaces?: string;
    at: string;
    replacedBy: string[];
    superseded: boolean;
  },
>(all: T[]): void {
  const byId = new Map(all.map((c) => [c.id, c]));
  const oldestFirst = [...all].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const c of oldestFirst) {
    const target = c.replaces ? byId.get(c.replaces) : undefined;
    if (target && target !== c) {
      target.replacedBy.push(c.id);
      target.superseded = true;
    }
  }
}

/**
 * conclusions/INDEX.md, one line each: id | kind | at | card | by | replaces | what
 * it is a cache for the state print. a line that does not parse is skipped, a second line for
 * the same id is ignored, and a conclusion with no line is read from its file.
 */
export function readIndex(root: string): IndexLine[] {
  const text = readText(paths(root).index) ?? "";
  const seen = new Map<string, IndexLine>();
  for (const line of text.split("\n")) {
    const parts = line.split(" | ");
    if (parts.length < 7) continue;
    const id = parts[0]!.trim();
    if (!CONCLUSION_ID.test(id) || seen.has(id)) continue;
    const dash = (s: string) => (s.trim() === "-" ? undefined : s.trim());
    seen.set(id, {
      id,
      kind: LETTER_KIND[id[0]!]!,
      at: parts[2]!.trim(),
      card: dash(parts[3]!),
      by: parts[4]!.trim() === "person" ? "person" : "agent",
      replaces: dash(parts[5]!),
      what: parts.slice(6).join(" | "),
      replacedBy: [],
      superseded: false,
    });
  }
  // a writer killed between publishing and appending leaves a conclusion with no line
  for (const id of conclusionFiles(root)) {
    if (seen.has(id)) continue;
    const c = parseConclusion(root, id);
    if (c)
      seen.set(id, {
        id,
        kind: c.kind,
        at: c.at,
        card: c.card,
        by: c.by,
        replaces: c.replaces,
        what: c.what,
        replacedBy: [],
        superseded: false,
      });
  }
  // an index line whose file is gone is not a conclusion
  const onDisk = new Set(conclusionFiles(root));
  const all = [...seen.values()].filter((l) => onDisk.has(l.id));
  markSuperseded(all);
  return all.sort((a, b) =>
    a.at === b.at ? idNumber(b.id) - idNumber(a.id) : a.at < b.at ? 1 : -1,
  );
}

export function revisionOf(
  project: Project | null,
  cards: Card[],
  conclusionCount: number,
): number {
  let n = (project?.rev ?? 0) + conclusionCount;
  for (const c of cards) n += 1 + c.comments.length + c.claims.length;
  return n;
}

/** the whole record in one value. what the desktop app renders from. */
export function readRecord(root: string): RecordSnapshot {
  const project = readProject(root);
  const cards = readCards(root);
  const conclusions = readConclusions(root);
  return {
    root,
    project,
    cards,
    conclusions,
    revision: revisionOf(project, cards, conclusions.length),
  };
}
