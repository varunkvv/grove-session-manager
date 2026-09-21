import type { SessionView } from "../types.ts";

/** whitespace-separated tokens, lowercased. "quoted phrases" stay whole. */
export function tokenize(query: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (let m = re.exec(query); m; m = re.exec(query)) {
    const t = (m[1] ?? m[2] ?? "").toLowerCase().trim();
    if (t && t !== '"') tokens.push(t);
  }
  return tokens;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function haystack(v: SessionView): string {
  const cwd = v.relocatedCwd ?? v.cwd;
  return [
    v.title,
    v.firstPrompt,
    v.lastPrompt,
    v.comboName,
    v.gitBranch,
    cwd ? basename(cwd) : undefined,
    v.tag,
    v.pr ? `#${v.pr.number} ${v.pr.repo ?? ""}` : undefined,
    v.sessionId,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

const haystacks = new WeakMap<object, string>();

export function matchesTokens(v: SessionView, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  let hay = haystacks.get(v);
  if (hay === undefined) {
    hay = haystack(v);
    haystacks.set(v, hay);
  }
  return tokens.every((t) => hay.includes(t));
}

/** AND over tokens, substring match, input order kept - recency is the ranking */
export function searchSessions<T extends SessionView>(views: readonly T[], query: string): T[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [...views];
  return views.filter((v) => matchesTokens(v, tokens));
}

/** merged [start, end) ranges of every token inside `text`, for <mark> rendering */
export function highlightRanges(text: string, tokens: readonly string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  // some characters change length when lowercased. offsets would drift, so skip highlighting.
  if (lower.length !== text.length || tokens.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const t of tokens) {
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) {
      ranges.push([i, i + t.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** the part of a longer field that explains why a row matched, when the title alone does not */
export function snippetAround(
  text: string,
  tokens: readonly string[],
  radius = 48,
): string | undefined {
  const lower = text.toLowerCase();
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i < 0) continue;
    const start = Math.max(0, i - radius);
    const end = Math.min(text.length, i + t.length + radius);
    return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
  }
  return undefined;
}
