// the operations. each one reads what is on disk, decides, and publishes at most one record.
// a failure an agent can act on comes back as a result with a code and the next step in its text.
import fs from "node:fs";
import path from "node:path";
import {
  bare,
  CARD_ID,
  CONCLUSION_ID,
  type ConclusionKind,
  cut,
  cutBytes,
  type FmValue,
  KIND_LETTER,
  normId,
  nowIso,
  oneLine,
  PREFIX,
  pad4,
  paths,
  renderRecord,
  shortTime,
} from "./format.ts";
import { type Caller, claudeDir, holderStatus, type Liveness, procStart } from "./identity.ts";
import { appendLine, highest, publishAt, publishNext } from "./publish.ts";
import {
  type Artifact,
  type By,
  type Card,
  type ClaimEvent,
  type Comment,
  type Conclusion,
  isHeld,
  lastClaim,
  listCardIds,
  listConclusionIds,
  type Project,
  parseConclusion,
  type Question,
  readCard,
  readCards,
  readConclusions,
  readIndex,
  readProject,
  revisionOf,
  type Source,
} from "./read.ts";
import { lastSaid, transcriptFile, turnAround } from "./transcript.ts";
import { FORMAT_VERSION } from "./version.ts";

export type ErrCode =
  | "invalid"
  | "not_found"
  | "held"
  | "holder_gone"
  | "not_holder"
  | "closed"
  | "refused"
  | "unavailable";

/** the CLI's exit code for each failure. 0 is success. 3-7 are the claim outcomes of record.sh. */
export const EXIT: Record<ErrCode, number> = {
  invalid: 1,
  not_found: 2,
  held: 3,
  holder_gone: 4,
  not_holder: 5,
  closed: 6,
  refused: 7,
  unavailable: 8,
};

export interface OpResult {
  ok: boolean;
  text: string;
  code?: ErrCode;
}

export interface Ctx {
  root: string;
  caller: Caller;
  env: NodeJS.ProcessEnv;
}

class Fail extends Error {
  code: ErrCode;
  constructor(code: ErrCode, text: string) {
    super(text);
    this.code = code;
  }
}

const ok = (text: string): OpResult => ({ ok: true, text });
const fail = (code: ErrCode, text: string): never => {
  throw new Fail(code, text);
};

/** run an operation. a Fail becomes an error result, anything else thrown becomes "unavailable". */
export function attempt(fn: () => OpResult): OpResult {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Fail) return { ok: false, code: e.code, text: e.message };
    return {
      ok: false,
      code: "unavailable",
      text: `record unavailable: ${(e as Error).message}. Nothing was written by this call unless the text says so. Call record_state to check before you retry.`,
    };
  }
}

// ---------- shared ----------

function needProject(ctx: Ctx): Project {
  const project = readProject(ctx.root);
  if (!project) {
    return fail(
      "unavailable",
      `record unavailable: ${paths(ctx.root).project} is missing, so ${ctx.root} is not set up as a Grove project. Tell the person to open Grove once. Do not create record files by hand.`,
    );
  }
  if (!PREFIX.test(project.prefix)) {
    return fail(
      "unavailable",
      `record unavailable: ${paths(ctx.root).project} has no usable card prefix (${project.problems.join(", ") || `"${project.prefix}"`}). Tell the person to open Grove once.`,
    );
  }
  return project;
}

function needCard(ctx: Ctx, raw: string): string {
  const id = normId(raw);
  if (!CARD_ID.test(id))
    fail(
      "not_found",
      `"${raw}" is not a card id. A card id looks like ${needProject(ctx).prefix}-3. Call record_state to see the cards.`,
    );
  if (!fs.existsSync(paths(ctx.root).cardFile(id)))
    fail("not_found", `There is no card ${id}. Call record_state to see the cards.`);
  return id;
}

function needConclusion(ctx: Ctx, raw: string, what: string): string {
  const id = normId(raw);
  if (!CONCLUSION_ID.test(id))
    fail(
      "not_found",
      `${what} "${raw}" is not a conclusion id. Conclusion ids look like D-4, F-2 or V-7.`,
    );
  if (!fs.existsSync(path.join(paths(ctx.root).conclusions, `${id}.md`)))
    fail("not_found", `${what} ${id} does not exist. Call conclusion_search to find the right id.`);
  return id;
}

function authorFields(c: Caller, by?: By): [string, FmValue][] {
  return [
    ["by", bare(by ?? (c.actor === "person" ? "person" : "agent"))],
    ["session", bare(c.session || "unknown")],
    ["agent", c.agent || undefined],
    ["sub", c.sub],
    ["at", bare(nowIso())],
    ["tool_use_id", c.toolUseId ? bare(c.toolUseId) : undefined],
  ];
}

function who(e: { agent: string; session: string; sub?: string; by?: By }): string {
  if (e.session === "person") return "the person";
  const name = e.agent || e.session.slice(0, 8) || "an unknown agent";
  return e.sub ? `${name} (${e.sub})` : name;
}

function holderName(e: ClaimEvent): string {
  return `${e.agent || "an agent"} (session ${e.session.slice(0, 8)})`;
}

function isDir(f: string): boolean {
  try {
    return fs.statSync(f).isDirectory();
  } catch {
    return true; // gone: not in the way
  }
}

// ---------- cards ----------

export interface CardCreateArgs {
  title: string;
  body?: string;
  from?: string;
  needs?: string[];
}

export function cardCreate(ctx: Ctx, a: CardCreateArgs): OpResult {
  const project = needProject(ctx);
  const p = paths(ctx.root);
  const from = a.from ? needCard(ctx, a.from) : undefined;
  const needs = (a.needs ?? []).map((n) => needCard(ctx, n));
  const re = new RegExp(`^${project.prefix}-([1-9][0-9]*)$`);
  const fields = (id: string): [string, FmValue][] => [
    ["id", bare(id)],
    ["title", oneLine(a.title)],
    ...authorFields(ctx.caller),
    ["from", from ? bare(from) : undefined],
    ["needs", needs.length ? needs : undefined],
  ];
  // a card is a directory, and a directory cannot be created together with its content. so the
  // directory means nothing: the id belongs to whoever links card.md into it. only directories
  // that hold a card.md count towards the next number, so a writer killed after mkdir leaves a
  // directory the next writer walks straight into.
  const made = publishNext(
    p.cards,
    () =>
      highest(
        p.cards,
        re,
        (name) => fs.existsSync(p.cardFile(name)) || !isDir(path.join(p.cards, name)),
      ) + 1,
    (n) => p.cardFile(`${project.prefix}-${n}`),
    (n) => renderRecord(fields(`${project.prefix}-${n}`), a.body ?? ""),
  );
  const id = `${project.prefix}-${made.n}`;
  return ok(
    `${id} created: "${cut(oneLine(a.title), 80)}". It is todo and nobody holds it. To work on it yourself, call card_claim with card "${id}".`,
  );
}

