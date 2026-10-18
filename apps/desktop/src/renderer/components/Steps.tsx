// grove chat's view of a turn's work: the thinking and the steps behind the answer, quiet and
// folded until asked for. the answer stays the only full-weight text in a turn.
import { formatDuration, type StepView, toolLabel } from "@grove/core/pure";
import { useState } from "react";
import { useChatScope } from "../state/chatScope.ts";
import { Markdown } from "./Markdown.tsx";
import { cx, Icon, Mono, Spinner } from "./ui.tsx";

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

/** one row of the list: a tool and what it acted on, a thought, or what it said on the way */
function Step({ step, going }: { step: StepView; going: boolean }) {
  const scope = useChatScope();
  if (step.kind === "thinking") return <Thought text={step.text} ms={step.ms} />;
  if (step.kind === "text") {
    return <p className="selectable mt-1.5 line-clamp-3 text-sm text-fg-3">{step.text}</p>;
  }
  // an agent's step opens the agent: its own transcript, beside the conversation
  const agent = (step.name === "Agent" || step.name === "Task") && scope?.agents;
  const Row = agent ? "button" : "div";
  return (
    <Row
      {...(agent ? { type: "button" as const, onClick: () => scope?.agents?.(step.id) } : {})}
      className={cx(
        "mt-1 flex w-full min-w-0 items-baseline gap-2 text-left text-sm",
        agent && "fade rounded-sm hover:text-fg [&:hover_*]:text-fg-2",
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
}

/** a turn's work in order, under the line that opened it */
export function StepList({
  steps,
  before,
  going,
}: {
  steps: readonly StepView[];
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
