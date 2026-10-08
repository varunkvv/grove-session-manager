import type { TeardownOutcome } from "@grove/core/pure";
import { useEffect, useState } from "react";
import type { AppSettings } from "../../shared/ipc.ts";
import { useStore } from "../state/store.ts";
import { Button, cx, Field, inputClass, Modal, Select, Switch } from "./ui.tsx";

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

export function DeleteProjectDialog() {
  const dialog = useStore((s) => s.dialog);
  const projects = useStore((s) => s.projects);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const open = dialog?.kind === "delete";
  const id = open ? dialog.project : "";
  const name = projects.find((p) => p.id === id)?.name ?? id;
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
    const res = await window.grove.deleteProject(id, trash);
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
            {running ? "Deleting" : "Delete project"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-fg-2">
        <p>
          Clean working copies are removed first, then the project leaves the list. Original clones
          and past sessions are not touched.
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
            Also move the project folder to the Trash
            <span className="block text-meta text-fg-3">
              It holds your CLAUDE.md, .claude settings, plans and notes, so this is off by default.
            </span>
          </span>
        </label>
        {remaining.length > 0 && (
          <div
            className="rounded-md border border-line px-3 py-2 text-sm text-fg"
            data-testid="delete-blocked"
          >
            Not deleted yet. These working copies could not be removed without losing work:
            <ul className="mt-1 text-danger">
              {remaining.map((r) => (
                <li key={r.target}>
                  {baseName(r.target)} - {OUTCOME[r.action].toLowerCase()}
                </li>
              ))}
            </ul>
            Commit or discard the changes in them, then delete again.
          </div>
        )}
        {error && <p className="text-danger">{error}</p>}
      </div>
    </Modal>
  );
}

/** one question before something that interrupts or costs. Cancel is where the keyboard starts. */
export function ConfirmDialog() {
  const dialog = useStore((s) => s.dialog);
  const set = useStore((s) => s.set);
  const confirm = dialog?.kind === "confirm" ? dialog : null;
  const close = () => set({ dialog: null });
  return (
    <Modal
      open={!!confirm}
      onClose={close}
      title={confirm?.title ?? ""}
      width={440}
      testId="confirm-dialog"
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="confirm-run"
            onClick={() => {
              close();
              confirm?.run();
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
      {/* 3.5, not 4: with both switches the dialog still fits a window of the default height */}
      <div className="space-y-3.5">
        <Field
          label="Appearance"
          hint="System follows macOS, including when it switches at sunset."
        >
          <Select
            value={draft.appearance}
            onChange={(e) =>
              setDraft({ ...draft, appearance: e.target.value as AppSettings["appearance"] })
            }
            data-testid="setting-appearance"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
        </Field>
        <Field label="Editor">
          <Select
            value={draft.editor}
            onChange={(e) =>
              setDraft({ ...draft, editor: e.target.value as AppSettings["editor"] })
            }
            data-testid="setting-editor"
          >
            <option value="vscode">VS Code</option>
            <option value="cursor">Cursor</option>
          </Select>
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
        {/* not a Field: that is a <label>, and a click on either line would flip the first switch */}
        <div>
          <span className="mb-1.5 block text-sm font-medium text-fg-2">Notifications</span>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-sm text-fg-2">
                Notify when an agent asks you something, needs permission, stops mid-turn or
                finishes a long turn
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
                Track sessions outside projects too
              </span>
              <Switch
                checked={draft.trackAllSessions === true}
                onChange={(v) => setDraft({ ...draft, trackAllSessions: v })}
                label="Track sessions outside projects"
                testId="setting-track-all"
              />
            </div>
          </div>
          <span className="mt-1 block text-meta text-fg-3">
            Projects report this on their own. Outside projects it takes a few hooks in Claude
            Code's own settings.json, which Grove otherwise never touches.
          </span>
        </div>
        {error && <p className="text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
