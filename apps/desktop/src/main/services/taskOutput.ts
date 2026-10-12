// the last thing a background command or a Monitor wrote, for its row. Claude Code keeps each
// one's output in a temp file. where is observed, not documented: when the file is not there the
// row has no status line, and nothing else changes.
import { open } from "node:fs/promises";
import path from "node:path";

/**
 * `<tmp>/claude-<uid>`, where Claude Code keeps what a session writes aside. `<tmp>` is
 * CLAUDE_CODE_TMPDIR, else /tmp: read in the 2.1.295 binary, which joins the two the same way
 */
export function claudeTmpRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CODE_TMPDIR || "/tmp", `claude-${process.getuid?.() ?? 0}`);
}

/** a transcript folder's name, a session id and a task id are each one path segment of these */
const SEGMENT = /^[\w-]+$/;

/**
 * where a command's output is: `<root>/<transcript folder>/<session id>/tasks/<task id>.output`.
 * undefined when a name could not be one folder: they come from a hook payload
 */
export function taskOutputFile(
  root: string,
  slug: string,
  sessionId: string,
  taskId: string,
): string | undefined {
  if (![slug, sessionId, taskId].every((s) => SEGMENT.test(s))) return undefined;
  return path.join(root, slug, sessionId, "tasks", `${taskId}.output`);
}

const TAIL_BYTES = 4096;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** colours and cursor moves, and the sequences that set a title or a link */
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\))`,
  "g",
);

/**
 * the last line a file ends on, plain and cut to 200 characters. a progress bar redraws its line
 * with a bare carriage return, so that ends a line too. a missing file is undefined, never an error
 */
export async function lastLine(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    return buffer
      .toString("utf8")
      .replace(ANSI, "")
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1)
      ?.slice(0, 200);
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}
