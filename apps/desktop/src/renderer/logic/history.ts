// the composer's prompt history: up walks back through what was said in this session, down walks
// forward and, past the newest, gives back what was being typed. as a shell and Claude Code do.

/** where a walk is: the entry shown, and the draft it started from */
export interface Walk {
  at: number;
  draft: string;
}

/**
 * up or down from where the walk is. `prompts` oldest first. null: the key is not the history's
 * (nothing older, or no walk to go down from) and moves the caret as usual
 */
export function walk(
  prompts: readonly string[],
  was: Walk | null,
  draft: string,
  up: boolean,
): { walk: Walk | null; text: string } | null {
  if (up) {
    const at = (was?.at ?? prompts.length) - 1;
    if (at < 0) return null;
    return { walk: { at, draft: was?.draft ?? draft }, text: prompts[at] ?? "" };
  }
  if (!was) return null;
  const at = was.at + 1;
  if (at >= prompts.length) return { walk: null, text: was.draft };
  return { walk: { at, draft: was.draft }, text: prompts[at] ?? "" };
}
