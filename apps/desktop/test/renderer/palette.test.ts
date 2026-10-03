import { describe, expect, it } from "vitest";
import {
  matchCommand,
  type PaletteContext,
  paletteItems,
  reviewAllKeys,
} from "../../src/renderer/logic/palette.ts";
import type {
  CardHead,
  FolderView,
  InboxRowView,
  ProjectView,
  SessionHit,
} from "../../src/shared/ipc.ts";

const NOW = Date.parse("2026-10-02T15:00:00Z");

const project = (id: string, partial: Partial<ProjectView> = {}): ProjectView => ({
  id,
  name: id,
  root: `/w/${id}`,
  goal: "ship it",
  prefix: id.slice(0, 4).toUpperCase(),
  workspaceFile: `/w/${id}/${id}.code-workspace`,
  longWork: "foreground",
  folders: [],
  status: "known",
  rootExists: true,
  server: { state: "ok", checkedAt: NOW, ms: 40, tools: 14 },
  shadowed: [],
  starting: [],
  ...partial,
});

const row = (id: string, kind: InboxRowView["kind"]): InboxRowView => ({
  id,
  project: "auth",
  projectName: "auth",
  kind,
  at: NOW,
  title: "t",
  summary: "",
  reviewKeys: [`key:${id}`],
});

const head = (id: string, state?: "closed" | "working"): CardHead => ({
  id,
  title: `title of ${id}`,
  status: "in_progress",
  at: NOW,
  lastActivity: NOW,
  version: "1",
  problems: 0,
  ...(state && {
    agent: { ref: { sessionId: id, name: "a" }, runtime: "closed", state },
  }),
});

const hit = (n: number): SessionHit => ({
  key: `k${n}`,
  sessionId: `s${n}`,
  title: `session ${n}`,
  where: "auth",
  activityMs: NOW,
  runtime: "closed",
  open: {},
});

const folder = (state: FolderView["state"]): FolderView => ({
  path: "/c/api",
  mode: "worktree",
  dirName: "api",
  state,
});

function ctx(partial: Partial<PaletteContext> = {}): PaletteContext {
  const auth = project("auth");
  return {
    project: auth,
    projects: [auth, project("data")],
    editor: "VS Code",
    rows: [],
    cards: [],
    ...partial,
  };
}

const ids = (c: PaletteContext, q = "") =>
  paletteItems(c, q).sections.flatMap((s) => s.items.map((i) => i.id));
const sections = (c: PaletteContext, q = "") => paletteItems(c, q).sections.map((s) => s.label);

