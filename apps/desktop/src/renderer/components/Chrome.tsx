import { useEffect, useState } from "react";
import { installCompanion } from "../state/actions.ts";
import { type Toast, useStore } from "../state/store.ts";
import { Button, cx, Icon, IconButton } from "./ui.tsx";

function ToastView({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // failures stay until someone has read them
    if (toast.level !== "info") return;
    const t = setTimeout(() => dismiss(toast.id), 5000);
    return () => clearTimeout(t);
  }, [toast, dismiss]);
  return (
    <div
      role={toast.level === "error" ? "alert" : "status"}
      data-testid="toast"
      data-level={toast.level}
      className="w-[340px] rounded-lg bg-overlay p-3 overlay-shadow"
    >
      <div className="flex items-start gap-2">
        {toast.level === "error" && <Icon name="warning" className="mt-0.5 text-accent" />}
        <div className="min-w-0 flex-1">
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
    <div className="pointer-events-none fixed right-4 bottom-10 z-30 flex flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastView toast={t} />
        </div>
      ))}
    </div>
  );
}

export function Banner() {
  const editor = useStore((s) => s.editor);
  const index = useStore((s) => s.index);
  const dismissed = useStore((s) => s.bannerDismissed);
  const set = useStore((s) => s.set);
  if (!editor || dismissed) return null;

  let message: string | null = null;
  let action: { label: string; run: () => void } | null = null;
  if (!editor.binFound) {
    message = `${editor.label} was not found at ${editor.bin}.`;
    action = { label: "Choose editor", run: () => set({ dialog: { kind: "settings" } }) };
  } else if (editor.companionState === "missing") {
    message = `Landing on a session needs the Grove extension in ${editor.label}.`;
    action = { label: "Install", run: () => void installCompanion() };
  } else if (editor.companionState === "outdated") {
    message = `The Grove extension in ${editor.label} is out of date.`;
    action = { label: "Update", run: () => void installCompanion() };
  } else if (index.phase === "degraded") {
    message =
      "Claude Code's transcript format seems to have changed. Sessions are listed by time and folder only.";
  }
  if (!message) return null;

  return (
    <div
      className={cx(
        "flex h-9 shrink-0 items-center gap-3 border-b border-line bg-raised px-4 text-sm text-fg-2",
      )}
      data-testid="banner"
    >
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {action && (
        <Button size="sm" variant="accent" onClick={action.run} data-testid="banner-action">
          {action.label}
        </Button>
      )}
      <IconButton label="Dismiss" onClick={() => set({ bannerDismissed: true })}>
        <Icon name="x" size={12} />
      </IconButton>
    </div>
  );
}
