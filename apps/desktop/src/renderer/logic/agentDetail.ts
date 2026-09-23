import { formatTokens, modelLabel, type SessionAgent } from "@grove/core/pure";
import type { AgentDetail, DetailStep } from "../../shared/ipc.ts";

export type ToolLine = Extract<DetailStep, { kind: "tool" }>;

/** a run of the same tool this long or longer reads as one line until someone opens it */
export const RUN_MIN = 3;

export type DetailItem =
  | { type: "head"; id: "head" }
  | { type: "label"; id: string; label: string }
  | { type: "result"; id: "result"; text: string }
  | { type: "asked"; id: "asked"; text: string }
  | { type: "tool"; id: string; step: ToolLine; nested?: boolean }
  | { type: "run"; id: string; name: string; steps: ToolLine[]; open: boolean }
  | { type: "prose"; id: string; step: Extract<DetailStep, { kind: "text" | "thinking" }> }
  | { type: "message"; id: string; step: Extract<DetailStep, { kind: "message" }> }
  | { type: "quiet"; id: string; text: string };

/** a run may swallow a step only when there is nothing on it worth its own line */
function plain(s: DetailStep): s is ToolLine {
  return s.kind === "tool" && !s.failure && !s.agentId && !s.server;
}

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
  const steps = opts.thinking ? detail.steps : detail.steps.filter((s) => s.kind !== "thinking");
  if (steps.length === 0) {
    items.push({
      type: "quiet",
      id: "q:steps",
      text: opts.running ? "Nothing yet." : "It did its work without a single step.",
    });
    return items;
  }
  for (let i = 0; i < steps.length; ) {
    const s = steps[i] as DetailStep;
    if (plain(s)) {
      let j = i + 1;
      while (j < steps.length) {
        const next = steps[j] as DetailStep;
        if (!plain(next) || next.name !== s.name) break;
        j++;
      }
      // the newest step of a running agent keeps its own line: it is what the agent is doing now
      const end = opts.running && j === steps.length ? j - 1 : j;
      const run = steps.slice(i, end) as ToolLine[];
      if (run.length >= RUN_MIN) {
        const id = `run:${s.n}`;
        const open = opts.openRuns.has(id);
        items.push({ type: "run", id, name: s.name, steps: run, open });
        if (open) {
          for (const r of run) items.push({ type: "tool", id: `t:${r.n}`, step: r, nested: true });
        }
        i = end;
        continue;
      }
    }
    if (s.kind === "tool") items.push({ type: "tool", id: `t:${s.n}`, step: s });
    else if (s.kind === "message") items.push({ type: "message", id: `m:${s.n}`, step: s });
    else items.push({ type: "prose", id: `p:${s.n}`, step: s });
    i++;
  }
  return items;
}

/** the item a fold step lives in: its own line, or the run that swallowed it */
export function itemOfStep(items: readonly DetailItem[], n: number): number {
  return items.findIndex(
    (it) =>
      ((it.type === "tool" || it.type === "prose" || it.type === "message") && it.step.n === n) ||
      (it.type === "run" && !it.open && it.steps.some((s) => s.n === n)),
  );
}

/** the run a fold step sits in, so a search hit inside a folded run can open it */
export function runOfStep(items: readonly DetailItem[], n: number): string | null {
  for (const it of items) if (it.type === "run" && it.steps.some((s) => s.n === n)) return it.id;
  return null;
}

/** `+0:04`, `+1:12`, `+1:02:10`: how far into the agent's life a step came */
export function offsetLabel(at: number, start: number | undefined): string {
  if (start === undefined) return "";
  const total = Math.max(0, Math.floor((at - start) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `+${h}:${String(m).padStart(2, "0")}:${s}` : `+${m}:${s}`;
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

/** the targets of a folded run, as many as fit a line: `liveStatus.ts, agents.ts, +4` */
export function runTargets(steps: readonly ToolLine[], max = 3): string {
  const names = steps.map((s) => {
    const t = s.target;
    // a path says itself best by its last part in a list like this
    return /^[~./\w-]+\/[^\s]+$/.test(t) ? (t.split("/").pop() ?? t) : t;
  });
  // the same command five times is one thing done five times, not five things
  const distinct = [...new Set(names.filter(Boolean))];
  const shown = distinct.slice(0, max);
  const rest = distinct.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, +${rest}` : shown.join(", ");
}

/** whether it has any thinking with words in it. a redacted block is a signature and nothing else. */
export function hasThinking(detail: AgentDetail | null | undefined): boolean {
  return !!detail?.steps.some((s) => s.kind === "thinking");
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
