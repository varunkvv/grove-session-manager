// the library. the desktop app imports this to read the record, to write as the person, and to
// render the files it installs. nothing in this package imports the rest of grove.

export { findRoot, main } from "./cli.ts";
export type { Parsed } from "./format.ts";
export {
  CARD_ID,
  CONCLUSION_ID,
  PREFIX,
  PROJECT_FILE,
  parseRecord,
  paths,
  renderRecord,
} from "./format.ts";
export type { Caller, HolderRef, Liveness } from "./identity.ts";
export { holderStatus, procStart, registryDir, resolveCaller } from "./identity.ts";
export { serve, stampOf } from "./mcp.ts";
export type { ErrCode, OpResult } from "./ops.ts";
export { EXIT, reindex, renderProjectFile, stateText } from "./ops.ts";
export { sweepTemps } from "./publish.ts";
export {
  deriveStatus,
  isHeld,
  lastClaim,
  listCardIds,
  listConclusionIds,
  markSuperseded,
  questionsOf,
  readCard,
  readCards,
  readClaims,
  readComments,
  readConclusions,
  readIndex,
  readProject,
  readRecord,
  revisionOf,
} from "./read.ts";
export {
  allowRules,
  HOOK_MARKER,
  hookCommand,
  hookGroup,
  isLauncherAllowRule,
  mcpServerEntry,
  RULES_FILE,
  renderCliHelp,
  renderInstructions,
  renderLauncher,
  renderRules,
  renderToolList,
} from "./render.ts";
export type { RunOptions, ToolDef } from "./tools.ts";
export { mcpToolList, runTool, TOOLS, tool } from "./tools.ts";
export type * from "./types.ts";
export { BUNDLE_VERSION, compareVersions, FORMAT_VERSION, SERVER_NAME } from "./version.ts";

import { resolveCaller } from "./identity.ts";
import { attempt, type OpResult, projectInit } from "./ops.ts";
import { runTool } from "./tools.ts";

/**
 * write or update .claude/grove-project.json from the combo: what grove's sync calls. rev goes up
 * by one only when name, prefix or goal changed, so the state's revision line moves exactly then.
 * refuses to change the prefix of a project that has cards.
 */
export function syncProject(
  root: string,
  project: { prefix: string; name: string; goal: string },
): OpResult {
  return attempt(() =>
    projectInit({ root, caller: resolveCaller({ env: {}, person: true }), env: {} }, project),
  );
}

/**
 * a write the person made in grove: create a card, cancel one, release one. the same tools the
 * agents call, with the person as the author. `by: person`, `session: person`, no process.
 */
export function callAsPerson(
  root: string,
  name: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): OpResult {
  return runTool(name, args, { root, env, person: true });
}