function strongIdentity(ctx: Ctx, verb: string): { pid: number; start: string } {
  const c = ctx.caller;
  if (c.actor === "person")
    return fail(
      "invalid",
      `The person does not hold cards, so the person cannot ${verb} one. An agent does that from its own session.`,
    );
  if (!c.session || !c.pid) {
    return fail(
      "unavailable",
      `record unavailable: cannot tell which Claude session is calling (session: ${c.sessionSource}, process: ${c.pidSource}). A claim needs both. Call this through the mcp__grove__* tools or from the Bash tool of a Claude session.`,
    );
  }
  return { pid: c.pid, start: procStart(c.pid) };
}

function writeClaim(
  ctx: Ctx,
  card: string,
  last: ClaimEvent | null,
  event: string,
  me: { pid: number | null; start: string },
  note: string,
  body = "",
  artifacts?: Artifact[],
): boolean {
  const c = ctx.caller;
  const seq = (last?.seq ?? 0) + 1;
  const content = renderRecord(
    [
      ["card", bare(card)],
      ["seq", seq],
      ["event", bare(event)],
      ...authorFields(c),
      ["pid", me.pid ?? undefined],
      ["pid_start", me.pid ? me.start : undefined],
      ["host", bare(c.host)],
      ["via", bare(`${c.sessionSource}/${c.pidSource}`)],
      ["prev", last?.seq ?? 0],
      ["prev_session", last ? bare(last.session || "unknown") : undefined],
      ["note", note || undefined],
      ["artifacts", artifacts?.length ? artifacts : undefined],
    ],
    body,
  );
  return publishAt(path.join(paths(ctx.root).claims(card), `${pad4(seq)}.md`), content);
}

function liveness(ctx: Ctx, e: ClaimEvent): Liveness {
  return holderStatus(
    { session: e.session, pid: e.pid, pidStart: e.pidStart, host: e.host },
    ctx.env,
  );
}

const LIVE_WORDS: Record<Liveness, string> = {
  alive: "is running",
  dead: "is not running",
  unknown: "cannot be checked from here",
};

function closedText(card: string, e: ClaimEvent): string {
  const word = e.event === "done" ? "done" : "canceled";
  return `${card} is ${word}. A ${word} card stays ${word}. If there is more to do, create a new card with card_create and from "${card}".`;
}

const isClosed = (e: ClaimEvent | null) => !!e && (e.event === "done" || e.event === "cancel");

export function cardClaim(ctx: Ctx, a: { card: string }): OpResult {
  needProject(ctx);
  const card = needCard(ctx, a.card);
  const me = strongIdentity(ctx, "claim");
  for (let tries = 0; tries < 200; tries++) {
    const last = lastClaim(ctx.root, card);
    if (isClosed(last)) fail("closed", closedText(card, last!));
    if (isHeld(last)) {
      if (last!.session === ctx.caller.session) {
        if (last!.pid === me.pid && last!.pidStart === me.start)
          return ok(`${card} is already yours.`);
        // same session in a new process: a resume. write the new pid down
        if (writeClaim(ctx, card, last, "claim", me, "same session, new process"))
          return ok(
            `${card} is yours. The claim was refreshed, because this session now runs in a new process.`,
          );
        continue;
      }
      const st = liveness(ctx, last!);
      if (st === "dead") {
        fail(
          "holder_gone",
          `${card} is held by ${holderName(last!)}, whose process is not running. That is normal for a closed VS Code tab and does not mean the card is free. Do not work on it. Ask the person whether you should take it over. If they say yes, call card_takeover with card "${card}".`,
        );
      }
      fail(
        "held",
        `${card} is held by ${holderName(last!)}, which ${LIVE_WORDS[st]}. Do not work on it. Pick another card, or leave that agent a question with question_ask (to "${card}").`,
      );
    }
    if (writeClaim(ctx, card, last, "claim", me, ""))
      return ok(
        `${card} claimed. It is yours until you call card_done, card_release or card_cancel. Read it with card_show before you start.`,
      );
  }
  return fail(
    "unavailable",
    `record unavailable: could not settle the claim on ${card} after 200 tries. Call card_show with card "${card}" to see who holds it.`,
  );
}

export function cardRelease(ctx: Ctx, a: { card: string; note?: string }): OpResult {
  needProject(ctx);
  const card = needCard(ctx, a.card);
  const person = ctx.caller.actor === "person";
  const me = person ? { pid: null, start: "" } : strongIdentity(ctx, "release");
  for (let tries = 0; tries < 200; tries++) {
    const last = lastClaim(ctx.root, card);
    if (isClosed(last)) fail("closed", closedText(card, last!));
    if (!isHeld(last))
      fail("not_holder", `${card} is not claimed, so there is nothing to release.`);
    const mine = last!.session === ctx.caller.session;
    if (!mine && !person)
      fail(
        "not_holder",
        `You do not hold ${card}. ${holderName(last!)} does. Only its holder or the person can release it.`,
      );
    const note = mine
      ? ""
      : `released by the person. it was held by ${last!.agent || last!.session}`;
    if (writeClaim(ctx, card, last, "release", me, note, a.note ?? ""))
      return ok(`${card} released. It is todo again and anyone can claim it.`);
  }
  return fail(
    "unavailable",
    `record unavailable: could not release ${card} after 200 tries. Call card_show with card "${card}".`,
  );
}

