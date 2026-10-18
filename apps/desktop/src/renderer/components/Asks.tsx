// what a session grove runs waits on the person for: a question, a plan, a permission. the chat
// window draws them under the turn, and the main window's session card draws the same ones.
import { modelLabel } from "@grove/core/pure";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ChatAnswer, ChatAsk, ChatMode, ChatQuestion } from "../../shared/ipc.ts";
import { Markdown } from "./Markdown.tsx";
import {
  AskCard,
  Button,
  CheckBox,
  Choice,
  cx,
  Diff,
  Icon,
  inputClass,
  Mono,
  Select,
  Switch,
} from "./ui.tsx";

/** a header chip holds this much, as Claude Code's does */
const HEADER_MAX = 12;
const chip = (q: ChatQuestion, i: number) => {
  const h = q.header.trim() || `Question ${i + 1}`;
  return h.length > HEADER_MAX ? `${h.slice(0, HEADER_MAX - 1)}…` : h;
};

/**
 * an option's preview, beside the list: the model writes it for a monospace box (Claude Code's
 * default format). one with markdown structure goes through Markdown, anything else stays as typed
 */
function Preview({ text }: { text: string }) {
  return (
    <div
      className="selectable min-w-0 overflow-auto rounded-md border border-line bg-canvas px-3 py-2"
      data-testid="ask-preview"
    >
      {/^(#{1,6} |```|\|)/m.test(text) ? (
        <Markdown text={text} />
      ) : (
        <Mono className="block whitespace-pre text-fg-2">{text}</Mono>
      )}
    </div>
  );
}

/**
 * one question, or several in a row as Claude Code asks them: a tab per question by its header, a
 * check on each one answered, and a last tab to look them over before they go. a single question
 * with one pick is answered by the click. multi-select picks any number, with words of your own
 * too. keys: 1-4 pick, space toggles, arrows move between questions, Enter on the last tab sends,
 * Esc leaves the card unanswered
 */
