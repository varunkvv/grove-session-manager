import { useEffect, useState } from "react";
import { editProject, installCompanion } from "../state/actions.ts";
import { currentProject, type Toast, useStore } from "../state/store.ts";
import { Button, Icon, IconButton } from "./ui.tsx";

function ToastView({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // failures stay until someone has read them
    if (toast.level !== "info") return;
    const t = setTimeout(() => dismiss(toast.id), toast.body ? 5000 : 1800);
    return () => clearTimeout(t);
  }, [toast, dismiss]);
  if (toast.level === "info") {
    return (
      <div
        role="status"
        data-testid="toast"
        data-level="info"
        className="max-w-[420px] rounded-md bg-fg px-3 py-1.5 text-sm text-canvas"
      >
        <p>{toast.title}</p>
        {toast.body && <p className="opacity-80">{toast.body}</p>}
      </div>
    );
  }
  return (
    <div
      role="alert"
      data-testid="toast"
      data-level="error"
      className="w-[340px] rounded-lg bg-overlay p-3 overlay-shadow"
    >
      <div className="flex items-start gap-2">
        <Icon name="warning" className="mt-0.5 text-danger" />
        {/* a path has no spaces to wrap at */}
        <div className="min-w-0 flex-1 break-words">
          <p className="font-medium">{toast.title}</p>
          {toast.body && <p className="mt-0.5 text-sm text-fg-3">{toast.body}</p>}
          {toast.detail && (
            <button
              type="button"
              className="mt-1 text-meta text-fg-3 underline"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Hide details" : "Details"}
            </button>
          )}
          {open && toast.detail && (
            <pre className="selectable mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-2 font-mono text-meta text-fg-2">
              {toast.detail}
            </pre>
          )}
        </div>
        <IconButton label="Dismiss" onClick={() => dismiss(toast.id)}>
          <Icon name="x" size={12} />
        </IconButton>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastView toast={t} />
        </div>
      ))}
    </div>
  );
}

/** one message at a time, the first that applies. a project's is only ever about the one on screen */
export function Banner() {
  const editor = useStore((s) => s.editor);
  const problem = useStore((s) => s.projectsProblem);
  // the inbox is every project's: one project's files are not its news
  const project = useStore((s) => (s.view.name === "inbox" ? undefined : currentProject(s)));
  const dismissed = useStore((s) => s.bannerDismissed);
  const set = useStore((s) => s.set);
  if (!editor) return null;

  let reason: string;
  let message: string;
  let action: { label: string; run: () => void } | null = null;
  if (!editor.binFound) {
    reason = "editor-missing";
    message = `${editor.label} was not found at ${editor.bin}.`;
    action = { label: "Choose editor", run: () => set({ dialog: { kind: "settings" } }) };
  } else if (editor.companionState === "missing") {
    reason = "companion-missing";
    message = `Landing on a session needs the Grove extension in ${editor.label}.`;
    action = { label: "Install", run: () => void installCompanion() };
  } else if (editor.companionState === "outdated") {
    reason = "companion-outdated";
    message = `The Grove extension in ${editor.label} is out of date.`;
    action = { label: "Update", run: () => void installCompanion() };
  } else if (problem) {
    reason = "projects-problem";
    message = problem;
  } else if (project?.syncProblem) {
    reason = "sync";
    message = `Grove could not update ${project.name}'s files. ${project.syncProblem}`;
    action = { label: "Details", run: editProject };
  } else return null;
  // it comes back when its reason changes
  if (dismissed === reason) return null;

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-raised px-4 text-sm text-fg-2"
      data-testid="banner"
      data-reason={reason}
    >
      <span className="min-w-0 flex-1 truncate" title={message}>
        {message}
      </span>
      {action && (
        <Button size="sm" onClick={action.run} data-testid="banner-action">
          {action.label}
        </Button>
      )}
      <IconButton label="Dismiss" onClick={() => set({ bannerDismissed: reason })}>
        <Icon name="x" size={12} />
      </IconButton>
    </div>
  );
}
