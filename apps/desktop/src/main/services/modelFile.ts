// the decisioning model's weights on disk: fetched once, resumed where a download stopped, kept
// only when they hash to the pinned sha256. the request is a GET of a fixed URL and sends nothing.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelEntry } from "@grove/core";

/** what a model is downloaded and checked against: the registry entry, or a test root's stand-in */
export type ModelFile = Pick<ModelEntry, "file" | "sha256" | "size">;

/** room left on the disk after the download, so it never fills it */
const MARGIN = 512 * 1024 * 1024;
const PROGRESS_MS = 250;

export const weightsPath = (dir: string, m: ModelFile): string => path.join(dir, m.file);
const partPath = (dir: string, m: ModelFile) => `${weightsPath(dir, m)}.part`;
/** written after the hash matched: the weights are not hashed again on every start */
const okPath = (dir: string, m: ModelFile) => `${weightsPath(dir, m)}.sha256`;

const sizeOf = (file: string) =>
  stat(file).then(
    (s) => s.size,
    () => 0,
  );

/** whole, and checked */
export async function modelReady(dir: string, m: ModelFile): Promise<boolean> {
  if ((await sizeOf(weightsPath(dir, m))) !== m.size) return false;
  const ok = await readFile(okPath(dir, m), "utf8").catch(() => "");
  return ok.trim() === m.sha256;
}

/** how much of it is on disk: the whole file, or the part a download stopped at */
export async function modelBytes(dir: string, m: ModelFile): Promise<number> {
  return (await modelReady(dir, m)) ? m.size : sizeOf(partPath(dir, m));
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class DownloadError extends Error {
  readonly code: "disk" | "http" | "mismatch" | "aborted";
  constructor(code: DownloadError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface DownloadOptions {
  dir: string;
  model: ModelFile;
  url: string;
  /** electron's net.fetch in the app: chromium's networking, and the system proxy */
  fetch: (
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal },
  ) => Promise<Response>;
  onProgress?: (got: number) => void;
  signal?: AbortSignal;
  /** bytes free where the weights go. statfs unless a test says */
  free?: (dir: string) => Promise<number>;
}

const freeBytes = async (dir: string): Promise<number> => {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
};

/**
 * the weights, from where the last try stopped. the hash is checked over the whole file at the
 * end, so a resume over a changed file is caught too. a file that does not match is thrown away
 */
export async function downloadModel(o: DownloadOptions): Promise<void> {
  const { dir, model } = o;
  await mkdir(dir, { recursive: true });
  if (await modelReady(dir, model)) return;
  const part = partPath(dir, model);
  let have = await sizeOf(part);
  if (have > model.size) {
    await unlink(part).catch(() => {});
    have = 0;
  }
  const free = await (o.free ?? freeBytes)(dir);
  if (free < model.size - have + MARGIN) {
    const gb = (n: number) => (n / 1e9).toFixed(1);
    throw new DownloadError(
      "disk",
      `Not enough disk space: the model needs ${gb(model.size - have)} GB and ${gb(free)} GB is free.`,
    );
  }

  if (have < model.size) {
    const res = await o
      .fetch(o.url, {
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
        ...(o.signal ? { signal: o.signal } : {}),
      })
      .catch((e: unknown) => {
        if (o.signal?.aborted) throw new DownloadError("aborted", "The download was stopped.");
        throw new DownloadError("http", `The download could not start: ${String(e)}`);
      });
    if (res.status === 200) have = 0;
    else if (res.status !== 206) {
      throw new DownloadError("http", `The model's server answered ${res.status}.`);
    }
    if (!res.body) throw new DownloadError("http", "The model's server sent nothing.");
    const fh = await open(part, have === 0 ? "w" : "a");
    let last = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        await fh.write(chunk);
        have += chunk.byteLength;
        if (have > model.size)
          throw new DownloadError("mismatch", "The download is bigger than the model.");
        const now = Date.now();
        if (now - last >= PROGRESS_MS) {
          last = now;
          o.onProgress?.(have);
        }
      }
    } catch (e) {
      if (e instanceof DownloadError) throw e;
      if (o.signal?.aborted) throw new DownloadError("aborted", "The download was stopped.");
      throw new DownloadError("http", `The download stopped: ${String(e)}`);
    } finally {
      await fh.close();
    }
    o.onProgress?.(have);
    if (have < model.size) throw new DownloadError("http", "The download stopped before the end.");
  }

  const sum = await sha256Of(part);
  if (sum !== model.sha256) {
    await unlink(part).catch(() => {});
    throw new DownloadError(
      "mismatch",
      "The download did not match the model. It was thrown away.",
    );
  }
  await rename(part, weightsPath(dir, model));
  await writeFile(okPath(dir, model), `${model.sha256}\n`);
}

/** the weights, a part download and the check: all of it */
export async function removeModel(dir: string, m: ModelFile): Promise<void> {
  for (const f of [weightsPath(dir, m), partPath(dir, m), okPath(dir, m)]) {
    await unlink(f).catch(() => {});
  }
}
