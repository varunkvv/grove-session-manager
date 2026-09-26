// dev only: lets the renderer run in a plain browser (`pnpm vite` + ?mock=empty|drift|agents|conversation) for
// visual work. never part of a production build - main.tsx only imports it when import.meta.env.DEV
// is true.

import type {
  AgentDetail,
  AgentStats,
  Bootstrap,
  Bridge,
  ComboView,
  FolderView,
  SessionAgent,
  SessionInspection,
  SessionRow,
  StepDetail,
} from "../../shared/ipc.ts";
import { mockConversations } from "./mockConversation.ts";

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
      asked: "You are implementing an approved plan in the kirby repo.",
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
      asked: "Review the diff against the plan and list anything that contradicts it.",
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

// what each agent did, step by step. a few written out by hand so the look can be judged on
// something real-shaped, the rest generated - one of them 300 steps long.
type MockStep = AgentDetail["steps"][number];
const detailsById = new Map<string, AgentDetail>();
const bodies = new Map<string, StepDetail>();

const FILES = [
  "src/jobs/nightly.ts",
  "src/jobs/rollup.ts",
  "src/db/pool.ts",
  "src/db/queries/events.sql",
  "packages/core/src/sessions/agents.ts",
  "packages/core/src/sessions/liveStatus.ts",
  "apps/desktop/src/main/services/sessions.ts",
  "apps/desktop/src/renderer/components/SessionList.tsx",
  "migrations/0191_events.sql",
  "README.md",
];

function steps(
  start: number,
  spec: Array<
    | { say: string; at: number }
    | { think: string; at: number }
    | {
        tool: string;
        target: string;
        at: number;
        took?: number;
        failure?: string;
        agentId?: string;
        input?: string;
        result?: string;
      }
  >,
  agentId: string,
): MockStep[] {
  return spec.map((x, n): MockStep => {
    if ("say" in x) return { kind: "text", n, text: x.say, at: start + x.at * 1000 };
    if ("think" in x) return { kind: "thinking", n, text: x.think, at: start + x.at * 1000 };
    const id = `toolu_${agentId}_${n}`;
    bodies.set(id, {
      input: x.input ?? JSON.stringify({ target: x.target }, null, 2),
      result: x.result ?? `(output of ${x.tool} ${x.target})`,
      ...(x.failure ? { isError: true } : {}),
      truncated: false,
    });
    return {
      kind: "tool",
      n,
      id,
      name: x.tool,
      target: x.target,
      at: start + x.at * 1000,
      ...(x.took === -1 ? {} : { durationMs: (x.took ?? 1) * 1000 }),
      ...(x.failure ? { failure: x.failure } : {}),
      ...(x.agentId ? { agentId: x.agentId } : {}),
    };
  });
}

/** a long agent's life: reads, searches, edits and test runs, in the rhythm real ones have */
function generated(agentId: string, start: number, count: number, spanS: number): MockStep[] {
  const spec: Parameters<typeof steps>[1] = [];
  for (let i = 0; i < count; i++) {
    const at = Math.round((i / count) * spanS);
    const file = FILES[(i * 7) % FILES.length] ?? "README.md";
    const phase = i % 23;
    if (phase === 0)
      spec.push({ say: `Looking at ${file} next, since the scan starts there.`, at });
    else if (phase < 6) spec.push({ tool: "Read", target: file, at });
    else if (phase < 8)
      spec.push({ tool: "Grep", target: `"agents" in ${file.split("/")[0]}`, at });
    else if (phase < 13) spec.push({ tool: "Edit", target: file, at });
    else if (phase === 13)
      spec.push({
        tool: "Bash",
        target: "pnpm test",
        at,
        took: 6,
        ...(i % 3 === 0
          ? {
              failure: "exit 1",
              result: "Exit code 1\n FAIL  test/sessions.test.ts > agents on every session",
            }
          : {}),
      });
    else if (phase < 20)
      spec.push({ tool: "Read", target: FILES[(i * 3) % FILES.length] ?? "", at });
    else spec.push({ tool: "Bash", target: "pnpm typecheck && pnpm lint", at, took: 9 });
  }
  return steps(start, spec, agentId);
}

const REPORT = `Found it. **Two of the 14 queries changed on Tuesday**, and one of them is the spike.

| query | file | change |
| --- | --- | --- |
| nightly rollup | \`src/jobs/rollup.ts\` | window widened from 7 to 30 days |
| events join | \`src/db/queries/events.sql\` | new join on \`account_id\`, no index |

The join is the expensive one: \`EXPLAIN\` shows a sequential scan over 41M rows.

\`\`\`sql
create index concurrently events_account_id on events (account_id);
\`\`\`

- the rollup change is slower but bounded
- the join is what pins the CPU from 02:00
- see the [planner docs](https://www.postgresql.org/docs/current/using-explain.html)

<script>alert("this stays text")</script>`;

