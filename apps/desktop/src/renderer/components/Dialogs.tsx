import { shortPath, type TeardownOutcome } from "@grove/core/pure";
import { useEffect, useState } from "react";
import type { AppSettings } from "../../shared/ipc.ts";
import { archiveProject, startAgent } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Button, cx, Field, inputClass, Modal, Mono, Select, Switch } from "./ui.tsx";

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
  const project = projects.find((p) => p.id === id);
  const name = project?.name ?? id;
  const home = useStore((s) => s.env?.home);
  const [running, setRunning] = useState(false);
  const [remaining, setRemaining] = useState<TeardownOutcome[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      setRemaining([]);
      setError(undefined);
    }
  }, [open]);

  async function run() {
    setRunning(true);
    const res = await window.grove.deleteProject(id);
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
          {project && !project.archived && (
            <Button
              disabled={running}
              onClick={() => {
                set({ dialog: null });
                void archiveProject(id, true);
              }}
              data-testid="archive-instead"
            >
              Archive instead
            </Button>
          )}
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
          Delete is for getting disk space back. The clean working copies are removed and the
          project folder, with its CLAUDE.md, plans and notes, goes to the Trash. Original clones
          and past sessions are not touched.
        </p>
        {project && (
          // exactly what goes to the Trash, whole: nobody has to guess which folder that is
          <p data-testid="delete-folder" title={project.root}>
            <Mono className="break-all text-fg-3">{shortPath(project.root, undefined, home)}</Mono>
          </p>
        )}
        {project && !project.archived && (
          <p data-testid="archive-hint">Archiving puts the project away and keeps everything.</p>
        )}
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

/**
 * what a background session should do. it runs with no window and nobody to ask, so it starts
 * from what is typed here. a session in the editor needs no dialog: its ask is typed there
 */
export function StartDialog() {
  const dialog = useStore((s) => s.dialog);
  const projects = useStore((s) => s.projects);
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  const set = useStore((s) => s.set);
  const project =
    dialog?.kind === "start" ? projects.find((p) => p.id === dialog.project) : undefined;
  const open = !!project;
  const [prompt, setPrompt] = useState("");
  const typed = prompt.trim();

  // every open starts empty
  useEffect(() => {
    if (open) setPrompt("");
  }, [open]);

  const close = () => set({ dialog: null });
  const start = () => {
    if (!project || !typed) return;
    // closed first: a folder the CLI has not trusted answers with a dialog of its own
    close();
    void startAgent({ project: project.id, where: "background", prompt: typed });
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Background session in ${project?.name ?? ""}`}
      width={520}
      testId="start-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!typed}
            onClick={start}
            data-testid="start-background"
          >
            Start in background
          </Button>
        </>
      }
    >
      <textarea
        data-autofocus
        aria-label="What should it do?"
        spellCheck={false}
        className={cx(inputClass, "h-24 resize-none py-2")}
        placeholder="What should it do?"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          // Enter starts it, shift-Enter is a new line. an Enter that ends an IME composition is neither
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          start();
        }}
        data-testid="start-prompt"
      />
      <p className="mt-2 text-sm text-fg-4">
        It runs with no window, so you cannot type to it. Grove tells you when it needs you, and a
        double-click moves it into {editor}.
      </p>
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
        <div>
          <span className="mb-1.5 block text-sm font-medium text-fg-2">Recaps</span>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-sm text-fg-2">Write recaps with Claude</span>
            <Switch
              checked={draft.recaps !== false}
              onChange={(v) => setDraft({ ...draft, recaps: v })}
              label="Write recaps with Claude"
              testId="setting-recaps"
            />
          </div>
          <span className="mt-1 block text-meta text-fg-3">
            A few lines on what a session was for and what it needs from you, written when it starts
            needing you or you open it. It uses your Claude login and the haiku model.
          </span>
        </div>
        {error && <p className="text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
