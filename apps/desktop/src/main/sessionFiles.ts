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
 * the files under a folder, newest first, a few levels down and no more than `max`: a project's
 * plans/ and artifacts/. dot files and folders are left out
 */
export async function listFiles(dir: string, max = 300): Promise<string[]> {
  // ponytail: readdir walks the whole tree before the depth cut. a walker that stops at depth 4 if
  // someone keeps a node_modules in artifacts/
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => {
      const rel = path.relative(dir, f).split(path.sep);
      return rel.length <= 4 && !rel.some((p) => p.startsWith("."));
    });
  const dated = await Promise.all(
    files
      .slice(0, 2000)
      .map(async (f) => ({ f, at: (await stat(f).catch(() => null))?.mtimeMs ?? 0 })),
  );
  return dated
    .sort((a, b) => b.at - a.at)
    .slice(0, max)
    .map((x) => x.f);
}