function mockDetail(a: SessionAgent): AgentDetail {
  const st = stats[a.id];
  const start = st?.startedAt ?? a.startedAt;
  const base = {
    key: "",
    id: a.id,
    tokens: st?.tokens ?? 0,
    toolCount: st?.toolCount ?? 0,
    startedAt: start,
    ...(st?.lastAt !== undefined ? { lastAt: st.lastAt } : {}),
    ...(st?.model ? { model: st.model } : {}),
    ...(st?.error ? { error: st.error } : {}),
  };
  const prompt = `${a.description ?? st?.asked ?? "Do the thing."}\n\nWork in the repo as it is, report what you found with file paths, and do not change anything outside \`src/\`. If the answer needs a migration, say so rather than writing one.`;
  switch (a.id) {
    case "a01":
      return {
        ...base,
        prompt,
        result: REPORT,
        steps: steps(
          start,
          [
            { say: "Starting from the job's entry point.", at: 2 },
            { tool: "Read", target: "src/jobs/nightly.ts", at: 4 },
            { tool: "Grep", target: '"db.query" in src/jobs', at: 9 },
            { tool: "Read", target: "src/jobs/rollup.ts", at: 14 },
            { tool: "Read", target: "src/db/pool.ts", at: 16 },
            { tool: "Read", target: "src/db/queries/events.sql", at: 18 },
            { tool: "Read", target: "src/db/queries/accounts.sql", at: 19 },
            {
              tool: "Bash",
              target: "git log --since=7.days --oneline -- src/jobs src/db",
              at: 30,
              took: 2,
              result: "9f04c16 widen the rollup window\n32a5aa2 add the events join",
            },
            {
              say: "Two commits touch the job. The second adds a join I have not seen yet.",
              at: 33,
            },
            {
              tool: "Bash",
              target: "psql -c 'explain select * from events join accounts using (account_id)'",
              at: 60,
              took: 4,
              failure: "exit 2",
              result:
                'Exit code 2\npsql: error: connection to server on socket "/tmp/.s.PGSQL.5432" failed: No such file or directory',
            },
            { tool: "Bash", target: "psql $REPLICA_URL -c 'explain ...'", at: 80, took: 3 },
            {
              tool: "WebFetch",
              target: "www.postgresql.org/docs/current/using-explain.html",
              at: 110,
              took: 5,
            },
          ],
          a.id,
        ),
      };
    case "a03":
      return {
        ...base,
        prompt,
        steps: steps(
          start,
          [
            {
              tool: "WebFetch",
              target: "www.postgresql.org/docs/current/pgstatstatements.html",
              at: 5,
              took: 4,
            },
          ],
          a.id,
        ),
      };
    case "a04":
      return {
        ...base,
        prompt,
        steps: [
          ...steps(
            start,
            [
              {
                think:
                  "The replay has to start from the same data, so a schema-only dump first, then the batch.",
                at: 3,
              },
              {
                tool: "Bash",
                target: "pg_dump --schema-only prod > /tmp/schema.sql",
                at: 10,
                took: 20,
              },
              {
                tool: "Bash",
                target: "psql replica -f replay.sql",
                at: 300,
                took: 40,
                failure: "exit 1",
                result:
                  'Exit code 1\nERROR:  relation "events_tmp" does not exist\nLINE 1: insert into events_tmp select * from events where ...',
              },
              { say: "The replay needs the temp table the job creates first. Adding it.", at: 345 },
              { tool: "Edit", target: "replay.sql", at: 350 },
              { tool: "Bash", target: "psql replica -f replay.sql", at: 400, took: 60 },
            ],
            a.id,
          ),
          ...generated(a.id, start + 460_000, 58, 20 * 60 - 470).map((x) => ({ ...x, n: x.n + 6 })),
        ].map((x, i, all) =>
          // the last call is still going
          i === all.length - 1 && x.kind === "tool" ? { ...x, durationMs: undefined } : x,
        ) as MockStep[],
      };
    case "c01":
      return {
        ...base,
        prompt,
        result:
          "The serializer derives the name on create and keeps it on update, with two new tests. Both writers are covered.",
        steps: steps(
          start,
          [
            { tool: "Read", target: "kirby/serializers/bds.py", at: 20 },
            {
              tool: "Agent",
              target: "Find every writer of big_query_table_name",
              at: 120,
              took: 180,
              agentId: "c02",
            },
            {
              tool: "Agent",
              target: "Check what platform sends to the route",
              at: 180,
              took: 420,
              agentId: "c03",
            },
            { tool: "Edit", target: "kirby/serializers/bds.py", at: 700 },
            { tool: "Bash", target: "pytest kirby/tests/test_bds.py -q", at: 760, took: 30 },
          ],
          a.id,
        ),
      };
    default: {
      const long = a.id === "b03";
      return {
        ...base,
        prompt,
        ...(st?.outcome ? { result: st.outcome } : {}),
        steps: generated(
          a.id,
          start,
          long ? 300 : Math.max(3, st?.toolCount ?? 8),
          long ? 42 * 60 : 150,
        ),
      };
    }
  }
}

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

