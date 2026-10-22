// the files a grove chat window may show: under its session's folders or the temp folder, and
// nowhere else. what asks for one is an agent's words, so the path is followed to where it really
// is before it is checked: a symlink cannot point out of the folders.
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** a session's scratchpad and the files it writes for a look are here. /tmp is a link to the second */
export const TEMP_ROOTS = ["/tmp", "/private/tmp"];

/** `file`, as it really is, when it is inside one of `roots`. null for anything else */
export async function within(roots: readonly string[], file: string): Promise<string | null> {
  if (!path.isAbsolute(file) || file.includes("\0")) return null;
  const real = await realpath(file).catch(() => null);
  if (!real) return null;
  for (const root of roots) {
    const top = await realpath(root).catch(() => null);
    if (top && real.startsWith(top + path.sep)) return real;
  }
  return null;
}

/** `<scheme>://<session id>/<path>`, as the page builds it, back into the two. null when it is not one */
export function sessionFileOf(url: string): { sessionId: string; file: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let file: string;
  try {
    file = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  return u.host ? { sessionId: u.host, file } : null;
}

/**
 * the bytes a `range: bytes=a-b` header asks for out of a file of `size`, both ends in, as a video
 * asks when it seeks. undefined: all of it (no header, or one this does not read, which the spec
 * says to ignore). null: none of it is there, a 416
 */
export function byteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | undefined {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  // `-n`: the last n bytes
  if (!m[1]) {
    const n = Number(m[2]);
    return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size - 1 } : null;
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : Number.POSITIVE_INFINITY;
  if (end < start) return undefined;
  return start < size ? { start, end: Math.min(end, size - 1) } : null;
}

/** what the viewer reads of a text file. past this it says how big it is */
export const READ_MAX = 2_000_000;

export type FileText = { text: string } | { binary: true; size: number } | { tooBig: number };

/** a file's text, unless it is binary or too big to show */
export async function readText(file: string): Promise<FileText> {
  const fh = await open(file, "r");
  try {
    const size = (await fh.stat()).size;
    if (size > READ_MAX) return { tooBig: size };
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    // a NUL in the start is a binary file's, never text's
    if (buf.subarray(0, 8000).includes(0)) return { binary: true, size };
    return { text: buf.toString("utf8") };
  } finally {
    await fh.close();
  }
}

/**
 * a folder's files, a few levels down: dot files, node_modules and any folder that is a repo of
 * its own are left out. what `@` offers in a folder that is no repo, a project's root
 */
export async function walkFiles(dir: string, max = 5000, depth = 4): Promise<string[]> {
  const out: string[] = [];
  async function walk(at: string, rel: string, left: number): Promise<void> {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile()) out.push(r);
      else if (e.isDirectory() && left > 0) {
        const full = path.join(at, e.name);
        if (!(await stat(path.join(full, ".git")).catch(() => null))) await walk(full, r, left - 1);
      }
    }
  }
  await walk(dir, "", depth);
  return out;
}

/** the files under a folder, newest first, no more than `max`: a project's plans/ and artifacts/ */
export async function listFiles(dir: string, max = 300): Promise<string[]> {
  const files = (await walkFiles(dir, 2000, 3)).map((f) => path.join(dir, f));
  const dated = await Promise.all(
    files.map(async (f) => ({ f, at: (await stat(f).catch(() => null))?.mtimeMs ?? 0 })),
  );
  return dated
    .sort((a, b) => b.at - a.at)
    .slice(0, max)
    .map((x) => x.f);
}
