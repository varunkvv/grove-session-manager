// dev only: lets the renderer run in a plain browser (`pnpm vite` + ?mock=empty|drift|agents) for
// visual work. never part of a production build - main.tsx only imports it when import.meta.env.DEV
// is true.
import type {
  AgentStats,
  Bootstrap,
  Bridge,
  ComboView,
  FolderView,
  SessionAgent,
  SessionInspection,
  SessionRow,
} from "../../shared/ipc.ts";

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
    usage: [
      {
        model: "claude-opus-5",
        input: 1_204,
        output: 412_300,
        cacheRead: 38_400_000,
        cacheWrite: 1_210_000,
        messages: 212,
      },
      {
        model: "claude-haiku-4-5-20251001",
        input: 96,
        output: 8_120,
        cacheRead: 640_000,
        cacheWrite: 90_400,
        messages: 14,
      },
    ],
  }),
  session("Webhook retries missing - trace the delivery chain", 42 * MIN, {
    comboName: "prod-debug",
    comboRelation: "root",
    gitBranch: "prod-debug",
    firstPrompt: "walk the webhook delivery chain and find where the retry is lost",
    live: { state: "permission", at: NOW - 3 * MIN, lastEventAt: NOW - 3 * MIN, detail: "Bash" },
    usage: [
      {
        model: "claude-sonnet-5",
        input: 310,
        output: 96_400,
        cacheRead: 9_800_000,
        cacheWrite: 402_000,
        messages: 88,
      },
    ],
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

// ?mock=agents: sessions that sent agents out, as the inspector sees them
const S = 1000;
const stats: Record<string, AgentStats> = {};
function agent(
  id: string,
  a: Partial<SessionAgent> & { agentType: string; startedAgo: number; endedAgo?: number },
  st: Partial<AgentStats> = {},
): SessionAgent {
  const startedAt = NOW - a.startedAgo;
  const lastActivityAt = a.endedAgo === undefined ? NOW - 2 * S : NOW - a.endedAgo;
  stats[id] = {
    id,
    toolCount: 0,
    tokens: 0,
    startedAt,
    ...(a.endedAgo === undefined ? {} : { lastAt: lastActivityAt }),
    ...st,
  };
  const { startedAgo: _s, endedAgo: _e, ...rest } = a;
  return {
    id,
    startedAt,
    lastActivityAt,
    state: a.endedAgo === undefined ? "running" : "done",
    spawnDepth: 1,
    ...rest,
  };
}

const liveFanOut: SessionAgent[] = [
  agent(
    "a01",
    {
      agentType: "Explore",
      description: "Survey the nightly job's queries",
      startedAgo: 26 * MIN,
      endedAgo: 23 * MIN + 31 * S,
    },
    {
      toolCount: 26,
      tokens: 71_212,
      model: "claude-sonnet-5",
      outcome: "The job runs 14 queries, and two of them changed on Tuesday.",
    },
  ),
  agent(
    "a02",
    {
      agentType: "Explore",
      description: "Find what changed in the planner stats",
      startedAgo: 25 * MIN + 40 * S,
      endedAgo: 21 * MIN,
    },
    {
      toolCount: 31,
      tokens: 88_410,
      model: "claude-sonnet-5",
      outcome: "autovacuum stopped analyzing the events table after the 09-19 migration.",
    },
  ),
  agent(
    "a03",
    {
      agentType: "claude-code-guide",
      description: "Check how pg_stat_statements resets",
      startedAgo: 24 * MIN,
      endedAgo: 22 * MIN + 50 * S,
    },
    {
      toolCount: 7,
      tokens: 41_020,
      model: "claude-haiku-4-5-20251001",
      error:
        "API Error: Connection refused - a firewall or proxy may be blocking it (ConnectionRefused)",
    },
  ),
  agent(
    "a04",
    {
      agentType: "general-purpose",
      description: "Reproduce the spike against a replica",
      startedAgo: 20 * MIN,
      summary: "replaying the 02:00 batch against the read replica",
    },
    { toolCount: 64, tokens: 190_300, model: "claude-opus-5", lastStep: "Bash psql -f replay.sql" },
  ),
  agent(
    "a05",
    { agentType: "Plan", description: "Plan the index change", startedAgo: 8 * MIN + 12 * S },
    {
      toolCount: 12,
      tokens: 52_900,
      model: "claude-opus-5",
      lastStep: "Read migrations/0192_events_index.sql",
    },
  ),
];

const finished: SessionAgent[] = [
  agent(
    "b01",
    {
      agentType: "Explore",
      description: "Survey session-manager capabilities",
      startedAgo: 2 * D + 5 * H,
      endedAgo: 2 * D + 5 * H - 148 * S,
    },
    {
      toolCount: 26,
      tokens: 71_212,
      model: "claude-sonnet-5",
      outcome:
        "Grove lists every session from ~/.claude/projects and has no idea what runs inside one.",
    },
  ),
  agent(
    "b02",
    {
      agentType: "claude-code-guide",
      description: "Research hooks for AskUserQuestion",
      startedAgo: 2 * D + 4 * H,
      endedAgo: 2 * D + 4 * H - 110 * S,
    },
    {
      toolCount: 18,
      tokens: 98_419,
      model: "claude-haiku-4-5-20251001",
      outcome: "A PreToolUse hook can answer AskUserQuestion by returning updatedInput.",
    },
  ),
  agent(
    "b03",
    {
      agentType: "long-task",
      description: "Implement agent visibility in Grove",
      requestShape: "background",
      startedAgo: 2 * D + 3 * H,
      endedAgo: 2 * D + 3 * H - 42 * MIN,
    },
    {
      toolCount: 246,
      tokens: 388_032,
      model: "claude-opus-5",
      outcome: "Done. Three commits on agent-visibility, nothing pushed, working tree clean.",
    },
  ),
];

const nestedWorkflow: SessionAgent[] = [
  agent(
    "c01",
    {
      agentType: "long-task",
      description: "Derive BDS table names on create",
      startedAgo: 5 * H,
      endedAgo: 4 * H + 12 * MIN,
      toolUseId: "toolu_c01",
    },
    {
      toolCount: 88,
      tokens: 212_000,
      model: "claude-opus-5",
      outcome:
        "The serializer derives the name on create and keeps it on update, with two new tests.",
    },
  ),
  agent(
    "c02",
    {
      agentType: "Explore",
      description: "Find every writer of big_query_table_name",
      spawnDepth: 2,
      startedAgo: 4 * H + 58 * MIN,
      endedAgo: 4 * H + 55 * MIN,
    },
    {
      toolCount: 19,
      tokens: 64_800,
      model: "claude-sonnet-5",
      parentId: "c01",
      outcome: "Only kirby's own ORM path writes it. The API route is the one left open.",
    },
  ),
  agent(
    "c03",
    {
      agentType: "Explore",
      description: "Check what platform sends to the route",
      spawnDepth: 2,
      startedAgo: 4 * H + 57 * MIN,
      endedAgo: 4 * H + 50 * MIN,
    },
    {
      toolCount: 23,
      tokens: 70_100,
      model: "claude-sonnet-5",
      parentId: "c01",
      outcome: "platform strips big_query_table_name before forwarding, so nothing depends on it.",
    },
  ),
  agent(
    "c04",
    {
      agentType: "workflow-subagent",
      workflow: "wf_a0f818e7-167",
      startedAgo: 4 * H + 10 * MIN,
      endedAgo: 3 * H + 40 * MIN,
    },
    {
      toolCount: 37,
      tokens: 102_400,
      model: "claude-sonnet-5",
      asked: "You are implementing an approved plan in the kirby repo.",
      outcome: "Working tree left uncommitted as instructed, 198 tests passing.",
    },
  ),
  agent(
    "c05",
    {
      agentType: "workflow-subagent",
      workflow: "wf_a0f818e7-167",
      startedAgo: 3 * H + 38 * MIN,
      endedAgo: 3 * H + 21 * MIN,
    },
    {
      toolCount: 14,
      tokens: 58_000,
      model: "claude-haiku-4-5-20251001",
      asked: "Review the diff against the plan and list anything that contradicts it.",
      outcome: "One contradiction: the patch test at line 289 should keep the literal name.",
    },
  ),
];

const inspectionsByKey = new Map<string, SessionInspection>();

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

if (variant === "agents") {
  const give = (i: number, agents: SessionAgent[], extra: Partial<SessionRow> = {}) => {
    const row = sessions[i];
    if (!row) return;
    Object.assign(row, { agents, ...extra });
    inspectionsByKey.set(row.key, {
      key: row.key,
      agents: Object.fromEntries(
        agents.flatMap((a): Array<[string, AgentStats]> => {
          const st = stats[a.id];
          return st ? [[a.id, st]] : [];
        }),
      ),
      workflows: { "wf_a0f818e7-167": { name: "cdit-1249-derive-bds-table-name" } },
    });
  };
  give(0, liveFanOut, {
    live: { state: "running", at: NOW - 26 * MIN, lastEventAt: NOW - 2 * S },
  });
  give(3, nestedWorkflow, { title: "Derive BDS table names instead of accepting them" });
  give(6, finished, { title: "Chat feature brainstorm" });
}

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
      ...(row?.agents?.length
        ? [{ id: "inspect" as const, label: "Inspect agents", keys: "\u2318I", enabled: true }]
        : []),
      { id: "archive", label: "Archive", keys: "\u2318\u21e7A", enabled: true, secondary: true },
      { id: "copy-id", label: "Copy session ID", enabled: true, secondary: true },
      { id: "reveal", label: "Reveal transcript in Finder", enabled: true, secondary: true },
    ];
  },
  searchSessions: async (query) => ({ query, hits: [] }),
  inspectSession: async (key) => inspectionsByKey.get(key) ?? { key, agents: {}, workflows: {} },
  markSeen: async () => {},
  archiveSessions: () => okv(undefined),
  runSessionAction: () => okv({ message: "Done (mock)" }),
  validateComboName: async (name) => ({
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    root: `/Users/you/claude-ws/${name}`,
    problem: name === "prod-debug" ? '"prod-debug" already uses that name.' : undefined,
  }),
  validateDraft: async () => ({ problems: [] }),
  pickDirectories: async () => ["/Users/you/src/api", "/Users/you/src/logs"],
  frequentFolders: async () =>
    ["api", "web", "queue", "infra", "docs"].map((name, i) => ({
      path: `/Users/you/src/${name}`,
      name,
      lastUsedMs: NOW - i * H,
    })),
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
