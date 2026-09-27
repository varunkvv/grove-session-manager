import type { SessionAgent } from "@grove/core/pure";

function counted(n: number): string {
  return `${n} agent${n === 1 ? "" : "s"}`;
}

/**
 * all a narrow row has room for: how many are still running, else how many there were. the
 * inspector beside it has the rest.
 */
export function agentsCount(agents: readonly SessionAgent[]): string {
  const running = agents.filter((a) => a.state === "running").length;
  return running > 0 ? `${running} running` : counted(agents.length);
}

/**
 * the row has one line, so the one thing worth saying about its agents: which are still at it and
 * which are done - `2 running · 3 done`. once they have all finished, only how many there were.
 */
export function agentsChip(agents: readonly SessionAgent[]): string {
  if (agents.length === 0) return "";
  const running = agents.filter((a) => a.state === "running").length;
  if (running === 0) return counted(agents.length);
  const done = agents.length - running;
  return done > 0 ? `${running} running · ${done} done` : `${running} running`;
}

/** everything the chip had no room for: what each agent was asked to do, and what it did last */
export function agentsTooltip(agents: readonly SessionAgent[]): string {
  return agents
    .map((a) => {
      const head = `${a.agentType}${a.state === "done" ? " (done)" : ""}`;
      const lines = [a.description ? `${head}: ${a.description}` : head];
      if (a.summary) lines.push(`  ${a.summary}`);
      if (a.lastTool) lines.push(`  last tool: ${a.lastTool}`);
      return lines.join("\n");
    })
    .join("\n");
}