if (variant === "conversation") {
  // the inbox: a permission prompt with what it would run, a turn that ended on a question, and a
  // background session blocked where it runs
  Object.assign(sessions[1] ?? {}, {
    live: {
      state: "permission",
      at: NOW - 3 * MIN,
      lastEventAt: NOW - 3 * MIN,
      detail: "Bash",
      target: "pnpm test --filter webhooks -- --retries=0",
    },
  });
  Object.assign(sessions[2] ?? {}, {
    live: {
      state: "waiting",
      at: NOW - 12 * MIN,
      lastEventAt: NOW - 12 * MIN,
      detail: "Moved the export button to the first page of the report flow.",
      question:
        "The old button is still on the last page behind the flag. Want me to remove it now, or keep it for one release and open a follow-up card to take it out after the next deploy?",
    },
  });
  Object.assign(sessions[4] ?? {}, {
    background: { id: "d7b6bcc2", state: "blocked", held: true, waitingFor: "permission prompt" },
    live: {
      state: "permission",
      at: NOW - 40 * MIN,
      lastEventAt: NOW - 40 * MIN,
      detail: "permission prompt",
      source: "agents",
    },
  });
  // the pane's own mock: the first row is the long conversation, still running
  Object.assign(sessions[0] ?? {}, {
    title: "Chat feature brainstorm",
    comboName: "chat-features",
    cwdBase: "chat-features",
    gitBranch: "chat-view",
    firstPrompt: "some feedback from using: clicking on a session should not open vs-code",
  });
}

if (variant === "agents" || variant === "conversation") {
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
  if (variant === "agents") give(6, finished, { title: "Chat feature brainstorm" });
}

const okv = <T>(value: T) => Promise.resolve({ ok: true as const, value });

// push events, so a running agent can be watched writing in the browser too
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (channel: string, payload: unknown) => {
  for (const l of listeners.get(channel) ?? []) l(payload);
};
let followGen = 0;
let tail: ReturnType<typeof setInterval> | null = null;

/** a running agent keeps writing: a step every couple of seconds, like a busy one does */
function follow(key: string, a: SessionAgent, gen: number): void {
  if (tail) clearInterval(tail);
  tail = null;
  if (a.state !== "running") return;
  tail = setInterval(() => {
    const held = detailsById.get(a.id);
    if (!held) return;
    const n = held.steps.length;
    const last = held.steps[n - 1];
    // the call that was still going comes back, and the next one starts
    const settled =
      last?.kind === "tool" && last.durationMs === undefined ? [{ ...last, durationMs: 1800 }] : [];
    const file = FILES[n % FILES.length] ?? "README.md";
    const next: MockStep = {
      kind: "tool",
      n,
      id: `toolu_${a.id}_${n}`,
      name: n % 5 === 0 ? "Bash" : "Read",
      target: n % 5 === 0 ? "psql replica -f replay.sql" : file,
      at: Date.now(),
    };
    bodies.set(next.id, {
      input: JSON.stringify({ file_path: file }, null, 2),
      result: "…",
      truncated: false,
    });
    const from = settled.length ? n - 1 : n;
    const steps = [...held.steps.slice(0, from), ...settled, next];
    const updated = { ...held, steps, toolCount: held.toolCount + 1, tokens: held.tokens + 1400 };
    detailsById.set(a.id, updated);
    const { key: _k, id: _i, steps: _s, prompt: _p, ...head } = updated;
    emit("agent:steps", { key, id: a.id, gen, from, steps: steps.slice(from), head });
  }, 2000);
}

const convo = mockConversations(sessions, (channel, payload) => emit(channel, payload));

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
  followAgent: async (key, agentId) => {
    const gen = ++followGen;
    if (tail) clearInterval(tail);
    tail = null;
    if (agentId === null) return null;
    const a = sessions.find((r) => r.key === key)?.agents?.find((x) => x.id === agentId);
    if (!a) return null;
    const held = detailsById.get(agentId) ?? mockDetail(a);
    detailsById.set(agentId, held);
    follow(key, a, gen);
    return { gen, detail: { ...held, key } };
  },
  agentStep: async (_key, _agentId, stepId) => bodies.get(stepId) ?? null,
  followConversation: async (key, find) => convo.follow(key, find),
  conversationSteps: async (key, n) => convo.steps(key, n),
  conversationStep: async (_key, stepId) => convo.step(stepId),
  lastWords: async () => "Want me to push the branch now, or wait until the review is done?",
  agentsSeen: async () => {},
  openExternal: () => okv(undefined),
  markSeen: async () => {},
  archiveSessions: () => okv(undefined),
  runSessionAction: () => okv({ message: "Done (mock)" }),
  dispatchBackground: () => okv({ id: "d7b6bcc2", message: "continuing in background · d7b6bcc2" }),
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
  on: (channel, listener) => {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    listeners.set(channel, set);
    return () => set.delete(listener as (payload: unknown) => void);
  },
};

window.grove = bridge;
