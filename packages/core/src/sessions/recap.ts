// the refresher of a session: four lines a small model writes from a digest of the conversation.
// and from the same digest its name: a title and a one-line description.
// pure: the digest, the prompts and the parses. the calls and the caches are the app's.
import { squash } from "../transcript/title.ts";
import { answerOf, type ConversationState, EDITS, type Turn } from "./conversation.ts";
import { toolLabel } from "./timeline.ts";

/** what the person reads before going back to a session */
export interface Recap {
  /** what they wanted from it */
  goal: string;
  /** what the agent did */
  done: string;
  /** where it stands */
  state: string;
  /** what they have to do or decide, or nothing */
  needs: string;
}

export const RECAP_LABELS = ["goal", "done", "state", "needs"] as const;
/** a line is a sentence or two. past this the model did not do as asked, and the rest is cut */
export const RECAP_LINE_MAX = 300;

/** the digest's budget, about 12KB with the instructions: each part's share of it */
const FIRST_PROMPT = 600;
const PROMPT = 300;
const FIRST = 3;
const LAST = 8;
const SUMMARY = 2000;
const FILES = 30;
const TOOLS = 20;
const TOOL = 90;
const ENDING_HEAD = 800;
const ENDING_TAIL = 2700;
const ASKED = 600;

const INSTRUCTIONS = `Below is a digest of one Claude Code session: a coding agent working for a person. The person runs many of these at once and has forgotten this one. Write the refresher they read before going back to it.

Reply with exactly these four lines and nothing else. Plain words, no markdown, no preamble. Say what is specific to this session: name the feature, the file, the bug. Go by the digest alone, and by its end over its start: the last things typed and the message it ended on are where the session is now.

goal: what the person wanted from this session, in at most 20 words
done: what the agent did, in at most 40 words. the outcome, not the steps
state: where it stands now, in at most 25 words. finished, blocked, waiting, or stopped half way through what
needs: what the person has to do or decide now, in at most 30 words. only what the session waits on them for, not later work. "nothing" if nothing
`;

const turnsOf = (state: ConversationState): Turn[] =>
  state.items.filter((i): i is Turn => i.kind === "turn");

/**
 * the last thing the agent wrote, and what it is: the message the last turn ended on, something
 * said part way through the work since the person last typed (`asked`), or the message an earlier
 * turn ended on, when it has said nothing since
 */
function ending(
  turns: readonly Turn[],
  asked: number,
): { text: string; what: string; stale?: boolean } | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const work = turns[i]!.work;
    const answer = answerOf(work);
    const said = work.steps.findLast((s) => s.kind === "text");
    const text = answer || (said?.kind === "text" ? said.text : "");
    if (!text) continue;
    if (i < asked) {
      return { text, what: "the message it ended on BEFORE the person last typed:", stale: true };
    }
    return {
      text,
      // a background task's news starts a turn of its own, often one with nothing said in it:
      // the message before it is still the last thing the person was told
      what: answer
        ? "the message its last turn ended on:"
        : "its last turn did not end on a message. the last thing it said in it:",
    };
  }
  return undefined;
}

/**
 * what a recap is written from: what the person typed, Claude Code's own summary of the part it
 * compacted away, the files edited, the last turn's tool calls and the message it ended on. a
 * tool's output is never in it. every part is the session's own words, so all of it is untrusted
 */
/** what the person typed, oldest first, the files edited, and the newest turn the person started */
function gather(turns: readonly Turn[]): { typed: string[]; files: Set<string>; asked: number } {
  const typed: string[] = [];
  const files = new Set<string>();
  /** the newest turn the person started. what came after it is still that turn's work */
  let asked = 0;
  turns.forEach((turn, i) => {
    const p = turn.prompt;
    // `/model` alone says nothing. `/loop watch the rollout` is the person's words
    if (p?.kind === "human" || (p?.kind === "command" && p.text.includes(" "))) {
      typed.push(p.text);
      asked = i;
    }
    for (const m of turn.marks) if (m.kind === "said") typed.push(m.text);
    for (const s of turn.work.steps) {
      if (s.kind !== "tool" || !EDITS.has(s.name) || !s.target) continue;
      const name = s.target.slice(s.target.lastIndexOf("/") + 1);
      // the newest edit last
      files.delete(name);
      files.add(name);
    }
  });
  return { typed, files, asked };
}

