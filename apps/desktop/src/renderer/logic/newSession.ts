import type { LongWorkMode } from "@grove/core/pure";
import {
  EFFORTS,
  type EffortChoice,
  MODELS,
  type ModelChoice,
  type NewSessionWhere,
  PERMISSION_MODES,
  type PermissionModeChoice,
} from "../../shared/newSession.ts";

/** what the dialog remembers per combo. "" is Default: nothing is passed. */
export interface NewSessionChoices {
  where: NewSessionWhere;
  longWork: "combo" | LongWorkMode;
  model: ModelChoice | "";
  mode: PermissionModeChoice | "";
  effort: EffortChoice | "";
}

export const DEFAULT_CHOICES: NewSessionChoices = {
  where: "editor",
  longWork: "combo",
  model: "",
  mode: "",
  effort: "",
};

const storageKey = (combo: string) => `grove.newSession.${combo}`;

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/**
 * the last choice of every field for this combo, so the second time is one keystroke. typed text
 * (the prompt, a name) is not remembered: it belongs to the session it started. anything that
 * cannot be read, or is no longer on a list, falls back to the default.
 */
export function loadChoices(
  storage: Pick<Storage, "getItem"> | null,
  combo: string,
): NewSessionChoices {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(storageKey(combo)) ?? "{}");
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    // unreadable or blocked: the defaults
  }
  const d = DEFAULT_CHOICES;
  return {
    where: pick(raw.where, ["editor", "terminal", "background"], d.where),
    longWork: pick(raw.longWork, ["combo", "background", "foreground"], d.longWork),
    model: pick(raw.model, ["", ...MODELS.map((o) => o.value)], d.model),
    mode: pick(raw.mode, ["", ...PERMISSION_MODES.map((o) => o.value)], d.mode),
    effort: pick(raw.effort, ["", ...EFFORTS.map((o) => o.value)], d.effort),
  };
}

export function saveChoices(
  storage: Pick<Storage, "setItem"> | null,
  combo: string,
  choices: NewSessionChoices,
): void {
  try {
    storage?.setItem(storageKey(combo), JSON.stringify(choices));
  } catch {
    // full or blocked. remembering is a convenience.
  }
}

/** localStorage, or null where reading it throws */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** the primary button says what happens */
export function primaryLabel(where: NewSessionWhere, editorLabel: string): string {
  if (where === "editor") return `Open in ${editorLabel}`;
  if (where === "terminal") return "Open in Terminal";
  return "Start in background";
}

export function whereHint(where: NewSessionWhere, editorLabel: string): string {
  if (where === "editor") return `The combo opens in ${editorLabel} on a new conversation.`;
  if (where === "terminal") return "A new Terminal window, running claude in the combo folder.";
  return "Claude Code's own supervisor runs it in the combo folder, after every window closes. A permission prompt puts it under Needs you.";
}

export function promptHint(where: NewSessionWhere): string {
  if (where === "editor") return "Optional. Put in the Claude panel's input box, for you to send.";
  if (where === "terminal") return "Optional. Sent as the first message.";
  return "Sent as it is, once you press the button.";
}

export function longWorkOptions(
  comboMode: LongWorkMode,
): Array<{ value: NewSessionChoices["longWork"]; label: string }> {
  return [
    {
      value: "combo",
      label: `Combo default (${comboMode === "background" ? "in the background" : "here, in the conversation"})`,
    },
    { value: "background", label: "In the background" },
    { value: "foreground", label: "Here, in the conversation" },
  ];
}

export function longWorkHint(
  where: NewSessionWhere,
  choice: NewSessionChoices["longWork"],
): string {
  if (choice === "combo") return "What .claude/long-work.md says. The switch on the combo sets it.";
  return where === "editor"
    ? "For this session only. It rides on the prompt as its first line, so you see it before sending."
    : "For this session only, in its system prompt. The combo's own setting stays as it is.";
}
