// the files a grove chat window may show: under its session's folders or the temp folder, and
// nowhere else. what asks for one is an agent's words, so the path is followed to where it really
// is before it is checked: a symlink cannot point out of the folders.
import { realpath } from "node:fs/promises";
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