export function cardTakeover(ctx: Ctx, a: { card: string; force?: boolean }): OpResult {
  needProject(ctx);
  const card = needCard(ctx, a.card);
  const me = strongIdentity(ctx, "take over");
  for (let tries = 0; tries < 200; tries++) {
    const last = lastClaim(ctx.root, card);
    if (isClosed(last)) fail("closed", closedText(card, last!));
    if (!isHeld(last)) {
      if (writeClaim(ctx, card, last, "claim", me, ""))
        return ok(`${card} claimed. Nobody held it, so nothing was taken over.`);
      continue;
    }
    if (last!.session === ctx.caller.session) return ok(`${card} is already yours.`);
    const st = liveness(ctx, last!);
    if (st === "dead") {
      if (
        writeClaim(ctx, card, last, "takeover", me, `holder process ${last!.pid ?? "?"} was gone`)
      )
        return ok(
          `${card} taken over from ${holderName(last!)}. It is yours now. Read it with card_show before you carry on, its thread says where they stopped.`,
        );
      continue;
    }
    if (a.force) {
      if (writeClaim(ctx, card, last, "takeover", me, `forced. holder was ${st}`))
        return ok(
          `${card} taken over from ${holderName(last!)}, which ${LIVE_WORDS[st]} (forced). It is yours now. That agent learns it lost the card the next time it calls my_cards.`,
        );
      continue;
    }
    fail(
      "refused",
      `${card} was not taken: ${holderName(last!)} holds it and ${LIVE_WORDS[st]}. Pass force true only when the person told you, in so many words, to take this card from an agent that is still running.`,
    );
  }
  return fail(
    "unavailable",
    `record unavailable: could not take over ${card} after 200 tries. Call card_show with card "${card}".`,
  );
}

export function cardDone(
  ctx: Ctx,
  a: { card: string; summary: string; artifacts?: Artifact[] },
): OpResult {
  needProject(ctx);
  const card = needCard(ctx, a.card);
  const me = strongIdentity(ctx, "finish");
  for (let tries = 0; tries < 200; tries++) {
    const last = lastClaim(ctx.root, card);
    if (last?.event === "done") return ok(`${card} is already done.`);
    if (last?.event === "cancel") fail("closed", closedText(card, last));
    if (!isHeld(last))
      fail(
        "not_holder",
        `You do not hold ${card}, nobody does. Claim it with card_claim first, then call card_done.`,
      );
    if (last!.session !== ctx.caller.session)
      fail(
        "not_holder",
        `You do not hold ${card}. ${holderName(last!)} does. Only its holder can mark it done.`,
      );
    if (writeClaim(ctx, card, last, "done", me, "", a.summary, a.artifacts))
      return ok(`${card} is done. The person sees it in their inbox with your summary.`);
  }
  return fail(
    "unavailable",
    `record unavailable: could not mark ${card} done after 200 tries. Call card_show with card "${card}".`,
  );
}

export function cardCancel(ctx: Ctx, a: { card: string; reason: string }): OpResult {
  needProject(ctx);
  const card = needCard(ctx, a.card);
  const person = ctx.caller.actor === "person";
  const me = person
    ? { pid: null, start: "" }
    : { pid: ctx.caller.pid, start: ctx.caller.pid ? procStart(ctx.caller.pid) : "" };
  for (let tries = 0; tries < 200; tries++) {
    const last = lastClaim(ctx.root, card);
    if (last?.event === "cancel") return ok(`${card} is already canceled.`);
    if (last?.event === "done") fail("closed", closedText(card, last));
    if (isHeld(last) && !person && last!.session !== ctx.caller.session) {
      fail(
        "not_holder",
        `${card} is held by ${holderName(last!)}. Only its holder or the person can cancel it. If you think it should not be done, say why with comment_add on "${card}".`,
      );
    }
    if (writeClaim(ctx, card, last, "cancel", me, "", a.reason))
      return ok(`${card} canceled. It keeps its id and its thread.`);
  }
  return fail(
    "unavailable",
    `record unavailable: could not cancel ${card} after 200 tries. Call card_show with card "${card}".`,
  );
}

// ---------- the thread ----------

function publishComment(ctx: Ctx, card: string, fields: [string, FmValue][], text: string): number {
  const dir = paths(ctx.root).comments(card);
  const made = publishNext(
    dir,
    () => highest(dir, /^(\d+)\.md$/) + 1,
    (n) => path.join(dir, `${pad4(n)}.md`),
    (n) => renderRecord([["card", bare(card)], ["seq", n], ...fields], text),
  );
  return made.n;
}

export function commentAdd(
  ctx: Ctx,
  a: { card: string; text: string; artifacts?: Artifact[] },
): OpResult {
  needProject(ctx);
  const card = needCard(ctx, a.card);
  const n = publishComment(
    ctx,
    card,
    [
      ["kind", bare("comment")],
      ...authorFields(ctx.caller),
      ["artifacts", a.artifacts?.length ? a.artifacts : undefined],
    ],
    a.text,
  );
  return ok(`${card}#${n} added.`);
}

export function questionAsk(ctx: Ctx, a: { card: string; text: string; to?: string }): OpResult {
  needProject(ctx);
  const card = needCard(ctx, a.card);
  const toRaw = (a.to ?? "person").trim();
  const to = /^(person|the person|you|human|user)$/i.test(toRaw) ? "person" : needCard(ctx, toRaw);
  const n = publishComment(
    ctx,
    card,
    [["kind", bare("question")], ["to", bare(to)], ...authorFields(ctx.caller)],
    a.text,
  );
  const close = `It stays open until someone calls question_answer with card "${card}" and question ${n}.`;
  if (to === "person") {
    return ok(
      `${card}#${n} asked, to the person. ${close} Now ask the person the same question in the chat: the record does not notify them inside this conversation. If you can carry on without the answer, say what you assume and carry on.`,
    );
  }
  const holder = lastClaim(ctx.root, to);
  const whom = isHeld(holder)
    ? `${holder!.agent || "an agent"} holds ${to} now`
    : `nobody holds ${to} now, so it waits for whoever claims it`;
  return ok(
    `${card}#${n} asked, to the agent on ${to} (${whom}). They see it when they call my_cards. ${close} Call my_cards later to see the answer.`,
  );
}

