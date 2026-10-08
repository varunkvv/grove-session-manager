import { describe, expect, it } from "vitest";
import {
  matchCommand,
  type PaletteContext,
  paletteItems,
} from "../../src/renderer/logic/palette.ts";
import type { FolderView, ProjectView, SessionHit } from "../../src/shared/ipc.ts";

const NOW = Date.parse("2026-10-02T15:00:00Z");

const project = (id: string, partial: Partial<ProjectView> = {}): ProjectView => ({
  id,
  name: id,
  root: `/w/${id}`,
  goal: "ship it",
  workspaceFile: `/w/${id}/${id}.code-workspace`,
  longWork: "foreground",
  folders: [],
  status: "known",
  rootExists: true,
  ...partial,
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
    ...partial,
  };
}

const ids = (c: PaletteContext, q = "") =>
  paletteItems(c, q).sections.flatMap((s) => s.items.map((i) => i.id));
const sections = (c: PaletteContext, q = "") => paletteItems(c, q).sections.map((s) => s.label);

describe("paletteItems", () => {
  it("an empty query shows every section but Sessions", () => {
    const c = ctx({ sessions: { query: "", hits: [hit(1)] } });
    expect(sections(c)).toEqual(["Go to", "Projects", "This project", "App"]);
    expect(ids(c)).toEqual([
      "go-inbox",
      "project:auth",
      "project:data",
      "new-session",
      "start-background",
      "long-work",
      "delete-project",
      "settings",
    ]);
  });

  it("has none of the cut rows", () => {
    const all = ids(ctx({ projects: [project("auth", { folders: [folder("stale")] })] }));
    for (const cut of ["new-project", "edit-project", "open-project", "go-cards", "review-all"])
      expect(all).not.toContain(cut);
  });

  it("checks the project on screen", () => {
    const items = paletteItems(ctx(), "").sections.flatMap((s) => s.items);
    expect(items.filter((i) => i.current).map((i) => i.id)).toEqual(["project:auth"]);
  });

  it("on the inbox, which is every project's: no This project. with no projects: the app's rows alone", () => {
    expect(sections(ctx({ project: null }))).toEqual(["Go to", "Projects", "App"]);
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
    expect(ids(ctx())).toContain("new-session");
    // a project needs no goal: a session starts from its own ask
    const noGoal = ids(ctx({ project: project("auth", { goal: undefined }) }));
    expect(noGoal).toContain("new-session");
    expect(noGoal).toContain("start-background");
    const gone = ids(ctx({ project: project("auth", { rootExists: false }) }));
    expect(gone).not.toContain("new-session");
    expect(gone).not.toContain("start-background");
  });

  it("a query keeps the section order and drops empty sections", () => {
    const c = ctx({ sessions: { query: "auth", hits: [hit(1)] } });
    expect(sections(c, "auth")).toEqual(["Projects", "Sessions"]);
    expect(ids(c, "set")).toEqual(["settings"]);
    // a project is its sessions
    expect(ids(c, "sessions")).toEqual(["project:auth", "project:data"]);
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
    expect(matchCommand("Sessions go lists", ["sess"])).toBe(true);
    expect(matchCommand("Sessions go lists", ["ssions"])).toBe(false);
    expect(matchCommand("Sessions go lists", ["li", "go"])).toBe(true);
    expect(matchCommand("Sessions go lists", ["li", "x"])).toBe(false);
    expect(matchCommand("chat-features switch project", ["features"])).toBe(true);
    expect(matchCommand("Settings…", ["settings"])).toBe(true);
  });
});
