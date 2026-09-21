import { useEffect, useRef, useState } from "react";
import type { ComboView, FolderView } from "../../shared/ipc.ts";
import { needsYou } from "../logic/rows.ts";
import { focusSearch, openCombo } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Button, cx, Icon, IconButton, Mono, Spinner, Switch } from "./ui.tsx";

const DRIFT = new Set(["stale", "foreign", "missing-origin"]);

/** drift is a normal state, not an error. each one gets plain words and the one thing that fixes it. */
function wording(f: FolderView): {
  label: string;
  detail?: string;
  action?: "create" | "recreate" | "reveal";
} {
  if (f.busy === "creating") return { label: "Creating" };
  if (f.busy === "removing") return { label: "Removing" };
  switch (f.state) {
    case "unknown":
      return { label: "Checking" };
    case "ok":
      return {
        label: f.branchLabel ?? "ready",
        detail: f.dirty ? "uncommitted changes" : undefined,
      };
    case "reference":
      return { label: "reference" };
    case "absent":
      return {
        label: "Not created yet",
        detail: "Created when you open the combo.",
        action: "create",
      };
    case "stale":
      return {
        label: "Folder was deleted",
        detail:
          "Git still lists this working copy, but the directory is gone. Recreating it also clears git's other stale worktree records for that repo.",
        action: "recreate",
      };
    case "foreign":
      return {
        label: "Something else is here",
        detail:
          "This folder exists but is not a working copy of the original repo. It has been left untouched. Move or rename it, then repair.",
        action: "reveal",
      };
    case "missing-origin":
      return {
        label: "Original repo not found",
        detail: f.message ?? `${f.path} is missing or is no longer a git repository.`,
      };
  }
}

function StateDot({ combo }: { combo: ComboView }) {
  if (combo.status === "unknown") return null;
  if (combo.folders.some((f) => f.busy)) return <Spinner size={10} />;
  const drifted = combo.folders.some((f) => DRIFT.has(f.state));
  const absent = combo.folders.some((f) => f.state === "absent");
  // quiet when everything reconciles. the accent only speaks up when something drifted.
  return (
    <span
      data-testid="state-dot"
      data-state={drifted ? "drift" : absent ? "absent" : "ok"}
      title={drifted ? "Needs attention" : absent ? "Some folders are not created yet" : "In sync"}
      className={cx(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        drifted ? "bg-accent" : absent ? "border border-fg-4" : "bg-fg-4",
      )}
    />
  );
}

function MemberStrip({ combo }: { combo: ComboView }) {
  const shown = combo.folders.slice(0, 3);
  const extra = combo.folders.length - shown.length;
  if (combo.folders.length === 0)
    return <span className="text-meta text-fg-4">no folders yet</span>;
  return (
    <span className="flex min-w-0 items-center gap-2.5 text-meta text-fg-3">
      {shown.map((f) => (
        <span
          key={f.path + f.mode}
          className={cx("flex min-w-0 items-center gap-1", DRIFT.has(f.state) && "text-accent")}
        >
          <Icon
            name={f.mode === "worktree" ? "branch" : "folder"}
            size={11}
            className="opacity-70"
          />
          <span className="truncate">{f.dirName}</span>
        </span>
      ))}
      {extra > 0 && <span className="shrink-0 text-fg-4">+{extra}</span>}
    </span>
  );
}

