import type { TeardownOutcome } from "@grove/core/pure";
import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../shared/ipc.ts";
import { runAction } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Button, cx, Field, Icon, inputClass, Modal, Mono, Spinner, Switch } from "./ui.tsx";

function baseName(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

const OUTCOME: Record<TeardownOutcome["action"], string> = {
  removed: "Removed",
  "skipped-dirty": "Kept - it has uncommitted changes",
  "skipped-locked": "Kept - the worktree is locked",
  untouched: "Left alone",
  failed: "Could not be removed",
};

export function TeardownDialog() {
  const dialog = useStore((s) => s.dialog);
  const combos = useStore((s) => s.combos);
  const set = useStore((s) => s.set);
  const open = dialog?.kind === "teardown";
  const name = open ? dialog.name : "";
  const combo = combos.find((c) => c.name === name);
  const [results, setResults] = useState<TeardownOutcome[] | null>(null);
  const [running, setRunning] = useState(false);
  const [confirm, setConfirm] = useState<TeardownOutcome | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setResults(null);
    setConfirm(null);
    setError(undefined);
    // dirtiness is only fetched when someone is about to act on it
    void window.grove.reconcile(name, true);
  }, [open, name]);

  const worktrees = combo?.folders.filter((f) => f.mode === "worktree") ?? [];
  const close = () => set({ dialog: null });

  async function run() {
    setRunning(true);
    const res = await window.grove.teardownCombo(name);
    setRunning(false);
    if (!res.ok) return setError(res.error.message);
    setResults(res.value.filter((o) => o.folder.mode === "worktree"));
  }

  async function force(target: TeardownOutcome) {
    setConfirm(null);
    setRunning(true);
    const res = await window.grove.forceRemoveFolder(name, target.folder.path);
    setRunning(false);
    if (!res.ok) return setError(res.error.message);
    setResults(
      (rs) => rs?.map((r) => (r.folder.path === target.folder.path ? res.value : r)) ?? null,
    );
  }

  return (
    <>
      <Modal
        open={open && !confirm}
        onClose={close}
        title={`Tear down ${name}`}
        testId="teardown-dialog"
        footer={
          results ? (
            <Button variant="primary" onClick={close} data-testid="teardown-done">
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={running || worktrees.length === 0}
                onClick={() => void run()}
                data-testid="teardown-run"
              >
                {running ? "Removing" : "Remove clean worktrees"}
              </Button>
            </>
          )
        }
      >
        <p className="text-fg-3">
          Removes the working copies inside the combo folder. Your original clones, their branches,
          and the combo's CLAUDE.md are never touched.
        </p>
        <ul className="mt-3 divide-y divide-line rounded-md border border-line">
          {(
            results ??
            worktrees.map((f) => ({
              folder: { path: f.path },
              target: f.dirName,
              action: undefined,
              dirty: f.dirty,
              state: f.state,
            }))
          ).map((item) => {
            const outcome = "message" in item || item.action ? (item as TeardownOutcome) : null;
            const pending = item as { dirty?: boolean; state?: string };
            return (
              <li
                key={item.folder.path}
                className="flex items-center gap-3 px-3 py-2"
                data-testid="teardown-item"
                data-action={outcome?.action}
              >
                <Icon name="branch" className="text-fg-4" />
                <span className="font-medium">{baseName(item.target)}</span>
                <span
                  className={cx(
                    "ml-auto text-sm",
                    outcome?.action === "skipped-dirty" || outcome?.action === "failed"
                      ? "text-accent"
                      : "text-fg-3",
                  )}
                >
                  {outcome
                    ? OUTCOME[outcome.action]
                    : pending.state === "unknown"
                      ? "Checking"
                      : pending.dirty
                        ? "Has uncommitted changes - will be kept"
                        : pending.state === "ok"
                          ? "Will be removed"
                          : "Nothing to remove"}
                </span>
                {outcome?.action === "skipped-dirty" && (
                  <Button
                    size="sm"
                    variant="accent"
                    onClick={() => setConfirm(outcome)}
                    data-testid="force-remove"
                  >
                    Discard and remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {running && (
          <p className="mt-3 flex items-center gap-2 text-fg-3">
            <Spinner /> Working
          </p>
        )}
        {error && <p className="mt-3 text-accent">{error}</p>}
      </Modal>

      {/* force is never a checkbox on the first dialog. it is its own decision, per folder. */}
      <Modal
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title="Discard uncommitted work?"
        width={460}
        testId="force-dialog"
        footer={
          <>
            <Button variant="secondary" autoFocus onClick={() => setConfirm(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirm && void force(confirm)}
              data-testid="force-confirm"
            >
              Discard and remove
            </Button>
          </>
        }
      >
        {confirm && (
          <div className="space-y-2 text-fg-2">
            <p>
              <span className="font-medium text-fg">{baseName(confirm.target)}</span> has changes
              that are not committed anywhere. Removing it deletes them for good.
            </p>
            {confirm.dirtyPaths && confirm.dirtyPaths.length > 0 && (
              <ul className="selectable max-h-32 overflow-y-auto rounded-md bg-canvas p-2">
                {confirm.dirtyPaths.map((p) => (
                  <li key={p}>
                    <Mono>{p}</Mono>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

export function DeleteComboDialog() {
  const dialog = useStore((s) => s.dialog);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const open = dialog?.kind === "delete";
  const name = open ? dialog.name : "";
  const [trash, setTrash] = useState(false);
  const [running, setRunning] = useState(false);
  const [remaining, setRemaining] = useState<TeardownOutcome[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      setTrash(false);
      setRemaining([]);
      setError(undefined);
    }
  }, [open]);

  async function run() {
    setRunning(true);
    const res = await window.grove.deleteCombo(name, trash);
    setRunning(false);
    if (!res.ok) return setError(res.error.message);
    if (res.value.remaining.length > 0) return setRemaining(res.value.remaining);
    set({ dialog: null });
    toast({ level: "info", title: `Deleted ${name}` });
  }

  return (
    <Modal
      open={open}
      onClose={() => set({ dialog: null })}
      title={`Delete ${name}?`}
      width={480}
      testId="delete-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={() => set({ dialog: null })}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={running}
            onClick={() => void run()}
            data-testid="delete-confirm"
          >
            {running ? "Deleting" : "Delete combo"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-fg-2">
        <p>
          Clean working copies are removed first, then the combo leaves the list. Original clones
          and past sessions are not touched. Sessions stay searchable under All sessions.
        </p>
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={trash}
            onChange={(e) => setTrash(e.target.checked)}
            className="mt-1"
            data-testid="trash-root"
          />
          <span>
            Also move the combo folder to the Trash
            <span className="block text-meta text-fg-3">
              It holds your CLAUDE.md and .claude settings, so this is off by default.
            </span>
          </span>
        </label>
        {remaining.length > 0 && (
          <div
            className="rounded-md bg-accent-soft px-3 py-2 text-sm text-fg"
            data-testid="delete-blocked"
          >
            Not deleted yet. These working copies could not be removed without losing work:
            <ul className="mt-1">
              {remaining.map((r) => (
                <li key={r.target}>
                  {baseName(r.target)} - {OUTCOME[r.action].toLowerCase()}
                </li>
              ))}
            </ul>
            Commit or discard the changes, or use Tear down worktrees.
          </div>
        )}
        {error && <p className="text-accent">{error}</p>}
      </div>
    </Modal>
  );
}

/** one question before an action that interrupts something. Cancel is where the keyboard starts. */
export function ConfirmDialog() {
  const dialog = useStore((s) => s.dialog);
  const set = useStore((s) => s.set);
  const open = dialog?.kind === "confirm";
  const confirm = open ? dialog.action.confirm : undefined;
  const close = () => set({ dialog: null });
  return (
    <Modal
      open={open && !!confirm}
      onClose={close}
      title={confirm?.title ?? ""}
      width={440}
      testId="confirm-dialog"
      footer={
        <>
          <Button variant="secondary" autoFocus onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="confirm-run"
            onClick={() => {
              if (dialog?.kind !== "confirm") return;
              close();
              void runAction(dialog.key, dialog.action.id);
            }}
          >
            {confirm?.label}
          </Button>
        </>
      }
    >
      <p className="text-fg-2">{confirm?.body}</p>
    </Modal>
  );
}

/**
 * the prompt a background session starts from, typed or checked by the person. Claude Code's
 * supervisor runs it from here on; Grove only hands it over. a folder the CLI never trusted gets
 * one way through: the same command in Terminal, where the trust prompt can be answered.
 */
export function BackgroundDialog() {
  const dialog = useStore((s) => s.dialog);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const open = dialog?.kind === "background";
  const target = open ? dialog.target : null;
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setPrompt(dialog.prompt);
    setName("");
    setError(null);
    setRunning(false);
    // after the modal opened (a parent's effect runs after its children's), or it takes focus back
    field.current?.focus();
  }, [open, dialog]);

  const close = () => set({ dialog: null });
  const empty = prompt.trim() === "";

  async function run(terminal: boolean) {
    if (!target || empty) return;
    setRunning(true);
    const res = await window.grove.dispatchBackground({
      ...(target.kind === "continue"
        ? { kind: "continue" as const, key: target.key }
        : { kind: "new" as const, combo: target.combo, ...(name.trim() ? { name } : {}) }),
      prompt,
      ...(terminal ? { terminal: true } : {}),
    });
    setRunning(false);
    if (!res.ok) return setError(res.error);
    close();
    toast({ level: "info", title: res.value.message });
  }

  const title =
    target?.kind === "new" ? `New background session in ${target.combo}` : "Continue in background";
  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      width={520}
      testId="background-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {error?.code === "not-trusted" && (
            <Button
              variant="secondary"
              disabled={running || empty}
              onClick={() => void run(true)}
              data-testid="bg-terminal"
            >
              Continue in Terminal
            </Button>
          )}
          <Button
            variant="primary"
            disabled={running || empty}
            onClick={() => void run(false)}
            data-testid="bg-run"
          >
            {running ? "Handing over" : target?.kind === "new" ? "Start" : "Continue in background"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-fg-3">
          {target?.kind === "new"
            ? "Claude Code's own supervisor runs it in the combo folder. It keeps going after every window closes."
            : "Claude Code's own supervisor picks this conversation up where it stopped, and keeps it going after every window closes."}{" "}
          A permission prompt puts it under Needs you. Open in Terminal (attach) answers it.
        </p>
        {target?.kind === "new" && (
          <Field label="Name" hint="Optional. Shown in claude agents and in the list here.">
            <input
              className={inputClass}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              data-testid="bg-name"
            />
          </Field>
        )}
        <Field label="Prompt" hint="Sent as it is, once you press the button.">
          <textarea
            className={cx(inputClass, "h-auto min-h-24 resize-y py-1.5 leading-5")}
            rows={4}
            value={prompt}
            ref={field}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void run(false);
              }
            }}
            data-testid="bg-prompt"
          />
        </Field>
        {error && (
          <p className="text-accent" data-testid="bg-error" data-code={error.code}>
            {error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function SettingsDialog() {
  const dialog = useStore((s) => s.dialog);
  const settings = useStore((s) => s.settings);
  const editor = useStore((s) => s.editor);
  const set = useStore((s) => s.set);
  const open = dialog?.kind === "settings";
  const [draft, setDraft] = useState<AppSettings>({ editor: "vscode", appearance: "system" });
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open && settings) setDraft(settings);
  }, [open, settings]);

  const text = (
    key: "editorBin" | "gitPath" | "claudePath" | "claudeConfigDir",
    placeholder: string,
  ) => (
    <input
      className={cx(inputClass, "font-mono text-meta")}
      spellCheck={false}
      placeholder={placeholder}
      value={draft[key] ?? ""}
      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      data-testid={`setting-${key}`}
    />
  );

  async function save() {
    const res = await window.grove.updateSettings(draft);
    if (!res.ok) return setError(res.error.message);
    set({ settings: res.value, dialog: null });
    void window.grove.editorStatus(true).then((e) => set({ editor: e }));
  }

  return (
    <Modal
      open={open}
      onClose={() => set({ dialog: null })}
      title="Settings"
      width={520}
      testId="settings-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={() => set({ dialog: null })}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} data-testid="save-settings">
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Appearance"
          hint="System follows macOS, including when it switches at sunset."
        >
          <select
            className={inputClass}
            value={draft.appearance}
            onChange={(e) =>
              setDraft({ ...draft, appearance: e.target.value as AppSettings["appearance"] })
            }
            data-testid="setting-appearance"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Field>
        <Field label="Editor">
          <select
            className={inputClass}
            value={draft.editor}
            onChange={(e) =>
              setDraft({ ...draft, editor: e.target.value as AppSettings["editor"] })
            }
            data-testid="setting-editor"
          >
            <option value="vscode">VS Code</option>
            <option value="cursor">Cursor</option>
          </select>
        </Field>
        <Field
          label="Editor command"
          hint="Absolute path. An app opened from Finder does not see your shell PATH."
        >
          {text("editorBin", editor?.bin ?? "")}
        </Field>
        <Field label="git">{text("gitPath", "auto-detect")}</Field>
        <Field label="claude">{text("claudePath", "auto-detect")}</Field>
        <Field label="Claude Code config folder">{text("claudeConfigDir", "~/.claude")}</Field>
        <Field
          label="Sessions parsed per scan"
          hint="Older sessions beyond this still show, by time and folder only."
        >
          <input
            type="number"
            min={100}
            className={inputClass}
            value={draft.maxParsedSessions ?? 5000}
            onChange={(e) =>
              setDraft({ ...draft, maxParsedSessions: Number(e.target.value) || undefined })
            }
          />
        </Field>
        {/* not a Field: that is a <label>, and a click on either line would flip the first switch */}
        <div>
          <span className="mb-1 block text-sm text-fg-2">Sessions that need you</span>
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-sm text-fg-2">
                Notify when a session needs permission or finishes a long turn
              </span>
              <Switch
                checked={draft.notifications !== false}
                onChange={(v) => setDraft({ ...draft, notifications: v })}
                label="Notifications"
                testId="setting-notifications"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-sm text-fg-2">
                Track sessions outside combos too
              </span>
              <Switch
                checked={draft.trackAllSessions === true}
                onChange={(v) => setDraft({ ...draft, trackAllSessions: v })}
                label="Track sessions outside combos"
                testId="setting-track-all"
              />
            </div>
          </div>
          <span className="mt-1 block text-meta text-fg-3">
            Combos report this on their own. Outside combos it takes a few hooks in Claude Code's
            own settings.json, which Grove otherwise never touches.
          </span>
        </div>
        <div>
          <span className="mb-1 block text-sm text-fg-2">Agents</span>
          <div className="flex items-center gap-2 pt-1">
            <span className="min-w-0 flex-1 text-sm text-fg-2">
              Summarise what each running agent is doing
            </span>
            <Switch
              checked={draft.agentSummaries !== false}
              onChange={(v) => setDraft({ ...draft, agentSummaries: v })}
              label="Agent summaries"
              testId="setting-agent-summaries"
            />
          </div>
          <span className="mt-1 block text-meta text-fg-3">
            Reads the agent's own transcript with Claude Haiku, every 30s while the window is open.
            A finished agent gets one line on what it found, once, the first time you look at it. It
            spends your Claude subscription, and never interrupts the session doing the work.
          </span>
        </div>
        {error && <p className="text-accent">{error}</p>}
      </div>
    </Modal>
  );
}
