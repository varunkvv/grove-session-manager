// the files grove chat keeps for claude to read: a clone of one attached from outside the session's
// folders, so it still reads after it is moved or deleted, and the bytes of a paste with no file
// behind it. one folder per session under electron's userData, not the state dir: that one may be
// cleared at any time, and an old read cleared from claude's context is only safe while the file is
// still there to read again
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ChatAttachment } from "../../shared/ipc.ts";
import { log } from "../log.ts";
import { within } from "../sessionFiles.ts";

const run = promisify(execFile);

/** a file as it goes to claude: an image inline, anything else by a path claude can read */
export type Placed =
  | Extract<ChatAttachment, { kind: "image" }>
  | {
      kind: "file";
      name: string;
      path: string;
      mediaType: string;
      size: number;
      /** where it was when it was sent: this is grove's copy of it */
      copyOf?: string;
    };

const taken = (at: string) =>
  stat(at).then(
    () => true,
    (e: NodeJS.ErrnoException) => e.code !== "ENOENT",
  );

/**
 * a place for `name` in `dir` that is no other file's: dir/name, else dir/2/name and on. the name
 * stays its own, which is how the message's header names it. two pasted screenshots are both
 * image.png
 */
export async function freePath(dir: string, name: string): Promise<string> {
  const base = path.basename(name);
  const own = base && base !== "." && base !== ".." ? base : "file";
  for (let k = 1; k < 1000; k++) {
    const at = k === 1 ? path.join(dir, own) : path.join(dir, String(k), own);
    // a file called "2" where the folder would go: the next one
    if (
      !(await mkdir(path.dirname(at), { recursive: true }).then(
        () => true,
        () => false,
      ))
    ) {
      continue;
    }
    if (!(await taken(at))) return at;
  }
  throw new Error(`No room for ${own} in ${dir}.`);
}

/**
 * `file` cloned into `dir`: `cp -c` clones on APFS (no disk used while the original is there) and
 * copies in full where it cannot. node's COPYFILE_FICLONE does a full copy on macOS (measured)
 */
export async function cloneInto(dir: string, file: string): Promise<string> {
  const to = await freePath(dir, path.basename(file));
  await run("/bin/cp", ["-c", file, to]);
  return to;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * a message's files, put where claude reads them. one in the session's folders goes by its own
 * path, one from anywhere else as a clone in `dir`, a paste's bytes written there. `queued`: typed
 * mid-turn, where claude code drops documents and sends images unshrunk (probe), so an image goes
 * by a path too
 */
export async function place(
  files: ChatAttachment[],
  o: { roots: string[]; dir: string; queued: boolean },
): Promise<Placed[]> {
  const out: Placed[] = [];
  // one after another: two of the same name each get their own place
  for (const f of files) {
    if (f.kind === "image" && !o.queued) {
      out.push(f);
      continue;
    }
    if (f.kind === "file") {
      if (await within(o.roots, f.path)) {
        out.push(f);
        continue;
      }
      // refused (a privacy prompt said no, the disk is full): by its own path, as 0.26 sent it
      const copy = await cloneInto(o.dir, f.path).catch((e: unknown) => {
        log.warn(`could not copy ${f.name} for claude:`, e);
        return null;
      });
      out.push(copy ? { ...f, path: copy, copyOf: f.path } : f);
      continue;
    }
    const bytes = Buffer.from(f.data, "base64");
    const name = f.name ?? (f.kind === "image" ? `image.${EXT[f.mediaType] ?? "png"}` : "file");
    const at = await freePath(o.dir, name);
    await writeFile(at, bytes, { flag: "wx" });
    out.push({
      kind: "file",
      name: path.basename(at),
      path: at,
      mediaType: f.mediaType,
      size: bytes.length,
    });
  }
  return out;
}

/** whether `bin` is on this PATH, as claude would find it */
export async function onPath(bin: string, envPath: string | undefined): Promise<boolean> {
  for (const dir of (envPath ?? "").split(":").filter(Boolean)) {
    const ok = await access(path.join(dir, bin), constants.X_OK).then(
      () => true,
      () => false,
    );
    if (ok) return true;
  }
  return false;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * a session's uploads go once its transcript has (claude code deletes them after
 * cleanupPeriodDays). no age limit: a clone costs nothing while its original is there. nothing goes
 * when the transcripts cannot all be listed, or there are none: a config dir moved or unreadable
 * would take every upload with it. returns the sessions whose folders went
 */
export async function sweepUploads(root: string, projectsDir: string): Promise<string[]> {
  const folders = (await readdir(root).catch(() => [])).filter((f) => SESSION_ID.test(f));
  if (folders.length === 0) return [];
  const kept = new Set<string>();
  try {
    for (const p of await readdir(projectsDir, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      for (const f of await readdir(path.join(projectsDir, p.name))) {
        if (f.endsWith(".jsonl")) kept.add(f.slice(0, -".jsonl".length));
      }
    }
  } catch {
    return [];
  }
  if (kept.size === 0) return [];
  const gone = folders.filter((id) => !kept.has(id));
  await Promise.all(gone.map((id) => rm(path.join(root, id), { recursive: true, force: true })));
  return gone;
}