export function QuestionCard({
  ask,
  onAnswer,
  onLeave,
  autoFocus,
}: {
  ask: Extract<ChatAsk, { kind: "question" }>;
  onAnswer: (a: ChatAnswer) => void;
  /** Esc: back to wherever the person was typing */
  onLeave?: () => void;
  autoFocus?: boolean;
}) {
  const qs = ask.questions;
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  /** the question shown: one past the last is the review */
  const [at, setAt] = useState(0);
  /** the option the keyboard or the pointer is on: its preview shows */
  const [hover, setHover] = useState<string>();
  const box = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the card comes
  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, []);
  // one question that takes one pick: a click on it is the answer
  const quick = qs.length === 1 && !qs[0]?.multiSelect;
  const answerOf = (q: ChatQuestion) => [
    ...(picked[q.question] ?? []),
    ...(other[q.question]?.trim() ? [other[q.question]?.trim() ?? ""] : []),
  ];
  const answers = () =>
    Object.fromEntries(qs.map((q) => [q.question, answerOf(q).join(", ")])) as Record<
      string,
      string
    >;
  const complete = qs.every((q) => answerOf(q).length > 0);
  const review = !quick && at >= qs.length;
  const q = review ? undefined : qs[at];
  const send = (a: Record<string, string>) => onAnswer({ kind: "question", answers: a });
  const go = (i: number) => {
    setAt(Math.max(0, Math.min(qs.length, i)));
    setHover(undefined);
  };

  const pick = (label: string) => {
    if (!q) return;
    if (quick) return send({ [q.question]: label });
    const was = picked[q.question] ?? [];
    if (q.multiSelect) {
      setPicked({
        ...picked,
        [q.question]: was.includes(label) ? was.filter((l) => l !== label) : [...was, label],
      });
      return;
    }
    // one pick, and on to the next question, as Claude Code moves on
    setPicked({ ...picked, [q.question]: [label] });
    setOther({ ...other, [q.question]: "" });
    go(at + 1);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const typing = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "Escape") {
      e.preventDefault();
      onLeave?.();
    } else if (!quick && !typing && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      go(at + (e.key === "ArrowRight" ? 1 : -1));
    } else if (q && !typing && /^[1-9]$/.test(e.key)) {
      const o = q.options[Number(e.key) - 1];
      if (o) {
        e.preventDefault();
        pick(o.label);
      }
    } else if (review && e.key === "Enter" && complete) {
      e.preventDefault();
      send(answers());
    }
  };

  const shown = q?.options.find((o) => o.label === hover && o.preview)?.preview;
  const previews = !!q?.options.some((o) => o.preview);
  return (
    <AskCard label="Claude asks" testId="ask-question">
      <section
        ref={box}
        tabIndex={-1}
        onKeyDown={onKey}
        // the card holds the keys: its picks say where they go, no ring round it
        data-list
        data-testid="ask-body"
      >
        {!quick && (
          <div className="mt-2 flex flex-wrap items-center gap-1" role="tablist">
            {qs.map((x, i) => (
              <button
                key={x.question}
                type="button"
                role="tab"
                aria-selected={i === at}
                data-testid="ask-tab"
                onClick={() => go(i)}
                className={cx(
                  "fade inline-flex h-6 items-center gap-1 rounded-md px-2 text-sm",
                  i === at ? "bg-canvas text-fg" : "text-fg-3 hover:text-fg",
                )}
              >
                {answerOf(x).length > 0 && <Icon name="check" size={10} />}
                {chip(x, i)}
              </button>
            ))}
            <button
              type="button"
              role="tab"
              aria-selected={review}
              data-testid="ask-tab-submit"
              onClick={() => go(qs.length)}
              className={cx(
                "fade inline-flex h-6 items-center rounded-md px-2 text-sm",
                review ? "bg-canvas text-fg" : "text-fg-3 hover:text-fg",
              )}
            >
              Submit
            </button>
          </div>
        )}
        {q && (
          <div className="mt-2">
            <p className="selectable text-fg">{q.question}</p>
            {q.multiSelect && <p className="text-sm text-fg-4">Pick any that apply</p>}
            <div className={cx("mt-2 gap-3", previews && "grid grid-cols-2")}>
              <div className="min-w-0 space-y-1.5">
                {q.options.map((o, i) => {
                  const on = picked[q.question]?.includes(o.label) ?? false;
                  return (
                    <Choice
                      key={o.label}
                      picked={on}
                      data-testid="ask-option"
                      onClick={() => pick(o.label)}
                      onMouseEnter={() => setHover(o.label)}
                      onFocus={() => setHover(o.label)}
                      className="flex items-start gap-2.5"
                    >
                      {q.multiSelect ? (
                        <CheckBox checked={on} />
                      ) : (
                        <span className="w-3 shrink-0 pt-px text-sm tabular-nums text-fg-4">
                          {i + 1}
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="block font-medium">{o.label}</span>
                        {o.description && (
                          <span className="block text-sm text-fg-3">{o.description}</span>
                        )}
                      </span>
                    </Choice>
                  );
                })}
                <input
                  className={inputClass}
                  placeholder="Something else…"
                  data-testid="ask-other"
                  value={other[q.question] ?? ""}
                  onChange={(e) => {
                    setOther({ ...other, [q.question]: e.target.value });
                    // words of your own stand in for a single pick
                    if (!q.multiSelect && picked[q.question]?.length)
                      setPicked({ ...picked, [q.question]: [] });
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || !e.currentTarget.value.trim()) return;
                    e.preventDefault();
                    if (quick) send({ [q.question]: e.currentTarget.value.trim() });
                    else go(at + 1);
                  }}
                />
              </div>
              {previews && (shown ? <Preview text={shown} /> : <div />)}
            </div>
            {/* a single pick moves on by itself: Next is for several, or for words of your own */}
            {!quick && (q.multiSelect || !!other[q.question]?.trim()) && (
              <Button
                className="mt-3"
                data-testid="ask-next"
                disabled={answerOf(q).length === 0}
                onClick={() => go(at + 1)}
              >
                Next
              </Button>
            )}
          </div>
        )}
        {review && (
          <div className="mt-2" data-testid="ask-review">
            <dl className="space-y-1.5">
              {qs.map((x, i) => (
                <div key={x.question} className="flex gap-3">
                  <dt className="w-24 shrink-0 truncate text-sm text-fg-3">{chip(x, i)}</dt>
                  <dd
                    className={cx(
                      "selectable min-w-0 break-words",
                      answerOf(x).length ? "text-fg" : "text-fg-4",
                    )}
                  >
                    {answerOf(x).join(", ") || "Not answered yet"}
                  </dd>
                </div>
              ))}
            </dl>
            <Button
              variant="primary"
              className="mt-3"
              disabled={!complete}
              data-testid="ask-send"
              title="Enter"
              onClick={() => send(answers())}
            >
              Submit answers
            </Button>
          </div>
        )}
      </section>
    </AskCard>
  );
}

