import type { TimelineState } from "@grove/core";
import type { DetailStep } from "../../shared/ipc.ts";

/**
 * the view's steps, numbered by where they sit in the fold. the view only ever leaves out the
 * final message's text, so a step keeps its number while the agent writes more.
 */
export function detailSteps(
  all: readonly TimelineState["steps"][number][],
  shown: readonly TimelineState["steps"][number][],
  started: ReadonlyMap<string, string>,
): DetailStep[] {
  const index = new Map(all.map((s, i) => [s, i]));
  return shown.map((s): DetailStep => {
    const n = index.get(s) ?? -1;
    if (s.kind !== "tool") {
      return s.kind === "message"
        ? {
            kind: "message",
            n,
            text: s.text,
            at: s.at,
            ...(s.interrupted ? { interrupted: true } : {}),
          }
        : { kind: s.kind, n, text: s.text, at: s.at };
    }
    const step: DetailStep = {
      kind: "tool",
      n,
      id: s.id,
      name: s.name,
      target: s.target,
      at: s.at,
    };
    if (s.durationMs !== undefined) step.durationMs = s.durationMs;
    if (s.failure) step.failure = s.failure;
    if (s.server) step.server = true;
    const child = started.get(s.id);
    if (child) step.agentId = child;
    return step;
  });
}
