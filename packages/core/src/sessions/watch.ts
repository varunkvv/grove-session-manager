import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";
import type { Disposable } from "../types.ts";
import { isTranscriptFile } from "./scan.ts";

export interface WatchHandlers {
  /** a transcript (or its custom-title sidecar) was created, appended to, or deleted */
  onTranscript(file: string): void;
  /** something we cannot attribute to one file happened. do a stat-only refresh. */
  onRescan(): void;
  onError?(error: unknown): void;
}

export interface WatchOptions {
  firstDelayMs?: number;
  minIntervalMs?: number;
}

/** maps a path relative to the projects dir onto the transcript it concerns, if any */
export function classifyWatchPath(
  rel: string,
): { kind: "transcript"; rel: string } | { kind: "dir" } | null {
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length === 1) return { kind: "dir" };
  if (parts.length === 2 && isTranscriptFile(parts[1]!)) return { kind: "transcript", rel };
  if (parts.length === 3 && parts[2] === "custom-title.json") {
    return { kind: "transcript", rel: path.join(parts[0]!, `${parts[1]}.jsonl`) };
  }
  // subagents, tool results, memory: constant churn under the same tree, never a session row
  return null;
}

/**
 * one recursive watch over the projects dir. a brand-new project dir and its first transcript
 * arrive on the same stream, so a new session in a new combo shows up without an add-watch race.
 *
 * throttled per path, not debounced: an active session appends constantly and would never settle.
 */
export function watchProjects(
  projectsDir: string,
  handlers: WatchHandlers,
  opts: WatchOptions = {},
): Disposable {
  const firstDelay = opts.firstDelayMs ?? 300;
  const minInterval = opts.minIntervalMs ?? 1500;
  const pending = new Map<string, NodeJS.Timeout>();
  const lastFire = new Map<string, number>();
  let watcher: FSWatcher | null = null;
  let retry: NodeJS.Timeout | null = null;
  let rescanTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  let attempt = 0;

  const scheduleRescan = () => {
    if (rescanTimer || disposed) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      handlers.onRescan();
    }, firstDelay);
  };

  const schedule = (file: string) => {
    if (pending.has(file)) return;
    const now = Date.now();
    const since = now - (lastFire.get(file) ?? 0);
    const delay = Math.max(firstDelay, minInterval - since);
    pending.set(
      file,
      setTimeout(() => {
        pending.delete(file);
        lastFire.set(file, Date.now());
        if (lastFire.size > 512) {
          for (const [p, t] of lastFire) if (Date.now() - t > minInterval * 4) lastFire.delete(p);
        }
        handlers.onTranscript(file);
      }, delay),
    );
  };

  const start = () => {
    if (disposed) return;
    if (!existsSync(projectsDir)) {
      // never create anything inside Claude's config dir. wait for it to exist.
      retry = setTimeout(start, 5000);
      return;
    }
    try {
      watcher = watch(projectsDir, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename === null) return scheduleRescan();
        const hit = classifyWatchPath(filename.toString());
        if (!hit) return;
        if (hit.kind === "dir") return scheduleRescan();
        schedule(path.join(projectsDir, hit.rel));
      });
      watcher.on("error", (e) => {
        handlers.onError?.(e);
        watcher?.close();
        watcher = null;
        const backoff = [1000, 5000, 30_000][Math.min(attempt++, 2)]!;
        retry = setTimeout(start, backoff);
      });
      attempt = 0;
      scheduleRescan();
    } catch (e) {
      handlers.onError?.(e);
      retry = setTimeout(start, 5000);
    }
  };

  start();

  return {
    dispose() {
      disposed = true;
      watcher?.close();
      if (retry) clearTimeout(retry);
      if (rescanTimer) clearTimeout(rescanTimer);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}
