// what a session's action menu offers. pure: the handler gathers the facts, this decides.
import type { SessionAction, SessionRow } from "../../shared/ipc.ts";

export interface ActionFacts {
  row: SessionRow;
  /** "VS Code" or "Cursor" */
  editorLabel: string;
  companion: boolean;
  folderExists: boolean;
  needsYou: boolean;
  /**
   * the live process holding the session, from the registry: `interactive` is a panel or a
   * terminal, `bg` is Claude Code's supervisor. a moment old at most.
   */
  holder?: { kind?: string; entrypoint?: string };
}

/**
 * Claude Code's supervisor holds a live worker for this session. anything that resumes it
 * elsewhere is refused ("is running as a background session"), so landing is not on offer.
 */
export function daemonHeld(f: Pick<ActionFacts, "row" | "holder">): boolean {
  return f.row.background?.held === true || f.holder?.kind === "bg";
}

/** where an interactive process holding a session lives, in words */
export function heldWhere(entrypoint: string | undefined, editorLabel: string): string {
  if (entrypoint === "claude-vscode") return `still open in ${editorLabel}`;
  if (entrypoint === "cli") return "still open in a terminal";
  return "still open somewhere else";
}

/**
 * hand the session to Claude Code's supervisor. only when no live process holds it: a
 * `--resume --bg` on a held session starts a copy of the conversation, which is the one thing
 * this must never do.
 */
function continueAction(f: ActionFacts): SessionAction {
  const base = { id: "continue-bg" as const, label: "Continue in background\u2026" };
  if (f.holder?.kind === "interactive") {
    const how = f.holder.entrypoint === "claude-vscode" ? "close its tab first" : "quit it first";
    return {
      ...base,
      enabled: false,
      hint: `${heldWhere(f.holder.entrypoint, f.editorLabel)} - ${how}`,
    };
  }
  if (!f.folderExists) return { ...base, enabled: false, hint: "the folder is gone" };
  return { ...base, enabled: true };
}

function landActions(f: ActionFacts): SessionAction[] {
  const hint = f.companion ? undefined : "opens without landing";
  const out: SessionAction[] = [];
  if (f.row.comboName) {
    out.push({
      id: "combo-land",
      label: `Open ${f.row.comboName} and land on session`,
      enabled: true,
      ...(hint ? { hint } : {}),
    });
  }
  out.push({
    id: "folder-land",
    label: `Open folder in ${f.editorLabel} and land on session`,
    enabled: f.folderExists,
    ...(f.folderExists ? (hint ? { hint } : {}) : { hint: "the folder is gone" }),
  });
  out.push({ id: "terminal", label: "Resume in Terminal", enabled: true });
  return out;
}

/**
 * a session the supervisor holds: open it where it runs, or stop it and take it back. `claude
 * stop`, never `claude rm` - rm reasons about worktrees, and a combo's working copies are ones.
 */
function heldActions(f: ActionFacts): SessionAction[] {
  const id = f.row.background?.id;
  if (!id) {
    // the registry says the supervisor has it, and `claude agents` has not said which one yet
    const hint = "running in the background";
    return landActions(f).map((a) => ({ ...a, enabled: false, hint }));
  }
  const landable = !!f.row.comboName || f.folderExists;
  const working = f.row.background?.state === "working";
  return [
    { id: "attach", label: "Open in Terminal (attach)", enabled: true },
    {
      id: "stop-land",
      label: `Stop and open in ${f.editorLabel}`,
      enabled: landable,
      ...(landable ? {} : { hint: "the folder is gone" }),
      ...(working
        ? {
            confirm: {
              title: "Stop it while it works?",
              body: "It is still working - stopping it interrupts the turn. The conversation is kept, and it opens where you left it.",
              label: "Stop and open",
            },
          }
        : {}),
    },
  ];
}

export function sessionActionList(f: ActionFacts): SessionAction[] {
  const held = daemonHeld(f);
  // a session that lost its process mid-turn: picking it back up is the likely next step
  const actions: SessionAction[] = held
    ? heldActions(f)
    : f.row.interrupted
      ? [continueAction(f), ...landActions(f)]
      : [...landActions(f), continueAction(f)];
  actions.push({
    id: "copy-command",
    label: "Copy resume command",
    keys: "⌘⇧C",
    enabled: true,
  });
  if (f.row.agents && f.row.agents.length > 0) {
    actions.push({ id: "inspect", label: "Inspect agents", keys: "⌘I", enabled: true });
  }
  if (held && f.row.background?.id) {
    actions.push({ id: "stop", label: "Stop background session", enabled: true, secondary: true });
  }
  if (f.needsYou) {
    actions.push({
      id: "mark-seen",
      label: "Mark as seen",
      keys: "⌘D",
      enabled: true,
      secondary: true,
    });
  }
  actions.push(
    f.row.archived
      ? { id: "unarchive", label: "Unarchive", keys: "⌘⇧A", enabled: true, secondary: true }
      : { id: "archive", label: "Archive", keys: "⌘⇧A", enabled: true, secondary: true },
  );
  actions.push({ id: "copy-id", label: "Copy session ID", enabled: true, secondary: true });
  actions.push({
    id: "reveal",
    label: "Reveal transcript in Finder",
    enabled: true,
    secondary: true,
  });
  return actions;
}
