import { useEffect, useRef, useState } from "react";
import {
  EFFORTS,
  MODELS,
  type NewSessionRequest,
  type NewSessionWhere,
  PERMISSION_MODES,
} from "../../shared/newSession.ts";
import {
  browserStorage,
  DEFAULT_CHOICES,
  loadChoices,
  longWorkHint,
  longWorkOptions,
  type NewSessionChoices,
  primaryLabel,
  promptHint,
  saveChoices,
  whereHint,
} from "../logic/newSession.ts";
import { useStore } from "../state/store.ts";
import { Button, cx, Field, inputClass, Modal, Segmented } from "./ui.tsx";

/**
 * one way to start something in a combo: the editor on a new conversation, claude in Terminal, or
 * Claude Code's supervisor. model, mode and effort only reach the CLI - the Claude panel takes
 * nothing but a prompt from outside.
 */
export function NewSessionDialog() {
  const dialog = useStore((s) => s.dialog);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const editorLabel = useStore((s) => s.editor?.label ?? "the editor");
  const open = dialog?.kind === "new-session";
  const comboName = open ? dialog.combo : "";
  const combo = useStore((s) => s.combos.find((c) => c.name === comboName));
  const [choices, setChoices] = useState<NewSessionChoices>(DEFAULT_CHOICES);
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  // on the combo, not the dialog object: a second cmd-T while open must not wipe what was typed
  useEffect(() => {
    if (!open) return;
    setChoices(loadChoices(browserStorage(), comboName));
    setPrompt("");
    setName("");
    setError(null);
    setRunning(false);
    // after the modal opened (a parent's effect runs after its children's), or it takes focus back
    field.current?.focus();
  }, [open, comboName]);

  const where = choices.where;
  const cli = where !== "editor";
  const blocked = running || (where === "background" && prompt.trim() === "");
  const close = () => set({ dialog: null });
  const choose = (patch: Partial<NewSessionChoices>) => {
    setChoices((c) => ({ ...c, ...patch }));
    setError(null);
  };

  async function run(throughTerminal = false) {
    if (!open || blocked) return;
    setRunning(true);
    const req: NewSessionRequest = {
      combo: comboName,
      where,
      prompt,
      ...(choices.longWork !== "combo" ? { longWork: choices.longWork } : {}),
      ...(cli && choices.model ? { model: choices.model } : {}),
      ...(cli && choices.mode ? { mode: choices.mode } : {}),
      ...(cli && choices.effort ? { effort: choices.effort } : {}),
      ...(cli && name.trim() ? { name } : {}),
      ...(throughTerminal ? { throughTerminal: true } : {}),
    };
    const res = await window.grove.startSession(req);
    setRunning(false);
    if (!res.ok) return setError(res.error);
    saveChoices(browserStorage(), comboName, choices);
    close();
    toast({
      level: "info",
      title: res.value.message,
      ...(res.value.body ? { body: res.value.body } : {}),
    });
  }

  // cmd-enter presses the button from anywhere in the dialog. the app's own keys stand down
  // while a dialog is open, so nothing else acts on it.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      void runRef.current(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const select = (
    label: string,
    value: string,
    options: ReadonlyArray<{ value: string; label: string }>,
    onChange: (v: string) => void,
    testId: string,
  ) => (
    <Field label={label}>
      <select
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      >
        <option value="">Default</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <Modal
      open={open}
      onClose={close}
      title={`New session in ${comboName}`}
      width={520}
      testId="new-session-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {where === "background" && error?.code === "not-trusted" && (
            <Button
              variant="secondary"
              disabled={blocked}
              onClick={() => void run(true)}
              data-testid="ns-terminal"
            >
              Continue in Terminal
            </Button>
          )}
          <Button
            variant="primary"
            disabled={blocked}
            onClick={() => void run(false)}
            data-testid="ns-run"
            data-where={where}
          >
            {running
              ? where === "background"
                ? "Starting"
                : "Opening"
              : primaryLabel(where, editorLabel)}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* not a Field: that is a <label>, and a click on its text would press the first segment */}
        <div>
          <span className="mb-1 block text-sm text-fg-2">Where</span>
          <Segmented<NewSessionWhere>
            label="Where"
            value={where}
            onChange={(v) => choose({ where: v })}
            options={[
              { value: "editor", label: editorLabel, testId: "ns-where-editor" },
              { value: "terminal", label: "Terminal", testId: "ns-where-terminal" },
              { value: "background", label: "Background", testId: "ns-where-background" },
            ]}
          />
          <span className="mt-1 block text-meta text-fg-3">{whereHint(where, editorLabel)}</span>
        </div>
        <Field label="Prompt" hint={promptHint(where)}>
          <textarea
            className={cx(inputClass, "h-auto min-h-24 resize-y py-1.5 leading-5")}
            rows={4}
            value={prompt}
            ref={field}
            onChange={(e) => setPrompt(e.target.value)}
            data-testid="ns-prompt"
          />
        </Field>
        <Field label="Long work" hint={longWorkHint(where, choices.longWork)}>
          <select
            className={inputClass}
            value={choices.longWork}
            onChange={(e) => choose({ longWork: e.target.value as NewSessionChoices["longWork"] })}
            data-testid="ns-long-work"
          >
            {longWorkOptions(combo?.longWork ?? "background").map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {cli ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              {select(
                "Model",
                choices.model,
                MODELS,
                (v) => choose({ model: v as NewSessionChoices["model"] }),
                "ns-model",
              )}
              {select(
                "Mode",
                choices.mode,
                PERMISSION_MODES,
                (v) => choose({ mode: v as NewSessionChoices["mode"] }),
                "ns-mode",
              )}
              {select(
                "Effort",
                choices.effort,
                EFFORTS,
                (v) => choose({ effort: v as NewSessionChoices["effort"] }),
                "ns-effort",
              )}
            </div>
            <Field label="Name" hint="Optional. Shown in claude agents and the resume picker.">
              <input
                className={inputClass}
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
                data-testid="ns-name"
              />
            </Field>
          </>
        ) : (
          <p className="text-meta text-fg-3" data-testid="ns-panel-note">
            The Claude panel picks the model and permission mode.
          </p>
        )}
        {error && (
          <p className="text-accent" data-testid="ns-error" data-code={error.code}>
            {error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}
