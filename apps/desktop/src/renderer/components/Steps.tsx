// grove chat's view of a turn's work: the thinking and the steps between what it said, quiet and
// folded until asked for. what it said is full-weight, in the turn, never in here.
import { formatDuration, toolLabel } from "@grove/core/pure";
import { useState } from "react";
import type { WorkStep } from "../logic/views.ts";
import { useChatScope } from "../state/chatScope.ts";
import { Markdown } from "./Markdown.tsx";
import { cx, Diff, Icon, Mono, Spinner } from "./ui.tsx";

/** a second or more: under that a step's time says nothing */
const took = (ms?: number) => (ms !== undefined && ms >= 1000 ? formatDuration(ms) : "");

/** a fold's own chevron: right when closed, down when open */
function Fold({ open }: { open: boolean }) {
  return <Icon name="chevron" size={9} faint className={cx("fade", open && "rotate-90")} />;
}

/**
 * thinking, folded to how long it took. opened, the summary claude wrote of it, in the muted
 * colour: it is how it got there, not what it says
 */
export function Thought({ text, ms }: { text: string; ms?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5" data-testid="thought">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="fade inline-flex items-center gap-1.5 rounded-sm text-sm text-fg-4 hover:text-fg-2"
      >
        <Fold open={open} />
        {took(ms) ? `Thought for ${took(ms)}` : "Thought"}
      </button>
      {open && (
        <div
          className="selectable mt-0.5 mb-2 pl-[15px] text-sm text-fg-3"
          data-testid="thought-text"
        >
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}

/** the tools whose step opens what they changed */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** one row of the list: a tool and what it acted on, or a thought */
function Step({ step, going }: { step: WorkStep; going: boolean }) {
  const scope = useChatScope();
  /** an edit opened: what it changed, read when first opened. null: nothing to show */
  const [diff, setDiff] = useState<string[] | null>();
  const [open, setOpen] = useState(false);
  if (step.kind === "thinking") return <Thought text={step.text} ms={step.ms} />;
  // an agent's step opens the agent: its own transcript, beside the conversation. a workflow's
  // opens the list, where its run and its agents are. a finished edit opens its diff in place
  const agent =
    (step.name === "Agent" || step.name === "Task" || step.name === "Workflow") && scope?.agents;
  const edit = !!scope?.diff && EDIT_TOOLS.has(step.name) && step.ms !== undefined && !step.failed;
  const click = agent
    ? () => scope?.agents?.(step.id)
    : edit
      ? () => {
          setOpen(!open);
          if (diff === undefined) void scope?.diff?.(step.id).then(setDiff, () => setDiff(null));
        }
      : undefined;
  const Row = click ? "button" : "div";
  const row = (
    <Row
      {...(click
        ? { type: "button" as const, onClick: click, "aria-expanded": edit ? open : undefined }
        : {})}
      className={cx(
        "mt-1 flex w-full min-w-0 items-baseline gap-2 text-left text-sm",
        click && "fade rounded-sm hover:text-fg [&:hover_*]:text-fg-2",
      )}
      data-testid="step"
      data-failed={step.failed ? "" : undefined}
    >
      <span className={cx("w-20 shrink-0 truncate", step.failed ? "text-danger" : "text-fg-3")}>
        {toolLabel(step.name)}
      </span>
      <Mono className="min-w-0 flex-1 truncate text-fg-4" title={step.target}>
        {step.target}
      </Mono>
      <span className="shrink-0 tabular-nums text-fg-4">
        {step.failed ? (
          <span className="text-danger">{step.failed}</span>
        ) : step.ms === undefined && going ? (
          <Spinner size={10} />
        ) : (
          took(step.ms)
        )}
      </span>
    </Row>
  );
  if (!edit) return row;
  return (
    <>
      {row}
      {open && diff && <Diff lines={diff} className="mt-1 mb-2" />}
    </>
  );
}

/** a turn's work in order, under the line that opened it */
export function StepList({
  steps,
  before,
  going,
}: {
  steps: readonly WorkStep[];
  /** older steps of a long turn, not sent */
  before?: number;
  /** the turn is under way: a step with no time yet is running */
  going: boolean;
}) {
  return (
    <div className="mt-1.5 mb-3 border-l border-line pl-3" data-testid="steps">
      {!!before && <p className="text-sm text-fg-4">{before} earlier steps</p>}
      {steps.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a turn's steps only grow, in order
        <Step key={i} step={s} going={going} />
      ))}
    </div>
  );
}

/**
 * the work between two things it said, folded to how many steps, as the turn's work line is.
 * thinking alone is its own Thought. `open`: how it starts, the work line's state
 */
export function StepFold({
  steps,
  before,
  going,
  open: start,
}: {
  steps: readonly WorkStep[];
  before?: number;
  going: boolean;
  open: boolean;
}) {
  const [open, setOpen] = useState(start);
  const tools = steps.filter((s) => s.kind === "tool").length;
  if (!tools) {
    return steps.map((s, i) =>
      // biome-ignore lint/suspicious/noArrayIndexKey: a turn's steps only grow, in order
      s.kind === "thinking" ? <Thought key={i} text={s.text} ms={s.ms} /> : null,
    );
  }
  return (
    <div className="mt-1.5" data-testid="step-fold">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="fade inline-flex items-center gap-1.5 rounded-sm text-sm text-fg-4 hover:text-fg-2"
      >
        <Fold open={open} />
        {tools === 1 ? "1 step" : `${tools} steps`}
      </button>
      {open && <StepList steps={steps} before={before} going={going} />}
    </div>
  );
}
