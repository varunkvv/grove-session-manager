// dev only: lets the renderer run in a plain browser (`pnpm vite` + ?mock=empty|drift) for visual work.
// never part of a production build - main.tsx only imports it when import.meta.env.DEV is true.
import type { Bootstrap, Bridge, ComboView, FolderView, SessionRow } from "../../shared/ipc.ts";

const NOW = Date.now();
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const variant = new URLSearchParams(location.search).get("mock") ?? "full";

let n = 0;
function session(
  title: string | undefined,
  ago: number,
  extra: Partial<SessionRow> = {},
): SessionRow {
  n++;
  const id = `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return {
    key: `/Users/you/.claude/projects/-x/${id}.jsonl`,
    sessionId: id,
    title,
    titleSource: title ? "aiTitle" : undefined,
    projectLabel: "api",
    cwdBase: "api",
    cwd: "/Users/you/src/api",
    activityMs: NOW - ago,
    parsed: true,
    entrypoint: "claude-vscode",
    ...extra,
  };
}

const sessions: SessionRow[] = [
  session("Database CPU spike during the nightly job", 20_000, {
    comboName: "prod-debug",
    comboRelation: "root",
    cwdBase: "prod-debug",
    firstPrompt:
      "the primary is pinned at 95% cpu since 02:00, can you check which queries changed",
  }),
  session("Webhook retries missing - trace the delivery chain", 42 * MIN, {
    comboName: "prod-debug",
    comboRelation: "root",
    gitBranch: "prod-debug",
    firstPrompt: "walk the webhook delivery chain and find where the retry is lost",
  }),
  session("export api project", 3 * H, {
    titleSource: "customTitle",
    gitBranch: "dev/eng-398-export-api",
    cwdBase: "docs",
    firstPrompt:
      "can you look into fixing this issue? the export button should move to the first page",
  }),
  session("Rate limiter logic with backoff", 7 * H, {
    gitBranch: "ENG-390",
    cwdBase: "queue",
    prNumber: 1042,
    prRepo: "acme/queue",
    firstPrompt: "review the backoff handling in rate_limiter.py",
  }),
  session("Timestamp handling in the importer", 26 * H, {
    gitBranch: "ENG-398-normalize-import",
    cwdBase: "queue",
    firstPrompt: "what do we expect updated_at to look like for imported rows",
  }),
  session("Move export button to first page", 30 * H, {
    comboName: "eng-218",
    comboRelation: "inside",
    gitBranch: "eng-218",
    cwdBase: "web",
    firstPrompt: "move the export button to the first page of the report flow",
  }),
  session("Onboarding copy changes", 2 * D, { gitBranch: "main", cwdBase: "docs" }),
  session(undefined, 2 * D + H, {
    projectLabel: "scratch",
    cwdBase: "scratch",
    cwd: "/private/tmp/scratch",
    titleSource: undefined,
  }),
  session("Revert pull request 4127", 4 * D, {
    cwdBase: "web",
    prNumber: 4131,
    firstPrompt: "revert 4127 and open a PR, keep the migration",
  }),
  session("Postgres read replica setup", 5 * D, {
    gitBranch: "main",
    cwdBase: "queue",
    firstPrompt: "set up the read replica and list the tables we need",
  }),
  session("ENG-367 production readiness planning", 8 * D, {
    cwdBase: "web",
    firstPrompt: "draft the production-readiness chores for the importer",
  }),
  session("Nightly job runtime metrics", 9 * D, { gitBranch: "main", cwdBase: "mailer" }),
  session("Assign open PRs to reviewers", 11 * D, { cwdBase: "web" }),
  session("auth_tokens.py review", 16 * D, { gitBranch: "ENG-335", cwdBase: "queue" }),
  session("/mcp", 18 * D, {
    titleSource: "firstCommand",
    cwdBase: "dev-tools",
    gitBranch: "main",
    entrypoint: "cli",
  }),
  session("Habit tracker app for iPhone", 40 * D, {
    titleSource: "customTitle",
    gitBranch: "main",
    cwdBase: "habit-tracker",
  }),
];

const f = (
  dirName: string,
  mode: FolderView["mode"],
  state: FolderView["state"],
  extra: Partial<FolderView> = {},
): FolderView => ({
  path: `/Users/you/src/${dirName}`,
  mode,
  dirName,
  state,
  ...extra,
});

const combos: ComboView[] =
  variant === "empty"
    ? []
    : [
        {
          name: "prod-debug",
          root: "/Users/you/claude-ws/prod-debug",
          note: "incident triage",
          workspaceFile: "/Users/you/claude-ws/prod-debug/prod-debug.code-workspace",
          longWork: "background",
          status: "known",
          folders: [
            f("api", "worktree", "ok", {
              branchLabel: "detached @4f2a91c",
              branchSpec: { kind: "detach" },
            }),
            f("shared", "worktree", variant === "drift" ? "stale" : "ok", {
              branchLabel: "prod-debug",
              branchSpec: { kind: "new", name: "prod-debug" },
            }),
            f("logs", "reference", "reference"),
          ],
        },
        {
          name: "eng-218",
          root: "/Users/you/claude-ws/eng-218",
          workspaceFile: "/x",
          longWork: "background",
          status: "known",
          folders: [
            f("api", "worktree", "ok", { branchLabel: "eng-218" }),
            f("shared", "worktree", "ok", { branchLabel: "eng-218" }),
            f("web", "worktree", variant === "drift" ? "foreign" : "ok", {
              branchLabel: "eng-218",
            }),
            f("design-system", "reference", "reference"),
          ],
        },
        {
          name: "infra",
          root: "/Users/you/claude-ws/infra",
          workspaceFile: "/x",
          longWork: "background",
          status: "known",
          folders: [
            f("terraform", "worktree", "absent"),
            f("helm-charts", "reference", "reference"),
          ],
        },
      ];

const boot: Bootstrap = {
  revs: { sessions: 1, combos: 1 },
  env: {
    appRoot: "/Users/you/claude-ws",
    projectsDir: "/Users/you/.claude/projects",
    home: "/Users/you",
    platform: "darwin",
    isDev: true,
  },
  settings: { editor: "vscode", appearance: "system" },
  editor: {
    id: "vscode",
    label: "VS Code",
    bin: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    binFound: true,
    companionVersion: variant === "banner" ? null : "0.1.0",
    bundledCompanionVersion: "0.1.0",
    companionState: variant === "banner" ? "missing" : "ok",
    claudeExtensionInstalled: true,
  },
  combos,
  sessions:
    variant === "nosessions"
      ? []
      : variant === "empty"
        ? sessions.map((s) => ({ ...s, comboName: undefined, comboRelation: undefined }))
        : sessions,
  index: { phase: "idle", done: sessions.length, total: sessions.length },
};

const okv = <T>(value: T) => Promise.resolve({ ok: true as const, value });

const bridge: Bridge = {
  bootstrap: async () => boot,
  rescan: () => okv(undefined),
  sessionActions: async (key) => {
    const row = sessions.find((s) => s.key === key);
    return [
      ...(row?.comboName
        ? [
            {
              id: "combo-land" as const,
              label: `Open ${row.comboName} and land on session`,
              enabled: true,
            },
          ]
        : []),
      {
        id: "folder-land",
        label: "Open folder in VS Code and land on session",
        enabled: row?.cwd !== "/private/tmp/scratch",
        hint: row?.cwd === "/private/tmp/scratch" ? "folder is gone" : undefined,
      },
      { id: "terminal", label: "Resume in Terminal", enabled: true },
      { id: "copy-command", label: "Copy resume command", enabled: true },
      { id: "copy-id", label: "Copy session ID", enabled: true, secondary: true },
      { id: "reveal", label: "Reveal transcript in Finder", enabled: true, secondary: true },
    ];
  },
  runSessionAction: () => okv({ message: "Done (mock)" }),
  validateComboName: async (name) => ({
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    root: `/Users/you/claude-ws/${name}`,
    problem: name === "prod-debug" ? '"prod-debug" already uses that name.' : undefined,
  }),
  validateDraft: async () => ({ problems: [] }),
  pickDirectories: async () => ["/Users/you/src/api", "/Users/you/src/logs"],
  inspectPath: async (path) => ({
    path,
    exists: true,
    isGitRepo: !path.endsWith("logs"),
    canBeWorktree: !path.endsWith("logs"),
    currentBranch: "main",
    head: "4f2a91c",
    branches: [{ name: "main", checkedOutAt: path }, { name: "dev/eng-218" }, { name: "release" }],
    suggestedDirName: path.split("/").pop() ?? "x",
  }),
  createCombo: (d) => okv({ name: d.name }),
  updateCombo: (_n, d) => okv({ name: d.name }),
  deleteCombo: () => okv({ remaining: [] }),
  reconcile: () => okv(undefined),
  ensureCombo: () => okv([]),
  repairFolder: () => okv([]),
  repairCombo: () => okv([]),
  teardownCombo: () => okv([]),
  forceRemoveFolder: () =>
    Promise.resolve({ ok: false as const, error: { code: "mock", message: "mock" } }),
  openCombo: () => okv({ launched: true, landing: true, outcomes: [], warnings: [] }),
  setLongWork: () => okv(undefined),
  editorStatus: async () => boot.editor,
  installCompanion: () => okv(undefined),
  getSettings: async () => boot.settings,
  updateSettings: (p) => okv({ ...boot.settings, ...p }),
  reveal: () => okv(undefined),
  copyText: () => okv(undefined),
  reportCspViolation: async () => {},
  on: () => () => {},
};

window.grove = bridge;
