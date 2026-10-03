// project ids and card prefixes. pure: the renderer imports this through @grove/core/pure.
import { comboDirSlug } from "../slug.ts";
import type { Combo } from "../types.ts";

/** basename(root). a rename never changes it. */
export type ProjectId = string;

/** roots are path.resolve'd on load, so there is no trailing slash. not path.basename: no node: here */
export function projectIdOf(combo: Pick<Combo, "root">): ProjectId {
  return combo.root.slice(combo.root.lastIndexOf("/") + 1);
}

/** the record's own grammar for a prefix */
export const PREFIX_RE = /^[A-Z][A-Z0-9]{0,7}$/;
/** card D-1 would collide with decision D-1 */
export const RESERVED_PREFIXES: ReadonlySet<string> = new Set(["D", "F", "V"]);

/** the first four letters and digits, upper-cased, leading digits dropped. `1password` is PASS */
export function derivePrefix(name: string): string {
  const p =
    comboDirSlug(name)
      .replace(/[^a-z0-9]/g, "")
      .replace(/^[0-9]+/, "")
      .slice(0, 4)
      .toUpperCase() || "P";
  return RESERVED_PREFIXES.has(p) ? `${p}P` : p;
}

/** a problem to show, or nothing. `combos` must carry their prefixes (the app backfills them on load) */
export function validatePrefix(
  prefix: string,
  combos: readonly Combo[],
  selfRoot?: string,
): string | undefined {
  const p = prefix.toUpperCase();
  if (!p) return "Give the project a card prefix.";
  if (!PREFIX_RE.test(p))
    return "A card prefix is 1 to 8 letters and digits, starting with a letter.";
  if (RESERVED_PREFIXES.has(p))
    return `${p} is taken by conclusion ids (D-1, F-1, V-1). Pick another prefix.`;
  const other = combos.find((c) => c.root !== selfRoot && c.prefix?.toUpperCase() === p);
  if (other) return `"${other.name}" already uses the prefix ${p}.`;
  return undefined;
}

/**
 * a prefix for every combo that has none stored, in file order. the one in its project file
 * (`onDisk`, by root) wins when free, because the record refuses a prefix change once cards exist.
 * else derived from the folder name, with a number on a clash: DATA, DAT2 ... DAT9, DA10 ... DA99.
 */
export function assignPrefixes(
  combos: readonly Combo[],
  onDisk: ReadonlyMap<string, string>,
): Map<string, string> {
  const taken = new Set([...RESERVED_PREFIXES, ...combos.flatMap((c) => c.prefix ?? [])]);
  const out = new Map<string, string>();
  for (const c of combos) {
    if (c.prefix) continue;
    const kept = onDisk.get(c.root);
    const want =
      kept && PREFIX_RE.test(kept) && !taken.has(kept) ? kept : derivePrefix(projectIdOf(c));
    const tries = [want];
    for (let n = 2; n <= 9; n++) tries.push(want.slice(0, 3) + n);
    for (let n = 10; n <= 99; n++) tries.push(want.slice(0, 2) + n);
    const p = tries.find((t) => !taken.has(t));
    // ponytail: a hundred combos sharing four letters is left without a prefix. add a wider run if it happens
    if (!p) continue;
    taken.add(p);
    out.set(c.root, p);
  }
  return out;
}
