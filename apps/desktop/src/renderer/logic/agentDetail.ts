import { formatTokens, modelLabel, type SessionAgent } from "@grove/core/pure";
import type { AgentDetail } from "../../shared/ipc.ts";
import { type StepItem, stepItems } from "./steps.ts";

export {
  hasThinking,
  itemOfStep,
  offsetLabel,
  RUN_MIN,
  runOfStep,
  runTargets,
  type ToolLine,
} from "./steps.ts";

export type DetailItem =
  | { type: "head"; id: "head" }
  | { type: "label"; id: string; label: string }
  | { type: "result"; id: "result"; text: string }
  | { type: "asked"; id: "asked"; text: string }
  | StepItem
  | { type: "quiet"; id: string; text: string };

/**
 * what the detail view draws, top to bottom: the header, the result first (it is the answer to
 * "what did it do"), what it was asked, then every step. runs of one tool fold into a line, and
 * thinking only shows when asked for.
 */
export function detailItems(
  detail: AgentDetail,
  opts: { thinking: boolean; openRuns: ReadonlySet<string>; running: boolean },
): DetailItem[] {
  const items: DetailItem[] = [{ type: "head", id: "head" }];
  if (detail.result) {
    items.push({ type: "label", id: "l:result", label: "Result" });
    items.push({ type: "result", id: "result", text: detail.result });
  }
  if (detail.prompt) {
    items.push({ type: "label", id: "l:asked", label: "Asked" });
    items.push({ type: "asked", id: "asked", text: detail.prompt });
  }
  items.push({ type: "label", id: "l:steps", label: "Steps" });
  const steps = stepItems(detail.steps, opts);
  if (steps.length === 0) {
    items.push({
      type: "quiet",
      id: "q:steps",
      text: opts.running ? "Nothing yet." : "It did its work without a single step.",
    });
    return items;
  }
  items.push(...steps);
  return items;
}

/** `2m 28s`, `42m`, `1h 12m`: exact enough to tell two short agents apart */
export function exactDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** `Explore · sonnet 5 · 2m 28s · 26 tools · 41k tokens` */
export function detailMeta(
  agent: Pick<SessionAgent, "agentType" | "state"> | undefined,
  detail: AgentDetail,
  now: number,
): string {
  const parts: string[] = [];
  if (agent && agent.agentType !== "workflow-subagent") parts.push(agent.agentType);
  if (detail.model) parts.push(modelLabel(detail.model));
  if (detail.startedAt !== undefined) {
    const end = agent?.state === "running" ? now : (detail.lastAt ?? detail.startedAt);
    parts.push(exactDuration(end - detail.startedAt));
  }
  parts.push(`${detail.toolCount} ${detail.toolCount === 1 ? "tool" : "tools"}`);
  if (detail.tokens > 0) parts.push(`${formatTokens(detail.tokens)} tokens`);
  return parts.join(" · ");
}

/** only http(s) links go anywhere, and they go to the browser through main */
export function webLink(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