/** what an approved plan goes on in, and how its button says it, most hands-off first */
const AFTER_PLAN: Array<{ mode: ChatMode; label: string }> = [
  { mode: "bypassPermissions", label: "Approve, bypass permissions" },
  { mode: "auto", label: "Approve, auto" },
  { mode: "acceptEdits", label: "Approve, accept edits" },
  { mode: "default", label: "Approve, ask before edits" },
];

/**
 * a plan, and what happens after it: approved into a mode (the first the session offers is the
 * main one, as Claude Code lists them), or sent back with what should change
 */
export function PlanCard({
  ask,
  modes,
  onAnswer,
}: {
  ask: Extract<ChatAsk, { kind: "plan" }>;
  /** the modes the session can take: an approval goes on in one of them */
  modes: readonly ChatMode[];
  onAnswer: (a: ChatAnswer) => void;
}) {
  const [note, setNote] = useState("");
  const after = AFTER_PLAN.filter((x) => modes.includes(x.mode));
  return (
    <AskCard label="Claude's plan" testId="ask-plan">
      <div className="selectable mt-2">
        <Markdown text={ask.plan} className="md-full" />
      </div>
      {/* the permission card's shape: what it can do in a row, and words of your own under it */}
      <div className="mt-3 flex flex-wrap gap-2">
        {after.length ? (
          after.map((x, i) => (
            <Button
              key={x.mode}
              variant={i === 0 ? "primary" : "secondary"}
              data-testid="plan-approve"
              data-mode={x.mode}
              onClick={() => onAnswer({ kind: "plan", approve: true, mode: x.mode })}
            >
              {x.label}
            </Button>
          ))
        ) : (
          <Button
            variant="primary"
            data-testid="plan-approve"
            onClick={() => onAnswer({ kind: "plan", approve: true })}
          >
            Approve
          </Button>
        )}
        <Button
          variant="ghost"
          data-testid="plan-keep"
          onClick={() => onAnswer({ kind: "plan", approve: false, message: note })}
        >
          Keep planning
        </Button>
      </div>
      <textarea
        className={cx(
          inputClass,
          "mt-2 block h-auto! min-h-8 resize-none py-1.5 [field-sizing:content]",
        )}
        placeholder="Or say what should change…"
        rows={1}
        value={note}
        data-testid="plan-note"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && note.trim()) {
            e.preventDefault();
            onAnswer({ kind: "plan", approve: false, message: note });
          }
        }}
      />
    </AskCard>
  );
}

/**
 * a tool claude wants to run: allow it once, always (when claude suggested a rule), or turn it
 * down, with words of your own for what to do instead
 */
