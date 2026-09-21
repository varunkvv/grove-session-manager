export interface WorktreeEntry {
  path: string;
  head?: string;
  /** full ref, e.g. refs/heads/main */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason?: string;
  prunable: boolean;
  prunableReason?: string;
  isMain: boolean;
}

const HEADS = "refs/heads/";

export function shortBranch(ref: string): string {
  return ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref;
}

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** git's C-style quoting. only the newline form quotes, and only a lock reason with odd characters. */
function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const body = value.slice(1, -1);
  let i = 0;
  while (i < body.length) {
    const slash = body.indexOf("\\", i);
    // plain runs are encoded whole so a surrogate pair is never split
    const end = slash < 0 ? body.length : slash;
    if (end > i) bytes.push(...encoder.encode(body.slice(i, end)));
    if (slash < 0) break;
    const octal = /^[0-3][0-7]{2}/.exec(body.slice(slash + 1, slash + 4))?.[0];
    const simple = SIMPLE_ESCAPES[body[slash + 1] ?? ""];
    if (octal) bytes.push(Number.parseInt(octal, 8));
    else if (simple !== undefined) bytes.push(simple);
    else return value;
    i = slash + (octal ? 4 : 2);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * `git worktree list --porcelain -z`: NUL-separated attributes, an empty token ends a record,
 * the first record is the main worktree. the newline form is accepted too. unknown attributes
 * are skipped so a newer git cannot break this.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const nul = stdout.includes("\0");
  const tokens = nul ? stdout.split("\0") : stdout.split(/\r?\n/);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const token of tokens) {
    if (token === "") {
      current = undefined;
      continue;
    }
    const space = token.indexOf(" ");
    const key = space < 0 ? token : token.slice(0, space);
    const value = space < 0 ? "" : token.slice(space + 1);
    if (key === "worktree") {
      current = {
        path: value,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        isMain: entries.length === 0,
      };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") {
      current.locked = true;
      if (value) current.lockedReason = nul ? value : unquote(value);
    } else if (key === "prunable") {
      current.prunable = true;
      if (value) current.prunableReason = value;
    }
  }
  return entries;
}
