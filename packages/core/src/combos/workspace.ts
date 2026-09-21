import { rename } from "node:fs/promises";
import path from "node:path";
import { isObject, readJsoncTolerant, stringifyLike, writeFileAtomic } from "../fsx.ts";
import { realpathLoose } from "../paths.ts";
import type { Combo, Warning } from "../types.ts";
import { workspaceFolders } from "./folders.ts";

/** named after the root's basename, which never changes. the display name can. */
export function workspaceFilePath(combo: Combo): string {
  return path.join(combo.root, `${path.basename(combo.root)}.code-workspace`);
}

interface FolderEntry {
  name?: string;
  path: string;
}

function desiredFolders(combo: Combo): FolderEntry[] {
  const [, ...refs] = workspaceFolders(combo);
  return [
    { name: combo.name, path: "." },
    ...refs.map((p) => ({ name: `${path.basename(p)} (ref)`, path: p })),
  ];
}

function resolved(entries: unknown, baseDir: string): string[] | null {
  if (!Array.isArray(entries)) return null;
  const out: string[] = [];
  for (const e of entries) {
    if (!isObject(e) || typeof e.path !== "string") return null;
    out.push(
      `${realpathLoose(path.resolve(baseDir, e.path))}\n${typeof e.name === "string" ? e.name : ""}`,
    );
  }
  return out;
}

/**
 * we own the `folders` key and nothing else. VS Code stores workspace settings in this same file
 * and reloads the window when it changes, so everything else is preserved and an unchanged folder
 * list is not rewritten. "unchanged" compares resolved paths: VS Code rewrites paths relative
 * to the file when it saves.
 */
export async function writeWorkspaceFile(
  combo: Combo,
): Promise<{ path: string; changed: boolean; warnings: Warning[] }> {
  const file = workspaceFilePath(combo);
  const warnings: Warning[] = [];
  const desired = desiredFolders(combo);
  const read = await readJsoncTolerant(file);

  let base: Record<string, unknown> = {};
  let original: string | undefined;
  if (read.status === "ok" && isObject(read.value)) {
    const want = resolved(desired, combo.root);
    const have = resolved(read.value.folders, combo.root);
    if (have && want && have.length === want.length && have.every((v, i) => v === want[i])) {
      return { path: file, changed: false, warnings };
    }
    base = read.value;
    original = read.text;
  } else if (read.status !== "missing") {
    // unusable for the editor as well. set it aside instead of deleting it.
    const aside = `${file}.invalid-${Date.now()}`;
    await rename(file, aside).catch(() => {});
    warnings.push({
      code: "workspace-file-invalid",
      message: `The workspace file could not be parsed. It was moved to ${path.basename(aside)} and regenerated.`,
    });
  }

  await writeFileAtomic(file, stringifyLike({ ...base, folders: desired }, original));
  return { path: file, changed: true, warnings };
}
