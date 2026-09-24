import { describe, expect, it } from "vitest";
import {
  type ActionFacts,
  daemonHeld,
  sessionActionList,
} from "../../src/main/services/sessionActions.ts";
import type { SessionRow } from "../../src/shared/ipc.ts";

const ROW: SessionRow = {
  key: "/projects/-ws-combo/aaaaaaaa-0000-4000-8000-000000000001.jsonl",
  sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
  cwd: "/ws/combo",
  projectLabel: "combo",
  comboName: "combo",
  comboRelation: "root",
  activityMs: 0,
  parsed: true,
};

function facts(
  o: Omit<Partial<ActionFacts>, "row"> & { row?: Partial<SessionRow>; noCombo?: boolean } = {},
): ActionFacts {
  const { row, noCombo, ...rest } = o;
  const merged: SessionRow = { ...ROW, ...row };
  if (noCombo) delete merged.comboName;
  return {
    editorLabel: "VS Code",
    companion: true,
    folderExists: true,
    needsYou: false,
    ...rest,
    row: merged,
  };
}

const ids = (f: ActionFacts) => sessionActionList(f).map((a) => a.id);
const action = (f: ActionFacts, id: string) => sessionActionList(f).find((a) => a.id === id);

describe("what a session offers, by who holds it", () => {
  it("nobody: the usual ways in", () => {
    const f = facts();
    expect(daemonHeld(f)).toBe(false);
    expect(ids(f)).toEqual([
      "combo-land",
      "folder-land",
      "terminal",
      "continue-bg",
      "copy-command",
      "archive",
      "copy-id",
      "reveal",
    ]);
    expect(action(f, "continue-bg")).toEqual({
      id: "continue-bg",
      label: "Continue in background\u2026",
      enabled: true,
    });
  });

  it("an open panel or terminal: continuing it in the background would start a copy", () => {
    const panel = facts({ holder: { kind: "interactive", entrypoint: "claude-vscode" } });
    expect(daemonHeld(panel)).toBe(false);
    expect(action(panel, "continue-bg")).toMatchObject({
      enabled: false,
      hint: "still open in VS Code - close its tab first",
    });
    // landing on it is still fine: the panel reveals its open tab
    expect(action(panel, "combo-land")?.enabled).toBe(true);
    const terminal = facts({ holder: { kind: "interactive", entrypoint: "cli" } });
    expect(action(terminal, "continue-bg")).toMatchObject({
      enabled: false,
      hint: "still open in a terminal - quit it first",
    });
  });

  it("a session whose folder is gone has nowhere to continue from", () => {
    expect(action(facts({ folderExists: false }), "continue-bg")).toMatchObject({
      enabled: false,
      hint: "the folder is gone",
    });
  });

  it("the supervisor, working: attach first, stopping asks first, and no plain land at all", () => {
    const f = facts({ row: { background: { id: "d7b6bcc2", held: true, state: "working" } } });
    expect(daemonHeld(f)).toBe(true);
    expect(ids(f)).toEqual([
      "attach",
      "stop-land",
      "copy-command",
      "stop",
      "archive",
      "copy-id",
      "reveal",
    ]);
    expect(action(f, "attach")).toMatchObject({
      label: "Open in Terminal (attach)",
      enabled: true,
    });
    expect(action(f, "stop-land")).toMatchObject({
      label: "Stop and open in VS Code",
      enabled: true,
      confirm: { label: "Stop and open" },
    });
    expect(action(f, "stop-land")?.confirm?.body).toMatch(/interrupts the turn/);
    expect(action(f, "stop")).toMatchObject({ secondary: true, enabled: true });
  });

  it("the supervisor, done or blocked: the same offers, and nothing to interrupt", () => {
    for (const state of ["done", "blocked"]) {
      const f = facts({ row: { background: { id: "d7b6bcc2", held: true, state } } });
      expect(ids(f).slice(0, 2), state).toEqual(["attach", "stop-land"]);
      expect(action(f, "stop-land")?.confirm, state).toBeUndefined();
    }
  });

  it("stopped, or let go after an idle hour: nothing holds it, so it lands like any other", () => {
    for (const state of ["stopped", "done", "failed"]) {
      const f = facts({ row: { background: { id: "d7b6bcc2", held: false, state } } });
      expect(daemonHeld(f), state).toBe(false);
      expect(ids(f).slice(0, 4), state).toEqual([
        "combo-land",
        "folder-land",
        "terminal",
        "continue-bg",
      ]);
      expect(ids(f), state).not.toContain("stop");
    }
  });

  it("the registry saw the supervisor's process before `claude agents` said which one: nothing lands", () => {
    const f = facts({ holder: { kind: "bg", entrypoint: "cli" } });
    expect(daemonHeld(f)).toBe(true);
    const offers = sessionActionList(f).slice(0, 3);
    expect(offers.map((a) => [a.id, a.enabled, a.hint])).toEqual([
      ["combo-land", false, "running in the background"],
      ["folder-land", false, "running in the background"],
      ["terminal", false, "running in the background"],
    ]);
    expect(ids(f)).not.toContain("attach");
    expect(ids(f)).not.toContain("continue-bg");
  });

  it("a held session whose folder is gone can still be attached, not landed on", () => {
    const f = facts({
      folderExists: false,
      noCombo: true,
      row: { background: { id: "d7b6bcc2", held: true, state: "done" } },
    });
    expect(action(f, "attach")?.enabled).toBe(true);
    expect(action(f, "stop-land")).toMatchObject({ enabled: false, hint: "the folder is gone" });
  });
});