function FolderRow({ combo, folder }: { combo: ComboView; folder: FolderView }) {
  const toast = useStore((s) => s.toast);
  const w = wording(folder);
  const drift = DRIFT.has(folder.state);
  const act = async () => {
    if (w.action === "reveal")
      return void window.grove.reveal({
        kind: "folder",
        name: combo.name,
        folderPath: folder.path,
      });
    const res = await window.grove.repairFolder(combo.name, folder.path);
    if (!res.ok)
      toast({
        level: "error",
        title: `Could not repair ${folder.dirName}`,
        body: res.error.message,
        detail: res.error.detail,
      });
  };
  return (
    <div className="px-3 py-1.5" data-testid="folder-row" data-state={folder.state}>
      <div className="flex h-5 items-center gap-2">
        <Icon
          name={folder.mode === "worktree" ? "branch" : "folder"}
          size={12}
          className="text-fg-4"
        />
        <span className="min-w-0 shrink truncate text-sm text-fg-2" title={folder.path}>
          {folder.dirName}
        </span>
        <span
          className={cx(
            "ml-auto flex min-w-0 shrink-0 items-center gap-1.5 text-meta",
            drift ? "text-accent" : "text-fg-3",
          )}
        >
          {(folder.busy || folder.state === "unknown") && <Spinner size={10} />}
          {folder.state === "ok" && !folder.busy ? (
            <Mono className="max-w-36 truncate">{w.label}</Mono>
          ) : (
            <span>{w.label}</span>
          )}
        </span>
      </div>
      {w.detail && <p className="mt-0.5 pl-5 text-meta text-fg-3">{w.detail}</p>}
      {w.action && !folder.busy && (
        <div className="mt-1 pl-5">
          <Button
            size="sm"
            variant={drift ? "accent" : "ghost"}
            className="-ml-2"
            onClick={() => void act()}
            data-testid="folder-action"
          >
            {w.action === "create"
              ? "Create"
              : w.action === "recreate"
                ? "Recreate"
                : "Reveal in Finder"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** takes effect on a running session's next long task: claude reads the policy file each time */
function LongWorkRow({ combo }: { combo: ComboView }) {
  const toast = useStore((s) => s.toast);
  const on = combo.longWork === "background";
  const flip = async (next: boolean) => {
    const res = await window.grove.setLongWork(combo.name, next ? "background" : "foreground");
    if (!res.ok) toast({ level: "error", title: "Could not change that", body: res.error.message });
  };
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5"
      title="When on, Claude hands long tasks to a background agent, so the conversation stays free to talk and plan. Sessions that are already running pick the change up on their next long task."
    >
      <span className="min-w-0 flex-1 text-sm text-fg-2">Long work in background</span>
      <Switch
        checked={on}
        onChange={(next) => void flip(next)}
        label="Run long work in the background"
        testId="long-work-switch"
      />
    </div>
  );
}

function ComboMenu({ combo, onClose }: { combo: ComboView; onClose: () => void }) {
  const set = useStore((s) => s.set);
  const hasWorktrees = combo.folders.some((f) => f.mode === "worktree");
  const items: Array<[string, () => void, boolean?]> = [
    ["Edit combo", () => set({ dialog: { kind: "combo", editing: combo.name } })],
    [
      "Repair all",
      () => void window.grove.repairCombo(combo.name),
      !combo.folders.some((f) => DRIFT.has(f.state) || f.state === "absent"),
    ],
    [
      "Tear down worktrees",
      () => set({ dialog: { kind: "teardown", name: combo.name } }),
      !hasWorktrees,
    ],
    ["Reveal in Finder", () => void window.grove.reveal({ kind: "combo", name: combo.name })],
    ["Delete combo", () => set({ dialog: { kind: "delete", name: combo.name } })],
  ];
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} role="presentation" />
      <div
        role="menu"
        className="absolute right-2 z-50 mt-1 w-48 rounded-lg bg-overlay p-1.5 overlay-shadow"
        data-testid="combo-menu"
      >
        {items.map(([label, run, disabled]) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => {
              onClose();
              run();
            }}
            className="flex h-7 w-full items-center rounded-md px-2.5 text-left text-sm text-fg-2 hover:bg-active hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

function ComboRow({ combo, selected }: { combo: ComboView; selected: boolean }) {
  const selectCombo = useStore((s) => s.selectCombo);
  const label = useStore((s) => s.editor?.label ?? "editor");
  const waiting = useStore(
    (s) => s.sessions.filter((r) => r.comboName === combo.name && needsYou(r.live)).length,
  );
  const [menu, setMenu] = useState(false);
  return (
    <li
      role="treeitem"
      aria-expanded={selected}
      aria-selected={selected}
      aria-level={1}
      data-testid="combo-row"
      data-selected={selected || undefined}
    >
      <button
        type="button"
        data-rail-item
        onClick={() => {
          selectCombo(selected ? null : combo.name);
          focusSearch(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            void openCombo(combo.name);
          }
        }}
        className={cx(
          "fade flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left",
          selected ? "bg-active" : "hover:bg-raised",
        )}
      >
        <span className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-fg">{combo.name}</span>
          {waiting > 0 && (
            <span
              data-testid="combo-needs-you"
              title={`${waiting} ${waiting === 1 ? "session needs" : "sessions need"} you`}
              className="rounded-full bg-accent-soft px-1.5 text-meta font-medium text-accent tabular-nums"
            >
              {waiting}
            </span>
          )}
          <StateDot combo={combo} />
        </span>
        <MemberStrip combo={combo} />
      </button>
      {selected && (
        <div className="relative mt-1 mb-2 rounded-md border border-line py-1">
          {combo.note && <p className="px-3 pt-1 pb-1.5 text-sm text-fg-3">{combo.note}</p>}
          {combo.folders.map((f) => (
            <FolderRow key={f.path + f.mode} combo={combo} folder={f} />
          ))}
          <LongWorkRow combo={combo} />
          <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
            <Button
              variant="primary"
              className="flex-1"
              onClick={() => void openCombo(combo.name)}
              data-testid="open-combo"
            >
              Open in {label}
            </Button>
            <IconButton
              label="More"
              className="h-7 w-7"
              onClick={() => setMenu((v) => !v)}
              data-testid="combo-more"
            >
              <Icon name="more" />
            </IconButton>
          </div>
          {menu && <ComboMenu combo={combo} onClose={() => setMenu(false)} />}
        </div>
      )}
    </li>
  );
}

export function Rail() {
  const combos = useStore((s) => s.combos);
  const problem = useStore((s) => s.combosProblem);
  const selected = useStore((s) => s.selectedCombo);
  const total = useStore((s) => s.sessions.length);
  const index = useStore((s) => s.index);
  const set = useStore((s) => s.set);
  const tree = useRef<HTMLUListElement>(null);

  // arrow keys move between combo rows once focus is in the rail
  useEffect(() => {
    const el = tree.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = [...el.querySelectorAll<HTMLElement>("[data-rail-item]")];
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      e.preventDefault();
      e.stopPropagation();
      items[
        Math.min(items.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))
      ]?.focus();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      className="flex h-full min-h-0 w-[288px] shrink-0 flex-col border-r border-line bg-rail"
      aria-label="Combos"
    >
      <header className="drag flex h-[52px] shrink-0 items-center justify-between pr-3 pl-[84px]">
        <span className="text-sm font-medium text-fg-3">Combos</span>
        <IconButton
          label="New combo (⌘N)"
          onClick={() => set({ dialog: { kind: "combo" } })}
          data-testid="new-combo"
        >
          <Icon name="plus" />
        </IconButton>
      </header>

      {problem && (
        <p
          className="mx-3 mb-2 rounded-md bg-accent-soft px-3 py-2 text-sm text-fg-2"
          data-testid="combos-problem"
        >
          combos.json could not be read, so it was left untouched: {problem}
        </p>
      )}

      {combos.length === 0 ? (
        <div className="flex flex-1 flex-col justify-center px-6 pb-16" data-testid="rail-empty">
          <h2 className="text-title font-semibold">No combos yet</h2>
          <p className="mt-2 text-fg-3">
            A combo is a named folder that gathers the repos one task needs - working copies you
            edit and references you read - so every Claude session started there stays together.
          </p>
          <Button
            variant="primary"
            className="mt-5 self-start"
            onClick={() => set({ dialog: { kind: "combo" } })}
            data-testid="empty-new-combo"
          >
            New combo
          </Button>
        </div>
      ) : (
        <ul
          ref={tree}
          role="tree"
          aria-label="Combos"
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2"
        >
          {combos.map((c) => (
            <ComboRow key={c.name} combo={c} selected={c.name === selected} />
          ))}
        </ul>
      )}

      <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-line px-3 text-meta text-fg-3">
        <IconButton
          label="Settings (⌘,)"
          onClick={() => set({ dialog: { kind: "settings" } })}
          data-testid="open-settings"
        >
          <Icon name="settings" />
        </IconButton>
        <span className="ml-auto tabular-nums" data-testid="rail-count">
          {index.phase === "scanning" && index.total > 0
            ? `reading ${index.done}/${index.total}`
            : `${total} sessions`}
        </span>
      </footer>
    </aside>
  );
}
