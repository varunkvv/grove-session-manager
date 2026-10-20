// the scorer tests use instead of a model: a level per question from a few words in the text, so a
// fixture's made-up prompts decide what gavel thinks. never a real model in a test (the plan's rule).
import type { Probs, Rubric } from "./rubric.ts";

type Rule = [RegExp, number];

/** checked in order, the first that matches is the level */
const RULES: Record<string, Rule[]> = {
  deference: [
    [/\b(your call|you decide|you know (this|it) better|whatever you think)\b/i, 4],
    [/^(no|wrong|nope)\b|\b(redo|undo) (it|that)\b|\bdo it again\b/i, 0],
    [/\?|\b(please|could you|can you|would you)\b/i, 3],
    [/\b(because|since)\b| - /i, 2],
  ],
  gratitude: [
    [/\b(brilliant|legend|saved me)\b/i, 4],
    [/\b(good catch|i like how|nicely done)\b/i, 3],
    [/\b(thanks|thank you|nice|great|perfect)\b/i, 2],
    [/^(ok|okay|cool|got it|alright|yep)\b/i, 1],
  ],
  blame: [
    [/\b(garbage|wow great job|useless)\b|\b[A-Z]{4,}( [A-Z]{2,})+\b/, 4],
    [/\b(you broke|i already told you|why did you|you ignored)\b/i, 3],
    [/\b(too long|too wordy|not right|isn't right|wrong)\b/i, 2],
    [/\b(error|failing|fails|broken|red)\b/i, 1],
  ],
};

const DEFAULT: Record<string, number> = { deference: 1, gratitude: 0, blame: 0 };

/** the level the stub gives a question */
export function stubLevel(question: string, text: string): number {
  for (const [re, level] of RULES[question] ?? []) if (re.test(text)) return level;
  return DEFAULT[question] ?? 0;
}

/** most of the weight on the stub's level, the rest spread thin, like a confident model */
export function stubScore(rubric: Rubric, text: string): Probs {
  const out: Probs = {};
  for (const q of rubric.questions) {
    const k = q.criteria.length;
    const level = stubLevel(q.id, text);
    out[q.id] = q.criteria.map((_, i) => (i === level ? 0.9 : 0.1 / (k - 1)));
  }
  return out;
}