export function PermissionCard({
  ask,
  onAnswer,
}: {
  ask: Extract<ChatAsk, { kind: "permission" }>;
  onAnswer: (a: ChatAnswer) => void;
}) {
  const [why, setWhy] = useState("");
  const deny = () =>
    onAnswer({ kind: "permission", allow: "no", ...(why.trim() ? { message: why.trim() } : {}) });
  return (
    <AskCard
      label={`${ask.agent ? "Its agent" : "Claude"} wants to use ${ask.tool}`}
      testId="ask-permission"
    >
      {ask.agent && (
        <p className="mt-0.5 text-sm text-fg-3" data-testid="ask-agent">
          {ask.agent}
        </p>
      )}
      {ask.title && <p className="selectable mt-1 text-fg">{ask.title}</p>}
      <Mono
        className={cx(
          "selectable mt-2 block overflow-y-auto whitespace-pre-wrap break-words text-fg-2",
          // an edit: the file it is in, over what it changes
          ask.diff?.length ? "" : "max-h-48 rounded-md bg-canvas px-3 py-2",
        )}
      >
        {ask.detail}
      </Mono>
      {!!ask.diff?.length && <Diff lines={ask.diff} className="mt-1.5" />}
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          data-testid="permission-allow"
          onClick={() => onAnswer({ kind: "permission", allow: "once" })}
        >
          Allow
        </Button>
        {ask.canAlways && (
          <Button onClick={() => onAnswer({ kind: "permission", allow: "always" })}>
            Always allow
          </Button>
        )}
        <Button variant="ghost" data-testid="permission-deny" onClick={deny}>
          {why.trim() ? "Deny and say why" : "Deny"}
        </Button>
      </div>
      <input
        className={cx(inputClass, "mt-2")}
        placeholder="Or tell Claude what to do instead…"
        data-testid="permission-why"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && why.trim()) {
            e.preventDefault();
            deny();
          }
        }}
      />
    </AskCard>
  );
}

/** a model's id as people say it: claude-opus-5-5 is Opus 5.5 */
const said = (model: string) => {
  const l = modelLabel(model);
  return l.charAt(0).toUpperCase() + l.slice(1);
};

/**
 * the model turned the request down. as vs code puts it: switch to the fallback for it, or change
 * what was asked (it goes back in the composer). dismissed, claude ends the turn on the refusal
 */
export function RefusalCard({
  ask,
  onAnswer,
  onEditPrompt,
}: {
  ask: Extract<ChatAsk, { kind: "refusal" }>;
  onAnswer: (a: ChatAnswer) => void;
  onEditPrompt?: () => void;
}) {
  return (
    <AskCard label="Session paused" testId="ask-refusal">
      <p className="selectable mt-1 text-fg">
        {said(ask.model)} turned this request down
        {ask.category ? ` (${ask.category})` : ""}. {said(ask.fallback)} can take it, or you can
        change what you asked.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          data-testid="refusal-switch"
          onClick={() => onAnswer({ kind: "dialog", choice: "retry_fallback" })}
        >
          Switch to {said(ask.fallback)}
        </Button>
        <Button
          data-testid="refusal-edit"
          onClick={() => {
            onAnswer({ kind: "dialog", choice: "edit_prompt" });
            onEditPrompt?.();
          }}
        >
          Edit what you asked
        </Button>
        <Button variant="ghost" onClick={() => onAnswer({ kind: "dialog", choice: null })}>
          Dismiss
        </Button>
      </div>
    </AskCard>
  );
}

/** vs code's words for auto mode falling back to the billed classifier */
const AUTO_FALLBACK =
  "Auto mode is using Claude Code's built-in classifier in this session, and those classifier requests are billed. Continue to keep going in auto mode, or Stop to end this turn.";

export function AutoFallbackCard({
  ask,
  onAnswer,
}: {
  ask: Extract<ChatAsk, { kind: "auto-fallback" }>;
  onAnswer: (a: ChatAnswer) => void;
}) {
  return (
    <AskCard label={ask.title ?? "Auto mode"} testId="ask-auto-fallback">
      <p className="selectable mt-1 text-fg">{AUTO_FALLBACK}</p>
      {ask.paragraphs.map((p) => (
        <p key={p} className="selectable mt-1.5 text-sm text-fg-3">
          {p}
        </p>
      ))}
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          data-testid="auto-continue"
          onClick={() => onAnswer({ kind: "dialog", choice: "continue" })}
        >
          Continue
        </Button>
        <Button onClick={() => onAnswer({ kind: "dialog", choice: "interrupt" })}>Stop</Button>
      </div>
    </AskCard>
  );
}

/**
 * an MCP server asks for something: a small form from its schema, or a page to open (a sign-in).
 * Send, Decline (the server hears no), or Not now (it hears nothing was decided)
 */