describe("paletteItems", () => {
  it("an empty query shows every section but Sessions, and no takeover rows", () => {
    const c = ctx({ cards: [head("AUTH-1", "closed")], sessions: { query: "", hits: [hit(1)] } });
    expect(sections(c)).toEqual(["Go to", "Projects", "This project", "App"]);
    expect(ids(c)).toEqual([
      "go-inbox",
      "go-cards",
      "go-conclusions",
      "project:auth",
      "project:data",
      "start-editor",
      "start-background",
      "long-work",
      "delete-project",
      "settings",
    ]);
  });

  it("has none of the cut rows", () => {
    const all = ids(ctx({ projects: [project("auth", { folders: [folder("stale")] })] }));
    for (const cut of ["new-project", "edit-project", "open-project", "reveal"])
      expect(all).not.toContain(cut);
  });

  it("checks the project on screen", () => {
    const items = paletteItems(ctx(), "").sections.flatMap((s) => s.items);
    expect(items.filter((i) => i.current).map((i) => i.id)).toEqual(["project:auth"]);
  });

  it("with no project: no Go to and no This project", () => {
    expect(sections(ctx({ project: null, projects: [] }))).toEqual(["App"]);
  });

  it("repair only with a working copy absent, stale or foreign", () => {
    expect(ids(ctx())).not.toContain("repair");
    for (const state of ["absent", "stale", "foreign"] as const)
      expect(ids(ctx({ project: project("auth", { folders: [folder(state)] }) }))).toContain(
        "repair",
      );
    expect(ids(ctx({ project: project("auth", { folders: [folder("ok")] }) }))).not.toContain(
      "repair",
    );
  });

  it("the long-work label says what choosing it does", () => {
    const label = (c: PaletteContext) =>
      paletteItems(c, "")
        .sections.flatMap((s) => s.items)
        .find((i) => i.id === "long-work")?.label;
    expect(label(ctx())).toBe("Run long work in the background");
    expect(label(ctx({ project: project("auth", { longWork: "background" }) }))).toBe(
      "Run long work in the conversation",
    );
  });

  it("the start rows follow startBlocked", () => {
    expect(ids(ctx())).toContain("start-editor");
    for (const p of [
      project("auth", { goal: undefined }),
      project("auth", { rootExists: false }),
      project("auth", { server: { state: "failed", checkedAt: NOW, stage: "spawn", message: "" } }),
    ]) {
      const got = ids(ctx({ project: p }));
      expect(got).not.toContain("start-editor");
      expect(got).not.toContain("start-background");
    }
  });

  it("review-all only with reviewable rows that are not Asked or Stopped", () => {
    expect(ids(ctx({ rows: [row("a", "asked"), row("s", "stopped")] }))).not.toContain(
      "review-all",
    );
    const rows = [row("a", "asked"), row("d", "decided"), row("n", "new"), row("s", "stopped")];
    expect(ids(ctx({ rows }))).toContain("review-all");
    expect(reviewAllKeys(rows)).toEqual(["key:d", "key:n"]);
  });

  it("a takeover row per card whose agent is closed, once there is a word", () => {
    const c = ctx({ cards: [head("AUTH-1", "closed"), head("AUTH-2", "working"), head("AUTH-3")] });
    expect(ids(c, "start")).toContain("takeover:AUTH-1");
    expect(ids(c, "start").filter((i) => i.startsWith("takeover:"))).toEqual(["takeover:AUTH-1"]);
    expect(ids(c, "reassign")).toEqual(["takeover:AUTH-1"]);
    expect(ids(c, "auth-1")).toEqual(["takeover:AUTH-1"]);
  });

  it("a query keeps the section order and drops empty sections", () => {
    const c = ctx({ sessions: { query: "auth", hits: [hit(1)] } });
    expect(sections(c, "auth")).toEqual(["Projects", "Sessions"]);
    expect(ids(c, "set")).toEqual(["settings"]);
    expect(ids(c, "decisions")).toEqual(["go-conclusions"]);
  });

  it("Sessions shows what findSessions answered, at most 50, and only for this query", () => {
    const hits = Array.from({ length: 60 }, (_, i) => hit(i));
    const items = paletteItems(ctx({ sessions: { query: "zz", hits } }), "zz").sections;
    expect(items.map((s) => s.label)).toEqual(["Sessions"]);
    expect(items[0]?.items).toHaveLength(50);
    expect(items[0]?.items[0]).toMatchObject({ id: "session:k0", label: "session 0" });
    expect(ids(ctx({ sessions: { query: "z", hits } }), "zz")).toEqual([]);
  });

  it("No matches. waits for the session search to answer", () => {
    expect(paletteItems(ctx(), "zz").none).toBe(false);
    expect(paletteItems(ctx({ sessions: { query: "z", hits: [] } }), "zz").none).toBe(false);
    expect(paletteItems(ctx({ sessions: { query: "zz", hits: [] } }), "zz").none).toBe(true);
    expect(paletteItems(ctx({ sessions: { query: "zz", hits: [hit(1)] } }), "zz").none).toBe(false);
  });
});

describe("matchCommand", () => {
  it("matches word starts and keywords, not middles", () => {
    expect(matchCommand("Conclusions go decisions", ["conc"])).toBe(true);
    expect(matchCommand("Conclusions go decisions", ["lusions"])).toBe(false);
    expect(matchCommand("Conclusions go decisions", ["deci", "go"])).toBe(true);
    expect(matchCommand("Conclusions go decisions", ["deci", "x"])).toBe(false);
    expect(matchCommand("chat-features switch project", ["features"])).toBe(true);
    expect(matchCommand("Settings…", ["settings"])).toBe(true);
  });
});
