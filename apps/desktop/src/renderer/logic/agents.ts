import { formatDuration, type SessionAgent } from "@grove/core/pure";

/** all a narrow row has room for. the inspector beside it has the rest. */
export function agentsCount(agents: readonly SessionAgent[]): string {
  return `${agents.length} agent${agents.length === 1 ? "" : "s"}`;
}

/** the row has one line, so: how many there are, then the running ones and how long they have been at it. */
export function agentsChip(agents: readonly SessionAgent[], now: number): string {
  if (agents.length === 0) return "";
  const running = agents.filter((a) => a.state === "running");
  const count = `${agents.length} agent${agents.length === 1 ? "" : "s"}`;
  const shown = running
    .slice(0, 2)
    .map((a) => `${a.agentType} ${formatDuration(Math.max(0, now - a.startedAt))}`);
  const more = running.length - shown.length;
  if (more > 0) shown.push(`+${more}`);
  return shown.length ? `${count} · ${shown.join(" · ")}` : count;
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