export function ElicitCard({
  ask,
  onAnswer,
}: {
  ask: Extract<ChatAsk, { kind: "elicit" }>;
  onAnswer: (a: ChatAnswer) => void;
}) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const missing = ask.fields.some(
    (f) =>
      f.required && f.type !== "boolean" && (values[f.key] === undefined || values[f.key] === ""),
  );
  return (
    <AskCard label={`${ask.server} asks`} testId="ask-elicit">
      {ask.title && <p className="mt-1 font-medium text-fg">{ask.title}</p>}
      <p className="selectable mt-1 text-fg">{ask.message}</p>
      {ask.fields.map((f) => (
        <div key={f.key} className="mt-3" data-testid="elicit-field">
          <span className="block text-sm text-fg-2">
            {f.label}
            {f.required && f.type !== "boolean" && <span className="text-fg-4"> · needed</span>}
          </span>
          {f.description && <span className="block text-sm text-fg-4">{f.description}</span>}
          {f.type === "boolean" ? (
            <span className="mt-1 block">
              <Switch
                label={f.label}
                checked={values[f.key] === true}
                onChange={(on) => setValues({ ...values, [f.key]: on })}
              />
            </span>
          ) : f.type === "enum" ? (
            <Select
              aria-label={f.label}
              wrapClassName="mt-1"
              value={String(values[f.key] ?? "")}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            >
              <option value="">Pick one</option>
              {f.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          ) : (
            <input
              aria-label={f.label}
              className={cx(inputClass, "mt-1")}
              type={f.type === "number" ? "number" : "text"}
              value={String(values[f.key] ?? "")}
              onChange={(e) =>
                setValues({
                  ...values,
                  [f.key]:
                    f.type === "number" && e.target.value !== ""
                      ? Number(e.target.value)
                      : e.target.value,
                })
              }
            />
          )}
        </div>
      ))}
      <div className="mt-3 flex gap-2">
        {ask.url ? (
          <Button
            variant="primary"
            data-testid="elicit-open"
            onClick={() => {
              void window.grove.openExternal(ask.url as string);
              onAnswer({ kind: "elicit", action: "accept" });
            }}
          >
            Open {new URL(ask.url).host}
          </Button>
        ) : (
          <Button
            variant="primary"
            data-testid="elicit-send"
            disabled={missing}
            onClick={() => onAnswer({ kind: "elicit", action: "accept", content: values })}
          >
            Send
          </Button>
        )}
        <Button
          data-testid="elicit-decline"
          onClick={() => onAnswer({ kind: "elicit", action: "decline" })}
        >
          Decline
        </Button>
        <Button variant="ghost" onClick={() => onAnswer({ kind: "elicit", action: "cancel" })}>
          Not now
        </Button>
      </div>
    </AskCard>
  );
}

/** whichever card the ask is */
export function Ask({
  ask,
  modes,
  onAnswer,
  onLeave,
  autoFocus,
  onEditPrompt,
}: {
  ask: ChatAsk;
  /** the session's modes: a plan is approved into one */
  modes: readonly ChatMode[];
  onAnswer: (a: ChatAnswer) => void;
  onLeave?: () => void;
  autoFocus?: boolean;
  /** a refusal's "Edit what you asked": the prompt goes back in the composer */
  onEditPrompt?: () => void;
}) {
  if (ask.kind === "question")
    return <QuestionCard ask={ask} onAnswer={onAnswer} onLeave={onLeave} autoFocus={autoFocus} />;
  if (ask.kind === "plan") return <PlanCard ask={ask} modes={modes} onAnswer={onAnswer} />;
  if (ask.kind === "refusal")
    return <RefusalCard ask={ask} onAnswer={onAnswer} onEditPrompt={onEditPrompt} />;
  if (ask.kind === "auto-fallback") return <AutoFallbackCard ask={ask} onAnswer={onAnswer} />;
  if (ask.kind === "elicit") return <ElicitCard ask={ask} onAnswer={onAnswer} />;
  return <PermissionCard ask={ask} onAnswer={onAnswer} />;
}
