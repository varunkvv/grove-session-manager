// a project's id. pure: the renderer imports this through @grove/core/pure.
import type { Combo } from "../types.ts";

/** basename(root). a rename never changes it. */
export type ProjectId = string;

/** roots are path.resolve'd on load, so there is no trailing slash. not path.basename: no node: here */
export function projectIdOf(combo: Pick<Combo, "root">): ProjectId {
  return combo.root.slice(combo.root.lastIndexOf("/") + 1);
}
