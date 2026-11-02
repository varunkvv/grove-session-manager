export type IndexedFile = {
  /** absolute path */
  path: string;
  /** epoch ms of the last time this session touched the file; undefined if never touched */
  touchedAt?: number;
  edited?: boolean;
};

const TRAILING_LOC = /:\d+(:\d+)?$/;

/** the line in a trailing `:N` or `:N:M` token, or undefined when there is none. */
export function fileLine(token: string): number | undefined {
  const m = /:(\d+)(?::\d+)?$/.exec(token);
  return m ? Number(m[1]) : undefined;
}

/**
 * resolves a relative file reference (`a/b.ts`, `b.ts`, `./a/b.ts`, `b.ts:42`) against the
 * session's files. null when it cannot be resolved to exactly one file: a wrong guess is worse
 * than no link.
 */
export function resolveFileRef(token: string, files: readonly IndexedFile[]): string | null {
  const t = token.replace(TRAILING_LOC, "").replace(/^\.\//, "");
  if (!t || t.startsWith("~") || t.includes("..")) return null;
  // an absolute path links only when it is exactly a file the session has
  if (t.startsWith("/")) return files.some((f) => f.path === t) ? t : null;

  const candidates = files.filter((f) => f.path === t || f.path.endsWith(`/${t}`));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]?.path ?? null;

  const touched = candidates.filter(
    (f): f is IndexedFile & { touchedAt: number } => f.touchedAt !== undefined,
  );
  if (touched.length === 0) return null;

  const latest = Math.max(...touched.map((f) => f.touchedAt));
  const top = new Set(touched.filter((f) => f.touchedAt === latest).map((f) => f.path));
  return top.size === 1 ? ([...top][0] ?? null) : null;
}
