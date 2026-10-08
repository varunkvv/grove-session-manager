// the refresher of a session: four lines a small model writes from a digest of the conversation.
// pure: the digest, the prompt and the parse. the call and the cache are the app's.
import { squash } from "../transcript/title.ts";
import { answerSteps, type ConversationState, EDITS, type Turn } from "./conversation.ts";
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
    const answer = answerSteps(work).flatMap((n) => {
      const step = work.steps[n];
      return step?.kind === "text" ? [step.text] : [];
    });
    const said = work.steps.findLast((s) => s.kind === "text");
    const text = answer.length ? answer.join("\n\n") : said?.kind === "text" ? said.text : "";
    if (!text) continue;
    if (i < asked) {
      return { text, what: "the message it ended on BEFORE the person last typed:", stale: true };
    }
    return {
      text,
      // a background task's news starts a turn of its own, often one with nothing said in it:
      // the message before it is still the last thing the person was told
      what: answer.length
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
export function recapDigest(
  state: ConversationState,
  o: { title?: string; now?: string } = {},
): string {
  const turns = turnsOf(state);
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

  const out = [`title: ${o.title ? squash(o.title, 200) : "(none)"}`, ""];
  out.push("what the person typed, oldest first:");
  const line = (text: string, i: number) => `  - ${squash(text, i === 0 ? FIRST_PROMPT : PROMPT)}`;
  if (typed.length <= FIRST + LAST) out.push(...typed.map(line));
  else {
    out.push(...typed.slice(0, FIRST).map(line));
    out.push(`  … ${typed.length - FIRST - LAST} more …`);
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