export function questionAnswer(
  ctx: Ctx,
  a: { card: string; question: number; text: string; by?: By },
): OpResult {
  needProject(ctx);
  const card = needCard(ctx, a.card);
  const full = readCard(ctx.root, card);
  const q = full?.questions.find((x) => x.seq === a.question);
  if (!q) {
    const open = full?.questions.filter((x) => x.open).map((x) => `#${x.seq}`) ?? [];
    fail(
      "not_found",
      `${card}#${a.question} is not a question. ${open.length ? `Open questions on ${card}: ${open.join(", ")}.` : `${card} has no open question.`} Call card_show with card "${card}" to see its thread.`,
    );
  }
  const by: By = a.by ?? (ctx.caller.actor === "person" ? "person" : "agent");
  const n = publishComment(
    ctx,
    card,
    [["kind", bare("answer")], ["answers", a.question], ...authorFields(ctx.caller, by)],
    a.text,
  );
  const was = q!.open
    ? `${card}#${a.question} is closed.`
    : `${card}#${a.question} already had an answer (#${q!.answeredBy.join(", #")}), yours was added.`;
  return ok(
    `${card}#${n} answers #${a.question}. ${was} If this answer settles something, record it too: conclusion_record with card "${card}"${by === "person" ? ' and by "person"' : ""}.`,
  );
}

// ---------- conclusions ----------

export interface ConclusionArgs {
  kind: ConclusionKind;
  what: string;
  why?: string;
  card?: string;
  by?: By;
  replaces?: string;
  related?: string[];
  changes_plan?: boolean;
  area?: string;
  sources?: Source[];
}

/** how much of what the person typed is kept on a conclusion. */
const SAID_MAX = 600;

function transcriptOf(ctx: Ctx, session: string): string | null {
  return transcriptFile(path.join(claudeDir(ctx.env), "projects"), session);
}

/**
 * the last thing the person typed in the calling session, for `said`. claude code deletes
 * transcripts after about 30 days and another agent cannot read this one's, so the words are kept
 * on the record. nothing found, or nothing readable, is no `said`: never a failed write.
 */
