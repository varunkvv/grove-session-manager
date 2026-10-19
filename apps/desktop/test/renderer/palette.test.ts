import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WindowRow } from "../../src/renderer/components/Palette.tsx";
import type { ChatAction } from "../../src/renderer/logic/chatKeys.ts";
import {
  type ChatPaletteContext,
  chatPaletteItems,
  matchCommand,
  type PaletteContext,
  paletteItems,
} from "../../src/renderer/logic/palette.ts";
import type { ChatWindowView, FolderView, ProjectView, SessionHit } from "../../src/shared/ipc.ts";

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
      "go-usage",
      "project:auth",
      "project:data",
      "new-session",
      "start-background",
      "long-work",
      "archive-project",
      "delete-project",
      "settings",
    ]);
  });

  it("archived projects are a section of their own, and only once something is typed", () => {
    const auth = project("auth");
    const away = project("old-export", { archived: true });
    const c = ctx({ project: auth, projects: [auth, away, project("data")] });
    // nothing typed: the projects that are not archived
    expect(sections(c)).toEqual(["Go to", "Projects", "This project", "App"]);
    expect(ids(c)).not.toContain("project:old-export");
    // a word of its name: the keyboard still reaches it, and it runs like any project
    expect(sections(c, "old")).toEqual(["Archived"]);
    expect(ids(c, "old")).toEqual(["project:old-export"]);
    expect(sections(c, "switch")).toEqual(["Projects", "Archived"]);
    expect(ids(c, "switch")).toEqual(["project:auth", "project:data", "project:old-export"]);

    // the row says what choosing it does, above Delete, which both have
    const mine = (x: PaletteContext, q = "") =>
      paletteItems(x, q)
        .sections.find((s) => s.label === "This project")
        ?.items.map((i) => i.label);
    expect(mine(c)?.slice(-2)).toEqual(["Archive project", "Delete project…"]);
    const onIt = ctx({ project: away, projects: [auth, away] });
    expect(mine(onIt)?.slice(-2)).toEqual(["Unarchive project", "Delete project…"]);
    // `archive` and Enter is the command, on either: an archived project does not answer to the word
    expect(ids(c, "archive")).toEqual(["archive-project"]);
    expect(ids(onIt, "archive")).toEqual(["archive-project"]);
    // the one on screen is checked where it is listed
    const checked = paletteItems(onIt, "old").sections.flatMap((s) => s.items);
    expect(checked).toMatchObject([
      { id: "project:old-export", section: "Archived", current: true },
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

  it("on the inbox, which is every project's: no This project. with no projects: the app's rows, and Usage, which is the machine's", () => {
    expect(sections(ctx({ project: null }))).toEqual(["Go to", "Projects", "App"]);
    expect(sections(ctx({ project: null, projects: [] }))).toEqual(["Go to", "App"]);
    expect(ids(ctx({ project: null, projects: [] }))).toEqual(["go-usage", "settings"]);
    expect(ids(ctx(), "usage")).toEqual(["go-usage"]);
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
    // a project is its sessions, and the home screen is all of them. its old name still finds it
    expect(ids(c, "sessions")).toEqual(["go-inbox", "project:auth", "project:data"]);
    expect(ids(c, "inbox")).toEqual(["go-inbox"]);
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

// ---------- the open chat windows, in both palettes

/** an open chat window as main lists it. `asks`: it needs the person, and says what for */
const open = (
  id: string,
  title: string,
  more: Partial<SessionHit> = {},
  asks?: string,
): ChatWindowView => {
  const h: SessionHit = { ...hit(0), key: `k-${id}`, sessionId: id, title, ...more };
  return {
    hit: h,
    ...(asks !== undefined
      ? {
          row: {
            ...h,
            project: "ingest",
            kind: "turn" as const,
            at: NOW,
            summary: asks,
            reviewKeys: [],
          },
        }
      : {}),
  };
};

const RETRY = open("w-retry", "fix the ingest retry loop", { where: "ingest" });
const RENAME = open("w-rename", "rename the cli flags", { where: "docs-site" });
const SELF = open("w-self", "this window", { where: "ingest" });

const act = (id: string, label: string, group: ChatAction["group"]): ChatAction => ({
  id,
  label,
  group,
  run: () => {},
});
const ACTIONS = [
  act("editor", "Open in VS Code", "Session"),
  act("rename", "Rename…", "Session"),
  act("attach", "Attach files…", "Composer"),
  act("find", "Find in the conversation", "View"),
];
const chatIds = (c: Partial<ChatPaletteContext>, q = "") =>
  chatPaletteItems({ self: "w-self", windows: [SELF], actions: ACTIONS, ...c }, q).map((s) => [
    s.label,
    s.items.map((i) => i.id),
  ]);

describe("the Windows section", () => {
  it("is on top of the main palette, in the order main gives: the one looked at last first", () => {
    const c = ctx({ windows: [RENAME, RETRY] });
    expect(sections(c)).toEqual(["Windows", "Go to", "Projects", "This project", "App"]);
    expect(ids(c).slice(0, 3)).toEqual(["window:w-rename", "window:w-retry", "go-inbox"]);
    // none open: the palette is as it was
    expect(sections(ctx({ windows: [] }))).toEqual(["Go to", "Projects", "This project", "App"]);
  });

  it("matches a typed word at the start of a word, not fuzzily: `ren` is not in `retry`", () => {
    const c = ctx({ windows: [RETRY, RENAME] });
    expect(ids(c, "ren")[0]).toBe("window:w-rename");
    expect(ids(c, "ren")).not.toContain("window:w-retry");
    // r, e, n in order would find this one: no word of it starts with them
    expect(ids(ctx({ windows: [open("w-rerun", "rerun the ingest")] }), "ren")).toEqual([]);
    // the project's name, the description and what it asks find it too
    const asks = open("w-asks", "metrics", { description: "count 429s per tenant" }, "page on 1%?");
    expect(ids(ctx({ windows: [asks] }), "tenant")).toEqual(["window:w-asks"]);
    expect(ids(ctx({ windows: [asks] }), "page")).toEqual(["window:w-asks"]);
    expect(ids(ctx({ windows: [RENAME] }), "docs")).toEqual(["window:w-rename"]);
  });

  it("a session open in a window is that window's row, not a second one under Sessions", () => {
    const found = { ...hit(7), sessionId: "w-retry", key: "k-w-retry" };
    const c = ctx({ windows: [RETRY], sessions: { query: "fix", hits: [found, hit(8)] } });
    expect(ids(c, "fix")).toEqual(["window:w-retry", "session:k8"]);
  });

  it("says what each window is at, from its inbox row or its run", () => {
    const [w] = paletteItems(
      ctx({
        windows: [
          open("a", "a", {}, "keep it?"),
          open("b", "b", { live: "running" }),
          open("c", "c"),
        ],
      }),
      "",
    ).sections;
    expect(w?.items.map((i) => i.window?.state)).toEqual(["turn", "working", undefined]);
  });
});

describe("the chat palette", () => {
  it("with no other window open, is the actions by group as before: no Windows, no All sessions", () => {
    expect(chatIds({})).toEqual([
      ["Session", ["editor", "rename"]],
      ["Composer", ["attach"]],
      ["View", ["find"]],
    ]);
  });

  it("puts the other windows on top, the one looked at last first, then All sessions", () => {
    const [first, next] = chatIds({ windows: [SELF, RETRY, RENAME] });
    expect(first).toEqual(["Windows", ["window:w-retry", "window:w-rename", "all-sessions"]]);
    expect(next).toEqual(["Session", ["editor", "rename"]]);
  });

  it("typed: the windows by the start of a word, then the actions, then the sessions found", () => {
    const windows = [SELF, RETRY, RENAME];
    // `ren` finds the window named rename first, and Rename after it. not the retry window
    expect(chatIds({ windows }, "ren")).toEqual([
      ["Windows", ["window:w-rename"]],
      ["Actions", ["rename"]],
    ]);
    // sessions this window or another already shows are not found again
    const hits = [
      { ...hit(1), sessionId: "w-self" },
      { ...hit(2), sessionId: "w-retry" },
      { ...hit(3), sessionId: "s3" },
    ];
    expect(chatIds({ windows, sessions: { query: "session", hits } }, "session")).toEqual([
      ["Windows", ["all-sessions"]],
      ["Sessions", ["session:s3"]],
    ]);
    // an answer for another query is not shown
    expect(chatIds({ windows, sessions: { query: "sess", hits } }, "session")).toEqual([
      ["Windows", ["all-sessions"]],
    ]);
  });
});

describe("a window's row", () => {
  const row = (w: ChatWindowView) =>
    renderToStaticMarkup(
      createElement(WindowRow, {
        words: [],
        item: { hit: w.hit, ...(w.row ? { row: w.row, state: w.row.kind } : {}) },
      }),
    );

  it("is one line with nothing to say under it: no empty second line", () => {
    const html = row(RETRY);
    expect(html).toContain("fix the ingest retry loop");
    expect(html).not.toContain("w-full");
  });

  it("says what it is for under it, or what it asks when it needs the person", () => {
    const described = open("d", "d", { description: "count 429s per tenant" });
    expect(row(described)).toContain("count 429s per tenant");
    const asks = open("a", "a", { description: "count 429s per tenant" }, "page on 1%?");
    expect(row(asks)).toContain('data-testid="inbox-summary"');
    expect(row(asks)).not.toContain("count 429s per tenant");
  });
});
