import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { mapLimit } from "../fsx.ts";

export interface FileStat {
  path: string;
  projectDirName: string;
  stem: string;
  size: number;
  mtimeMs: number;
  /** mtime of <projectDir>/<stem>/custom-title.json, 0 when there is none */
  sidecarMtimeMs: number;
}

/**
 * `<stem>.jsonl` where the stem has no dot. that keeps out `<id>.orphaned-<ts>.jsonl` and
 * `<id>.jsonl.superseded-<ts>`, which Claude Code sets aside and hides from its own picker.
 * shared with the watcher so both agree on what a transcript is.
 */
export function isTranscriptFile(name: string): boolean {
  return /^[^.]+\.jsonl$/.test(name);
}

export function sidecarTitlePath(transcriptPath: string): string {
  const dir = path.dirname(transcriptPath);
  const stem = path.basename(transcriptPath, ".jsonl");
  return path.join(dir, stem, "custom-title.json");
}

export async function statTranscript(file: string, hasSidecarDir = true): Promise<FileStat | null> {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size === 0) return null;
    let sidecarMtimeMs = 0;
    if (hasSidecarDir) {
      try {
        sidecarMtimeMs = (await stat(sidecarTitlePath(file))).mtimeMs;
      } catch {
        // most sessions have no sidecar
      }
    }
    return {
      path: file,
      projectDirName: path.basename(path.dirname(file)),
      stem: path.basename(file, ".jsonl"),
      size: st.size,
      mtimeMs: st.mtimeMs,
      sidecarMtimeMs,
    };
  } catch {
    return null;
  }
}

/** depth 2 only. subagent transcripts, tool results and memory live deeper and are never listed. */
export async function scanProjects(projectsDir: string): Promise<FileStat[]> {
  let dirs: string[];
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const perDir = await mapLimit(dirs, 8, async (dirName) => {
    const dir = path.join(projectsDir, dirName);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const subdirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
      const files = entries.filter((e) => e.isFile() && isTranscriptFile(e.name));
      const stats = await mapLimit(files, 16, (f) =>
        statTranscript(path.join(dir, f.name), subdirs.has(path.basename(f.name, ".jsonl"))),
      );
      return stats.filter((s): s is FileStat => s !== null);
    } catch {
      return [];
    }
  });

  return perDir.flat().sort((a, b) => b.mtimeMs - a.mtimeMs);
}