function saidNow(ctx: Ctx): string | undefined {
  if (ctx.caller.actor !== "agent") return undefined;
  const file = transcriptOf(ctx, ctx.caller.session);
  const typed = file ? lastSaid(file) : undefined;
  if (!typed) return undefined;
  // line breaks stay. every other control character goes: this is printed to terminals
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return cut(typed.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ").trim(), SAID_MAX);
}

/** one line of conclusions/INDEX.md. under 1,000 bytes whatever `what` holds. */
export function indexLine(c: {
  id: string;
  kind: string;
  at: string;
  card?: string;
  by: By;
  replaces?: string;
  what: string;
}): string {
  return `${c.id} | ${c.kind} | ${c.at} | ${c.card ?? "-"} | ${c.by} | ${c.replaces ?? "-"} | ${cutBytes(oneLine(c.what), 700)}`;
}

export function conclusionRecord(ctx: Ctx, a: ConclusionArgs): OpResult {
  needProject(ctx);
  const p = paths(ctx.root);
  const card = a.card ? needCard(ctx, a.card) : undefined;
  const replaces = a.replaces ? needConclusion(ctx, a.replaces, "replaces:") : undefined;
  if (replaces) {
    // replacing what is already replaced splits the record in two current answers
    const all = readConclusions(ctx.root);
    const target = all.find((c) => c.id === replaces);
    if (target?.superseded) {
      const by = all
        .filter((c) => target.replacedBy.includes(c.id))
        .map((c) => `${c.id} ("${cut(c.what, 80)}"${c.by === "person" ? ", the person's" : ""})`);
      fail(
        "invalid",
        `${replaces} was already replaced by ${by.join(" and ")}. Read it with conclusion_search, then pass replaces "${target.replacedBy.at(-1)}" if you mean to overrule it.`,
      );
    }
  }
  const related = (a.related ?? []).map((r) => needConclusion(ctx, r, "related:"));
  const by: By = a.by ?? (ctx.caller.actor === "person" ? "person" : "agent");
  const letter = KIND_LETTER[a.kind];
  const author = authorFields(ctx.caller, by);
  const at = (author.find(([k]) => k === "at")![1] as { bare: string }).bare;
  const what = oneLine(a.what);
  const said = saidNow(ctx);
  const made = publishNext(
    p.conclusions,
    () => highest(p.conclusions, new RegExp(`^${letter}-([1-9][0-9]*)\\.md$`)) + 1,
    (n) => path.join(p.conclusions, `${letter}-${n}.md`),
    (n) =>
      renderRecord([
        ["id", bare(`${letter}-${n}`)],
        ["kind", bare(a.kind)],
        ["what", what],
        ["why", a.why ?? ""],
        ...author,
        ["card", card ? bare(card) : undefined],
        ["replaces", replaces ? bare(replaces) : undefined],
        ["related", related.length ? related : undefined],
        ["changes_plan", a.changes_plan ? true : undefined],
        ["area", a.area ? oneLine(a.area).toLowerCase() : undefined],
        ["sources", a.sources?.length ? a.sources : undefined],
        ["said", said || undefined],
      ]),
  );
  const id = `${letter}-${made.n}`;
  // the file is the record. the index line is a cache the state print reads, and a reader that
  // finds a conclusion with no line reads the file instead. so a writer killed right here loses nothing
  appendLine(p.index, indexLine({ id, kind: a.kind, at, card, by, replaces, what }));
  const whose = by === "person" ? "the person's" : "yours";
  return ok(
    `${id} recorded: ${a.kind}, ${whose}.${replaces ? ` It replaces ${replaces}, which now shows as superseded.` : ""}${a.changes_plan ? " It is flagged as changing the plan, so the person sees it in their inbox." : ""} Cite it as ${id} in cards, comments and commit messages.`,
  );
}

/** add the INDEX.md line of every conclusion that has none. only appends, so it cannot lose a line another writer added. */
export function reindex(root: string): number {
  const p = paths(root);
  let text = "";
  try {
    text = fs.readFileSync(p.index, "utf8");
  } catch {
    // no index yet
  }
  const have = new Set(text.split("\n").map((l) => l.split(" | ")[0]!.trim()));
  let added = 0;
  for (const c of readConclusions(root).reverse()) {
    if (have.has(c.id)) continue;
    appendLine(p.index, indexLine(c));
    added++;
  }
  return added;
}

export interface SearchArgs {
  query?: string;
  kind?: ConclusionKind;
  card?: string;
  include_replaced?: boolean;
  limit?: number;
}

export function conclusionSearch(ctx: Ctx, a: SearchArgs): OpResult {
  needProject(ctx);
  const all = readConclusions(ctx.root);
  const card = a.card ? normId(a.card) : undefined;
  const q = (a.query ?? "").trim();
  const asId = CONCLUSION_ID.test(q.toUpperCase()) ? q.toUpperCase() : null;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = all.filter((c) => {
    if (a.kind && c.kind !== a.kind) return false;
    if (card && c.card !== card) return false;
    if (asId) return c.id === asId;
    if (!terms.length) return true;
    const hay = [
      c.id,
      c.kind,
      c.what,
      c.why,
      c.area ?? "",
      c.card ?? "",
      c.agent,
      c.sub ?? "",
      c.by === "person" ? "person you the person" : "agent",
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const shown = matches.filter((c) => asId || a.include_replaced || !c.superseded);
  const hidden = matches.filter((c) => !shown.includes(c));
  // an id asks for that one conclusion, so it gets all of it
  if (asId && shown.length === 1) return ok(conclusionFull(ctx, shown[0]!));
  const limit = Math.min(Math.max(a.limit ?? 20, 1), 50);
  const lines: string[] = [];
  for (const c of shown.slice(0, limit)) {
    lines.push(conclusionHead(c), `  what: ${c.what}`);
    if (c.why) lines.push(`  why: ${cut(oneLine(c.why), 600)}`);
    lines.push(...sourceLines(c));
  }
  const head = `${shown.length} conclusion${shown.length === 1 ? "" : "s"} match${shown.length === 1 ? "es" : ""}${q ? ` "${q}"` : ""}${a.kind ? `, kind ${a.kind}` : ""}${card ? `, card ${card}` : ""} (of ${all.length} in the project).`;
  const tail: string[] = [];
  if (shown.length > limit)
    tail.push(
      `${shown.length - limit} more match. Narrow the query, or pass a larger limit (up to 50).`,
    );
  if (hidden.length)
    tail.push(
      `${hidden.length} superseded and not shown: ${hidden.map((c) => `${c.id} (replaced by ${c.replacedBy.join(", ")})`).join(", ")}. Pass include_replaced true to see them.`,
    );
  if (!shown.length && !hidden.length)
    tail.push(
      q
        ? "Nothing is settled on this yet as far as the record knows. Try fewer or other words before you conclude that."
        : "No conclusions recorded yet.",
    );
  if (shown.length)
    tail.push(
      "To read one in full, with the conversation it was recorded in, call conclusion_search with its id as the query.",
    );
  return ok([head, ...lines, ...tail].join("\n"));
}

function conclusionHead(c: Conclusion): string {
  const head = [
    `${c.id} ${c.kind}`,
    c.by === "person" ? `by the person (recorded by ${c.agent || "an agent"})` : `by ${who(c)}`,
    shortTime(c.at),
  ];
  if (c.card) head.push(c.card);
  if (c.area) head.push(`area ${c.area}`);
  if (c.changesPlan) head.push("changes the plan");
  if (c.replaces) head.push(`replaces ${c.replaces}`);
  if (c.related.length) head.push(`related ${c.related.join(", ")}`);
  if (c.superseded) head.push(`SUPERSEDED by ${c.replacedBy.join(", ")} - do not follow this one`);
  return head.join(" | ");
}

/** where it came from, as search hits and card_show print it: every source, and the person's words on one line. */
function sourceLines(c: Conclusion): string[] {
  const out = c.sources.map(sourceLine);
  if (c.said) out.push(`  the person said: ${cut(oneLine(c.said), 200)}`);
  return out;
}

const sourceLine = (s: Source) => `  source: ${s.ref}${s.note ? ` - ${s.note}` : ""}`;

/** text that runs over lines, under a label. */
const under = (text: string) => text.split("\n").join("\n      ");

/**
 * one conclusion with everything there is about it, for an agent that is about to rely on it or
 * overrule it: the record's own fields, then the turn it was recorded in, read from the
 * transcript now. a transcript that is gone costs one line, never the call.
 */
function conclusionFull(ctx: Ctx, c: Conclusion): string {
  const out = [conclusionHead(c), `  what: ${c.what}`];
  if (c.why) out.push(`  why: ${under(c.why)}`);
  out.push(...(c.sources.length ? c.sources.map(sourceLine) : ["  sources: none recorded"]));
  const file = transcriptOf(ctx, c.session);
  const turn = file && c.toolUseId ? turnAround(file, c.toolUseId) : null;
  // the transcript has the same message uncut. without it, the words kept on the record
  if (c.said && !turn?.prompt) out.push(`  the person said: ${under(c.said)}`);
  if (turn?.prompt || turn?.text) {
    out.push("  the conversation it was recorded in:");
    if (turn.prompt) out.push(`    the person: ${under(turn.prompt)}`);
    if (turn.text) out.push(`    ${who(c)}, before recording it: ${under(turn.text)}`);
    out.push(`  transcript: ${file} (the call is ${c.toolUseId})`);
  } else if (c.session === "person") {
    out.push("  the conversation: none. The person recorded it in Grove.");
  } else if (!file) {
    out.push(
      `  the conversation: the session's transcript is gone or cannot be read from here.${c.said ? " What the person said is what is left." : ""}`,
    );
  } else {
    out.push(
      `  the conversation: the call that recorded it is not in the session's transcript (a subagent's call, or one made through the CLI). transcript: ${file}`,
    );
  }
  return out.join("\n");
}

// ---------- reading for agents ----------

function allOpenQuestions(cards: Card[]): Question[] {
  return cards
    .flatMap((c) => c.questions.filter((q) => q.open))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function you(ctx: Ctx): string {
  const c = ctx.caller;
  if (c.actor === "person") return "you: the person";
  if (!c.session) return "you: unknown session (no Claude session id could be found)";
  return `you: session ${c.session}${c.agent ? ` "${c.agent}"` : ""}`;
}

const STATE_BUDGET = 9000;

/**
 * the project state as text. the SessionStart hook prints exactly this and record_state returns it.
 * it is a function of the record files and the caller's session id only: no clock, no process
 * checks. so the same state always prints the same text, and the first line changes exactly when
 * a record was added or grove changed the project file.
 */
export function stateText(ctx: Ctx, opts: { all?: boolean } = {}): string {
  const project = needProject(ctx);
  const cards = readCards(ctx.root);
  const index = readIndex(ctx.root);
  const rev = revisionOf(project, cards, listConclusionIds(ctx.root).length);
  const all = !!opts.all;
  const caps = all
    ? { q: 1e9, active: 1e9, closed: 1e9, concl: 50 }
    : { q: 6, active: 30, closed: 3, concl: 10 };

  const mine = cards.filter(
    (c) => c.holder && c.holder.session === ctx.caller.session && ctx.caller.actor === "agent",
  );
  const out: string[] = [];
  out.push(
    `# record ${project.prefix} rev ${rev}${project.name ? ` - ${cut(oneLine(project.name), 60)}` : ""}`,
  );
  out.push(`goal: ${project.goal ? cut(oneLine(project.goal), 300) : "(none written yet)"}`);
  out.push(
    `${you(ctx)}. ${mine.length ? `you hold ${mine.map((c) => c.id).join(", ")}` : "you hold no card"}`,
  );

  const questions = allOpenQuestions(cards);
  questions.sort(
    (a, b) => (a.to === "person" ? 0 : 1) - (b.to === "person" ? 0 : 1) || (a.at < b.at ? 1 : -1),
  );
  out.push("", `## open questions (${questions.length})`);
  for (const q of questions.slice(0, caps.q)) {
    out.push(
      cut(
        `${q.card}#${q.seq} -> ${q.to === "person" ? "the person" : q.to} | ${who(q)} | ${shortTime(q.at)} | ${oneLine(q.text)}`,
        all ? 2000 : 200,
      ),
    );
  }
  if (questions.length > caps.q)
    out.push(`(${questions.length - caps.q} more. record_state with all true lists them)`);

  const count = (s: string) => cards.filter((c) => c.status === s).length;
  out.push(
    "",
    `## cards (${cards.length}: ${count("in_progress")} in progress, ${count("todo")} todo, ${count("done")} done, ${count("canceled")} canceled)`,
  );
  const line = (c: Card) => {
    const bits = [c.id, c.status];
    if (c.holder) bits.push(`[${c.holder.agent || c.holder.session.slice(0, 8)}]`);
    if (c.asksPerson) bits.push("asks the person");
    if (c.needs.length) bits.push(`needs ${c.needs.join(",")}`);
    return cut(`${bits.join(" ")} | ${c.title}`, all ? 400 : 140);
  };
  const active = [
    ...cards.filter((c) => c.status === "in_progress"),
    ...cards.filter((c) => c.status === "todo"),
  ];
  for (const c of active.slice(0, caps.active)) out.push(line(c));
  if (active.length > caps.active)
    out.push(
      `(${active.length - caps.active} more todo cards. record_state with all true lists them)`,
    );
  const closed = cards
    .filter((c) => c.status === "done" || c.status === "canceled")
    .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  for (const c of closed.slice(0, caps.closed)) out.push(line(c));
  if (closed.length > caps.closed)
    out.push(`(${closed.length - caps.closed} more done or canceled)`);
  if (!cards.length) out.push("(no cards yet. create the first with card_create)");

  out.push("", `## newest conclusions (${Math.min(caps.concl, index.length)} of ${index.length})`);
  for (const c of index.slice(0, caps.concl)) {
    const bits = [`${c.id} ${c.kind}${c.by === "person" ? " (the person's)" : ""}`];
    if (c.card) bits.push(c.card);
    if (c.replaces) bits.push(`replaces ${c.replaces}`);
    if (c.superseded) bits.push(`SUPERSEDED by ${c.replacedBy.join(",")}`);
    // the why is what a later session looks up. the index line has no why, so read the shown ones
    const full = parseConclusion(ctx.root, c.id);
    // there is more to read than this line: conclusion_search with the id shows it
    const n = full?.sources.length ?? 0;
    if (n) bits.push(`[${n} source${n === 1 ? "" : "s"}]`);
    const why = full?.why;
    const text = why ? `${c.what} (why: ${oneLine(why)})` : c.what;
    out.push(cut(`${bits.join(" ")} | ${text}`, all ? 800 : 180));
  }
  if (index.length > caps.concl)
    out.push(
      `(${index.length - caps.concl} older. call conclusion_search before you settle anything)`,
    );
  if (!index.length) out.push("(none yet)");

  out.push(
    "",
    "write through the mcp__grove__* tools. start with my_cards, then card_claim before you work on a card. rules: .claude/rules/grove-record.md",
  );
  let text = out.join("\n");
  if (!all && text.length > STATE_BUDGET) {
    // cannot happen with the caps above (worst case is about 8,600). kept as a guard for a later edit
    text = `${text.slice(0, STATE_BUDGET - 80)}\n(cut to stay under the hook's limit. call record_state with all true)`;
  }
  return text;
}

export function recordState(ctx: Ctx, a: { all?: boolean }): OpResult {
  return ok(stateText(ctx, a));
}

function threadLines(card: Card): string[] {
  type Entry = { at: string; order: number; lines: string[] };
  const entries: Entry[] = [];
  const text = (s: string, file: string) =>
    s.length > 1500 ? `${s.slice(0, 1500)}… (${s.length - 1500} more characters in ${file})` : s;
  for (const c of card.comments) {
    const q = card.questions.find((x) => x.seq === c.seq);
    let head = `#${c.seq} `;
    if (c.kind === "question")
      head += `question to ${c.to === "person" ? "the person" : c.to} ${q?.open ? "[OPEN]" : `[answered in #${q?.answeredBy.join(", #")}]`}`;
    else if (c.kind === "answer")
      head += `answer to #${c.answers ?? "?"}${c.by === "person" ? ", the person's" : ""}`;
    else head += "comment";
    head += ` | ${c.by === "person" && c.session !== "person" ? `written by ${who(c)}` : who(c)} | ${shortTime(c.at)}`;
    const lines = [
      head,
      ...text(c.text, c.file)
        .split("\n")
        .map((l) => `  ${l}`),
    ];
    if (c.artifacts.length)
      lines.push(`  made: ${c.artifacts.map((x) => `${x.type} ${x.ref}`).join(", ")}`);
    entries.push({ at: c.at, order: 0, lines });
  }
  for (const e of card.claims) {
    const verb: Record<string, string> = {
      claim: "claimed",
      release: "released",
      takeover: "took over",
      done: "marked done",
      cancel: "canceled",
    };
    const lines = [
      `-- ${who(e)} ${verb[e.event] ?? e.event} | ${shortTime(e.at)}${e.note ? ` | ${e.note}` : ""}`,
    ];
    if (e.body)
      lines.push(
        ...text(e.body, e.file)
          .split("\n")
          .map((l) => `  ${l}`),
      );
    if (e.artifacts.length)
      lines.push(`  made: ${e.artifacts.map((x) => `${x.type} ${x.ref}`).join(", ")}`);
    entries.push({ at: e.at, order: 1, lines });
  }
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order));
  const keep = entries.slice(-40);
  const out: string[] = [];
  if (entries.length > keep.length)
    out.push(`(${entries.length - keep.length} earlier entries are in ${path.dirname(card.file)})`);
  for (const e of keep) out.push(...e.lines);
  return out;
}

export function cardShow(ctx: Ctx, a: { card: string }): OpResult {
  needProject(ctx);
  const id = needCard(ctx, a.card);
  const card = readCard(ctx.root, id)!;
  const out: string[] = [`${card.id} ${card.status} | ${card.title}`];
  const last = card.claims[card.claims.length - 1] ?? null;
  if (card.holder && isHeld(last)) {
    const st = liveness(ctx, last!);
    const mine = card.holder.session === ctx.caller.session;
    out.push(
      `held by ${mine ? "you" : holderName(last!)} since ${shortTime(card.holder.since)}${mine ? "" : `. its process ${LIVE_WORDS[st]}`}`,
    );
  } else if (card.status === "todo") out.push("nobody holds it. card_claim takes it");
  const meta = [`created ${shortTime(card.at)} by ${who(card)}`];
  if (card.from) meta.push(`from ${card.from}`);
  if (card.needs.length) meta.push(`needs ${card.needs.join(", ")}`);
  out.push(meta.join(" | "));
  if (card.problems.length) out.push(`(this card file has problems: ${card.problems.join("; ")})`);
  out.push("", card.body || "(no description)");

  const concl = readConclusions(ctx.root).filter((c) => c.card === id);
  out.push("", `## thread (${card.comments.length} comments)`);
  const lines = threadLines(card);
  out.push(...(lines.length ? lines : ["(nothing yet)"]));
  if (concl.length) {
    out.push("", `## conclusions on this card (${concl.length})`);
    for (const c of concl)
      out.push(
        cut(
          `${c.id} ${c.kind}${c.by === "person" ? ", the person's" : ""}${c.superseded ? ` SUPERSEDED by ${c.replacedBy.join(",")}` : ""} | ${c.what}`,
          300,
        ),
        ...sourceLines(c),
      );
  }
  const others = readCards(ctx.root).filter((c) => c.id !== id);
  const links: string[] = [];
  for (const c of others) {
    if (c.from === id) links.push(`${c.id} was created from this card`);
    if (c.needs.includes(id)) links.push(`${c.id} needs this card`);
    for (const q of c.questions)
      if (q.open && q.to === id)
        links.push(
          `${c.id}#${q.seq} is an open question for this card's agent: ${cut(oneLine(q.text), 160)}`,
        );
  }
  if (links.length) out.push("", "## linked", ...links);
  return ok(out.join("\n"));
}

export function myCards(ctx: Ctx): OpResult {
  needProject(ctx);
  const c = ctx.caller;
  if (c.actor === "person") return ok("The person does not hold cards.");
  if (!c.session)
    return fail(
      "unavailable",
      `record unavailable: cannot tell which Claude session is calling (session: ${c.sessionSource}, process: ${c.pidSource}).`,
    );
  const myStart = c.pid ? procStart(c.pid) : "";
  const cards = readCards(ctx.root);
  const out: string[] = [you(ctx)];
  const mine: Card[] = [];
  const notes: string[] = [];
  for (const card of cards) {
    const last = card.claims[card.claims.length - 1] ?? null;
    if (isHeld(last) && last!.session === c.session) {
      mine.push(card);
      if (c.pid && (last!.pid !== c.pid || last!.pidStart !== myStart)) {
        // the session came back in a new process. write the new pid down, or others see a dead holder
        const done = writeClaim(
          ctx,
          card.id,
          last,
          "claim",
          { pid: c.pid, start: myStart },
          "same session, new process",
        );
        notes.push(
          done
            ? `${card.id}: claim refreshed, this session now runs in a new process.`
            : `${card.id}: its claim changed while refreshing. call card_show with card "${card.id}".`,
        );
      }
      continue;
    }
    if (!last) continue;
    // this session's last claim or takeover on the card. what someone else wrote after it ended its hold
    const myLast = card.claims
      .map((e) => e.session === c.session && (e.event === "claim" || e.event === "takeover"))
      .lastIndexOf(true);
    const after = card.claims.slice(myLast + 1);
    const ender = myLast >= 0 ? after.find((e) => e.session !== c.session) : undefined;
    const endedByMe = after.find((e) => e.session === c.session);
    if (ender && (!endedByMe || ender.seq < endedByMe.seq)) {
      const verb: Record<string, string> = {
        takeover: "took it over",
        release: "released it",
        cancel: "canceled it",
      };
      const now = isHeld(last)
        ? ` ${who(last)} holds it now.`
        : last.event === "cancel"
          ? ` It is canceled: ${cut(oneLine(last.body), 200)}.`
          : "";
      notes.push(
        `${card.id} is no longer yours: ${who(ender)} ${verb[ender.event] ?? ender.event} at ${shortTime(ender.at)}.${now} Stop working on it.`,
      );
      continue;
    }
    // held by this same claude process under an earlier session id: /clear was used
    if (
      isHeld(last) &&
      c.pid &&
      last.pid === c.pid &&
      last.pidStart === myStart &&
      last.session !== c.session
    ) {
      notes.push(
        `${card.id} is held by the session this window had before /clear (${last.session.slice(0, 8)}). It is not yours now. Ask the person whether to carry on with it. If yes, call card_takeover with card "${card.id}".`,
      );
    }
  }
  if (!mine.length) {
    const todo = cards.filter((x) => x.status === "todo").map((x) => x.id);
    out.push(
      `you hold no card. ${todo.length ? `todo and unclaimed: ${todo.slice(0, 12).join(", ")}${todo.length > 12 ? ` and ${todo.length - 12} more` : ""}. claim one with card_claim before you work on it` : 'there is no todo card. if the person just asked for something, record what they decided (conclusion_record, by "person") and put the work on a new card with card_create'}.`,
    );
  } else {
    out.push(`you hold ${mine.length} card${mine.length === 1 ? "" : "s"}:`);
  }
  const myIds = new Set(mine.map((x) => x.id));
  for (const card of mine) {
    out.push(
      `${card.id} in progress since ${shortTime(card.holder!.since)} | ${cut(card.title, 120)}`,
    );
    // everything before your own last record on the card counts as read
    let since = "";
    for (const x of [...card.comments, ...card.claims])
      if (x.session === c.session && x.at > since) since = x.at;
    const fresh = card.comments.filter((x) => x.session !== c.session && x.at > since);
    for (const x of fresh.slice(-5))
      out.push(
        cut(`  new ${describe(x)} | ${who(x)} | ${shortTime(x.at)} | ${oneLine(x.text)}`, 320),
      );
    if (fresh.length > 5)
      out.push(`  (${fresh.length - 5} more new comments. card_show with card "${card.id}")`);
    for (const q of card.questions.filter((x) => x.open && x.to === "person"))
      out.push(cut(`  still open, to the person: #${q.seq} ${oneLine(q.text)}`, 240));
    if (!fresh.length) out.push("  nothing new on it");
  }
  const forMe = cards.flatMap((x) =>
    x.questions.filter((q) => q.open && myIds.has(q.to) && q.session !== c.session),
  );
  if (forMe.length) {
    out.push("", "questions other agents left for you:");
    for (const q of forMe)
      out.push(
        cut(
          `${q.card}#${q.seq} for ${q.to} | ${who(q)} | ${shortTime(q.at)} | ${oneLine(q.text)}`,
          400,
        ),
        `  answer with question_answer: card "${q.card}", question ${q.seq}`,
      );
  }
  if (notes.length) out.push("", ...notes);
  return ok(out.join("\n"));
}

function describe(c: Comment): string {
  if (c.kind === "question")
    return `question #${c.seq} to ${c.to === "person" ? "the person" : c.to}`;
  if (c.kind === "answer")
    return `answer #${c.seq} to #${c.answers ?? "?"}${c.by === "person" ? " from the person" : ""}`;
  return `comment #${c.seq}`;
}

// ---------- the project file ----------

/** the exact bytes of .claude/grove-project.json. */
export function renderProjectFile(p: {
  name: string;
  prefix: string;
  goal: string;
  rev: number;
}): string {
  return `${JSON.stringify({ v: FORMAT_VERSION, name: p.name, prefix: p.prefix, goal: p.goal, rev: p.rev }, null, 2)}\n`;
}

export interface ProjectArgs {
  prefix: string;
  name?: string;
  goal?: string;
}

/**
 * write .claude/grove-project.json: what grove's sync calls, through syncProject. not a tool, so no
 * agent can change the goal or the prefix. name and goal are grove's own text, cut to fit rather
 * than refused, so a long goal never leaves a project without its file. the prefix cannot change
 * once a card exists, judged by the card folders on disk, not by the file a person may have deleted.
 */
export function projectInit(ctx: Ctx, a: ProjectArgs): OpResult {
  const p = paths(ctx.root);
  const prefix = normId(a.prefix);
  if (!PREFIX.test(prefix))
    fail(
      "invalid",
      `prefix "${a.prefix}" must be 1 to 8 letters or digits, starting with a letter.`,
    );
  if (prefix.length === 1 && "DFV".includes(prefix))
    fail(
      "invalid",
      `prefix "${prefix}" is taken by conclusion ids (D-1, F-1, V-1). Use two or more characters.`,
    );
  const before = readProject(ctx.root);
  const existing = listCardIds(ctx.root);
  const other = existing.filter((id) => !id.startsWith(`${prefix}-`));
  if (other.length)
    fail(
      "invalid",
      `this project already has cards with prefix ${other[0]!.split("-")[0]} (${other.length} of them). the prefix cannot change.`,
    );
  const next = {
    name: cut(oneLine(a.name ?? before?.name ?? ""), 200),
    prefix,
    goal: cut(oneLine(a.goal ?? before?.goal ?? ""), 2000),
    rev: 0,
  };
  const sound = !!before && !before.problems.length;
  if (
    sound &&
    before.name === next.name &&
    before.prefix === next.prefix &&
    before.goal === next.goal
  )
    return ok(`project unchanged. prefix ${prefix}, rev ${before.rev}`);
  // rev feeds the revision line and must never go back. a broken or missing file in a project that
  // already has records lost it, so jump to the clock in seconds, far above any count it had
  const lost =
    !sound && (listCardIds(ctx.root).length > 0 || listConclusionIds(ctx.root).length > 0);
  next.rev = lost
    ? Math.max(before?.rev ?? 0, Math.floor(Date.now() / 1000)) + 1
    : (before?.rev ?? 0) + 1;
  fs.mkdirSync(path.dirname(p.project), { recursive: true });
  const tmp = `${p.project}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, renderProjectFile(next));
  fs.renameSync(tmp, p.project); // replacing a file this writer owns: rename is the right primitive here
  return ok(`project ready. prefix ${prefix}, rev ${next.rev}`);
}