export function recapDigest(
  state: ConversationState,
  o: {
    title?: string;
    description?: string;
    now?: string;
    /** this many of the prompts between the first and the last few, spread evenly */
    middle?: number;
  } = {},
): string {
  const turns = turnsOf(state);
  const { typed, files, asked } = gather(turns);

  const out = [`title: ${o.title ? squash(o.title, 200) : "(none)"}`];
  if (o.description) out.push(`description: ${squash(o.description, 300)}`);
  out.push("", "what the person typed, oldest first:");
  const line = (text: string, i: number) => `  - ${squash(text, i === 0 ? FIRST_PROMPT : PROMPT)}`;
  if (typed.length <= FIRST + LAST) out.push(...typed.map(line));
  else {
    out.push(...typed.slice(0, FIRST).map(line));
    const between = typed.slice(FIRST, -LAST);
    const k = Math.min(o.middle ?? 0, between.length);
    if (k === 0) out.push(`  … ${between.length} more …`);
    else if (k === between.length) out.push(...between.map((t) => line(t, 1)));
    else {
      out.push(`  … ${between.length} more. ${k} of them, spread evenly:`);
      for (let i = 0; i < k; i++) {
        out.push(line(between[Math.floor(((i + 0.5) * between.length) / k)] ?? "", 1));
      }
      out.push("  …");
    }
    out.push(...typed.slice(-LAST).map((t) => line(t, 1)));
  }
  if (typed.length === 0) out.push("  (nothing)");

  const summary = state.items.findLast((i) => i.kind === "compact" && i.summary);
  if (summary?.kind === "compact" && summary.summary) {
    // past Claude Code's own preamble: what was asked for comes first in it
    const at = summary.summary.indexOf("Summary:");
    out.push("", "claude code's own summary of the earlier part of the session:");
    out.push(squash(at < 0 ? summary.summary : summary.summary.slice(at + 8), SUMMARY));
  }
  if (files.size) out.push("", `files it edited: ${[...files].slice(-FILES).join(", ")}`);

  const last = turns.slice(asked);
  const tools = last.flatMap((t) =>
    t.work.steps.flatMap((s) =>
      s.kind === "tool" && !s.server ? [squash(`${toolLabel(s.name)} ${s.target}`, TOOL)] : [],
    ),
  );
  if (tools.length) {
    out.push("", `its last turn (${tools.length} tool calls). the last of them:`);
    out.push(...tools.slice(-TOOLS).map((t) => `  ${t}`));
  }
  const end = ending(turns, asked);
  if (end) {
    // an older message is context, not where the session is: it gets less room, and the last word
    // goes to what the person typed after it
    const [head, tail] = end.stale ? [300, 900] : [ENDING_HEAD, ENDING_TAIL];
    out.push("", end.what);
    out.push(
      end.text.length <= head + tail
        ? end.text
        : `${end.text.slice(0, head)}\n…\n${end.text.slice(-tail)}`,
    );
    if (end.stale) {
      out.push(
        "",
        `the person answered that with the last thing they typed: ${squash(typed.at(-1) ?? "", PROMPT)}`,
        "it has not said anything since. what that message asked is settled, and their answer is what it was working on.",
      );
    }
  }

  // what it put to the person and has no answer to yet
  const open = turns.at(-1);
  for (const m of open?.marks ?? []) {
    if (m.kind === "plan" && !m.outcome) {
      out.push(
        "",
        `it proposed a plan and waits for the person to approve it: ${squash(m.text, ASKED)}`,
      );
    } else if (m.kind === "question" && !m.declined && m.questions.some((q) => !q.picked)) {
      const asks = m.questions.map((q) =>
        q.options.length ? `${q.question} (${q.options.join(" / ")})` : q.question,
      );
      out.push("", `it asked the person, who has not answered: ${squash(asks.join(" "), ASKED)}`);
    }
  }
  const error = open?.apiError ?? open?.work.last?.error;
  if (error) out.push("", `its last turn stopped on an error: ${squash(error, 200)}`);
  if (open?.work.interrupted) out.push("", "its last turn was interrupted before it finished.");
  if (o.now) out.push("", `right now: ${squash(o.now, 300)}`);
  return out.join("\n");
}

export const recapPrompt = (digest: string): string => `${INSTRUCTIONS}\n${digest}\n`;

/**
 * the four labelled lines, each cut at RECAP_LINE_MAX. anything else is no recap: what the model
 * said is drawn as it is, so an answer that is not the four lines is never shown
 */
export function parseRecap(answer: string): Recap | null {
  const lines = answer
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== RECAP_LABELS.length) return null;
  const out: Partial<Recap> = {};
  for (const [i, label] of RECAP_LABELS.entries()) {
    const m = new RegExp(`^${label}:\\s*(\\S.*)$`, "i").exec(lines[i] ?? "");
    if (!m?.[1]) return null;
    out[label] = squash(m[1], RECAP_LINE_MAX);
  }
  return out as Recap;
}

/**
 * the one line of a recap a row has room for: what the person has to do. when that is nothing,
 * where the session stands says more than the word
 */
export function recapLine(r: Recap): string {
  return /^(nothing|none|n\/a)\b[.!]?$/i.test(r.needs) ? r.state : r.needs;
}

// ---------- a session's name: a title and a one-line description

