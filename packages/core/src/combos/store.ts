import path from "node:path";
import { isObject, readJsonGuarded, stringifyLike, writeFileAtomic } from "../fsx.ts";
import { type Combo, err, ok, type Result } from "../types.ts";
import { type ComboProblem, normalizeCombosFile } from "./schema.ts";

export interface LoadedCombos {
  status: "ok" | "missing" | "invalid";
  combos: Combo[];
  problems: ComboProblem[];
  message?: string;
}

export function combosFilePath(appRoot: string): string {
  return path.join(appRoot, "combos.json");
}

/** combos.json is the source of truth and people edit it by hand. loading never writes. */
export async function loadCombos(appRoot: string): Promise<LoadedCombos> {
  const read = await readJsonGuarded(combosFilePath(appRoot));
  if (read.status === "missing") return { status: "missing", combos: [], problems: [] };
  if (read.status === "invalid") {
    return {
      status: "invalid",
      combos: [],
      problems: [{ message: read.message }],
      message: read.message,
    };
  }
  const { combos, problems } = normalizeCombosFile(read.value, appRoot);
  return { status: "ok", combos, problems };
}

/**
 * read-modify-write. unknown keys, entries we could not load, and the file's indentation all
 * survive. an unparseable file is never overwritten.
 */
export async function updateCombos(
  appRoot: string,
  mutate: (combos: Combo[]) => Combo[],
): Promise<Result<Combo[]>> {
  const file = combosFilePath(appRoot);
  const read = await readJsonGuarded(file);
  if (read.status === "invalid") {
    return err(
      "invalid-json",
      `combos.json is not valid JSON and was left untouched: ${read.message}`,
    );
  }
  const raw = read.status === "ok" && isObject(read.value) ? read.value : {};
  const { combos, rejected } = normalizeCombosFile(
    read.status === "ok" ? read.value : undefined,
    appRoot,
  );
  const next = mutate(combos.map((c) => ({ ...c, folders: c.folders.map((f) => ({ ...f })) })));
  const text = stringifyLike(
    { ...raw, combos: [...next, ...rejected] },
    read.status === "ok" ? read.text : undefined,
  );
  await writeFileAtomic(file, text);
  return ok(next);
}
