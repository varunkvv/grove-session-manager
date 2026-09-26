import type { AgentDetail, DetailStep } from "../../shared/ipc.ts";

export type ToolLine = Extract<DetailStep, { kind: "tool" }>;

/** a run of the same tool this long or longer reads as one line until someone opens it */
export const RUN_MIN = 3;

/** one line of an agent's work, or a session turn's: the same steps, drawn the same way */
export type StepItem =
  | { type: "tool"; id: string; step: ToolLine; nested?: boolean }
  | { type: "run"; id: string; name: string; steps: ToolLine[]; open: boolean }
  | { type: "prose"; id: string; step: Extract<DetailStep, { kind: "text" | "thinking" }> }
  | { type: "message"; id: string; step: Extract<DetailStep, { kind: "message" }> };

/** a run may swallow a step only when there is nothing on it worth its own line */
function plain(s: DetailStep): s is ToolLine {
  return s.kind === "tool" && !s.failure && !s.agentId && !s.server;
}

/**
 * steps as lines: runs of one tool fold into a line, and thinking only shows when asked for.
 * `prefix` keeps ids apart when several lists of steps share one view (a session's turns).
 */
export function stepItems(
  all: readonly DetailStep[],
  opts: { thinking: boolean; openRuns: ReadonlySet<string>; running: boolean; prefix?: string },
): StepItem[] {
  const prefix = opts.prefix ?? "";
  const steps = opts.thinking ? all : all.filter((s) => s.kind !== "thinking");
  const items: StepItem[] = [];
  for (let i = 0; i < steps.length; ) {
    const s = steps[i] as DetailStep;
    if (plain(s)) {
      let j = i + 1;
      while (j < steps.length) {
        const next = steps[j] as DetailStep;
        if (!plain(next) || next.name !== s.name) break;
        j++;
      }
      // the newest step of something running keeps its own line: it is what is happening now
      const end = opts.running && j === steps.length ? j - 1 : j;
      const run = steps.slice(i, end) as ToolLine[];
      if (run.length >= RUN_MIN) {
        const id = `${prefix}run:${s.n}`;
        const open = opts.openRuns.has(id);
        items.push({ type: "run", id, name: s.name, steps: run, open });
        if (open) {
          for (const r of run) {
            items.push({ type: "tool", id: `${prefix}t:${r.n}`, step: r, nested: true });
          }
        }
        i = end;
        continue;
      }
    }
    if (s.kind === "tool") items.push({ type: "tool", id: `${prefix}t:${s.n}`, step: s });
    else if (s.kind === "message")
      items.push({ type: "message", id: `${prefix}m:${s.n}`, step: s });
    else items.push({ type: "prose", id: `${prefix}p:${s.n}`, step: s });
    i++;
  }
  return items;
}

/** anything a view lists: the step lines among them are found by their type */
type Listed = { type: string; id: string };

function asStep(it: Listed): StepItem | null {
  return it.type === "tool" || it.type === "run" || it.type === "prose" || it.type === "message"
    ? (it as StepItem)
    : null;
}

/** the item a step lives in: its own line, or the run that swallowed it */
export function itemOfStep(items: readonly Listed[], n: number, prefix = ""): number {
  return items.findIndex((it) => {
    const s = asStep(it);
    if (!s?.id.startsWith(prefix)) return false;
    return (
      ((s.type === "tool" || s.type === "prose" || s.type === "message") && s.step.n === n) ||
      (s.type === "run" && !s.open && s.steps.some((x) => x.n === n))
    );
  });
}

/** the run a step sits in, so a search hit inside a folded run can open it */
export function runOfStep(items: readonly Listed[], n: number, prefix = ""): string | null {
  for (const it of items) {
    const s = asStep(it);
    if (s?.type === "run" && s.id.startsWith(prefix) && s.steps.some((x) => x.n === n)) return s.id;
  }
  return null;
}

/** `+0:04`, `+1:12`, `+1:02:10`: how far into an agent's life, or a turn, a step came */
export function offsetLabel(at: number, start: number | undefined): string {
  if (start === undefined) return "";
  const total = Math.max(0, Math.floor((at - start) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `+${h}:${String(m).padStart(2, "0")}:${s}` : `+${m}:${s}`;
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
export function hasThinking(detail: Pick<AgentDetail, "steps"> | null | undefined): boolean {
  return !!detail?.steps.some((s) => s.kind === "thinking");
}