/** what a list tells sessions apart by */
export interface SessionName {
  title: string;
  description: string;
}

/** past these the model did not do as asked, and the rest is cut */
const NAME_TITLE_MAX = 60;
const NAME_DESCRIPTION_MAX = 200;
/** the prompts from the middle of a long session the title call also sees */
const NAME_MIDDLE = 10;
const SIBLINGS = 30;

const NAME_INSTRUCTIONS = `Below is a digest of one Claude Code session: a coding agent working for a person. They run many sessions at once and tell them apart in a list by a title and a one-line description. Name this session.

Reply with exactly these two lines and nothing else. Plain words, no markdown, no quotes, no preamble.

title: 3 to 7 words, under 50 characters, in sentence case: a capital first letter, the rest lower case except names
description: one sentence, under 140 characters: what the session is for and how far it reaches

The title names the whole session, never only its latest turn: a session that started on a flaky test and turned into a release is the release. Say what is specific to it: the feature, the file, the bug, never "Coding session" or "Bug fix". Never give it the title of one of the person's other sessions listed below. Go by the digest alone.
`;

const NAME_KEEP = `It already has the title and the description at the top of the digest. Keep them unless the work has clearly outgrown them. When one changes it gets broader, never narrower. Keeping both is the normal answer: then reply with the single word same.
`;

/** how far a session has come, for when its name is looked at again */
export interface NameLook {
  /** what the person typed: prompts, and what they said while it worked */
  prompts: number;
  /** times it was compacted */
  compacts: number;
  /** a turn called a tool. a "hey" with no work gets no name: Claude Code's own title covers it */
  worked: boolean;
}

export function nameLook(state: ConversationState): NameLook {
  const turns = turnsOf(state);
  return {
    prompts: gather(turns).typed.length,
    compacts: state.items.filter((i) => i.kind === "compact").length,
    worked: turns.some((t) => t.work.toolCount > 0),
  };
}

/**
 * whether a session's name is due a look: the first once it has done some work, then each time
 * the prompts have doubled (at about 1, 3, 6, 12, 24 ... prompts), and after a compaction. so a
 * name changes less often the longer a session runs
 */
export function nameDue(
  last: Pick<NameLook, "prompts" | "compacts"> | undefined,
  now: NameLook,
): boolean {
  if (!last) return now.worked;
  return now.prompts >= Math.max(3, last.prompts * 2) || now.compacts > last.compacts;
}

/**
 * what the title call is sent: the recap's digest with prompts from the middle too, where the
 * session is, and what the person's other recent sessions there are called. with `current` the
 * model is asked to keep it
 */
export function namePrompt(
  state: ConversationState,
  o: {
    current?: SessionName;
    project?: string;
    branch?: string;
    /** the titles of the other sessions in its project from the last week */
    siblings?: readonly string[];
  } = {},
): string {
  const out = [NAME_INSTRUCTIONS];
  if (o.current) out.push(NAME_KEEP);
  if (o.project) out.push(`project: ${squash(o.project, 100)}`);
  if (o.branch) out.push(`branch: ${squash(o.branch, 100)}`);
  const siblings = [...new Set(o.siblings ?? [])].slice(0, SIBLINGS);
  out.push(
    "the person's other sessions here from the last week:",
    ...(siblings.length ? siblings.map((t) => `  - ${squash(t, 100)}`) : ["  (none)"]),
    "",
    recapDigest(state, {
      title: o.current?.title,
      description: o.current?.description,
      middle: NAME_MIDDLE,
    }),
  );
  return `${out.join("\n")}\n`;
}

/** a line's value without the quotes or the full stop a model puts round a name */
const bare = (v: string) =>
  v
    .trim()
    .replace(/^["'`*]+|["'`*]+$/g, "")
    .replace(/(?<!\.)\.$/, "")
    .trim();

const SAME = /^same\.?$/i;

/**
 * the answer: `{}` when it says same, a new title or description or both, null when it is
 * anything else. what a model said is drawn as it is, so only the two labelled lines count
 */
export function parseName(answer: string): Partial<SessionName> | null {
  const lines = answer
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 1 && SAME.test(bare(lines[0] ?? ""))) return {};
  if (lines.length !== 2) return null;
  const title = /^title:\s*(\S.*)$/i.exec(lines[0] ?? "")?.[1];
  const description = /^description:\s*(\S.*)$/i.exec(lines[1] ?? "")?.[1];
  if (!title || !description) return null;
  const out: Partial<SessionName> = {};
  if (!SAME.test(bare(title))) out.title = squash(bare(title), NAME_TITLE_MAX);
  // a description is a sentence: its full stop stays
  if (!SAME.test(bare(description))) {
    out.description = squash(description.replace(/^["'`]+|["'`]+$/g, ""), NAME_DESCRIPTION_MAX);
  }
  return out.title === "" || out.description === "" ? null : out;
}
