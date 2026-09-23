// a session that sent five agents out, as their own transcripts: two finished, one that died on an
// api error, two still running. what the inspector screenshots are taken of.
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeProjectSlug } from "@grove/core";
import { type Fixture, writeAgent, writeSession } from "./fixture.ts";

const MIN = 60_000;

export const FANOUT = {
  session: "cccccccc-0000-4000-8000-00000000000c",
  survey: "a1d0000000000001",
  planner: "a1d0000000000002",
  guide: "a1d0000000000003",
  replay: "a1d0000000000004",
  plan: "a1d0000000000005",
};

/** what the survey agent came back with: markdown, a table, a link, and html that must stay text */
export const SURVEY_RESULT = `The job runs 14 queries, and two of them changed on Tuesday: the rollup now scans a 30 day window, and a new join pulls in \`events\` without an index on \`account_id\`.

| query | file | change |
| --- | --- | --- |
| nightly rollup | \`src/jobs/rollup.ts\` | window widened from 7 to 30 days |
| events join | \`src/jobs/events.sql\` | new join on \`account_id\`, no index |

The rollup change is slower but bounded: it reads a month instead of a week, once a night, and
finishes in four minutes either way. The join is what pins the CPU from 02:00 until the job ends.

- the join is a sequential scan over 41M rows
- an index on \`events(account_id)\` built concurrently avoids the lock
- see the [planner docs](https://www.postgresql.org/docs/current/using-explain.html)

<img src="https://example.com/x.png" onerror="alert(1)"><script>window.pwned = true</script>`;

export function writeFanOut(fx: Fixture, cwd: string): string {
  const sessionId = FANOUT.session;
  const transcript = writeSession(fx, {
    cwd,
    sessionId,
    title: "Database CPU spike during the nightly job",
    prompt: "the primary is pinned at 95% cpu since 02:00, can you check which queries changed",
    ageMs: 20_000,
  });
  const src = `${cwd}/src`;
  writeAgent(fx, {
    cwd,
    sessionId,
    id: FANOUT.survey,
    agentType: "Explore",
    description: "Survey the nightly job's queries",
    prompt:
      "List every query the nightly job runs, with the file it lives in, and say which ones changed in the last week.",
    startedAgoMs: 26 * MIN,
    steps: [
      { say: "Starting from the job's entry point.", at: 2 },
      {
        tool: "Read",
        input: { file_path: `${src}/jobs/nightly.ts` },
        result: "export async function nightly() {}",
        at: 4,
      },
      {
        tool: "Grep",
        input: { pattern: "db.query", path: `${src}/jobs` },
        result: "src/jobs/nightly.ts:41\nsrc/jobs/rollup.ts:12",
        at: 9,
      },
      {
        tool: "Read",
        input: { file_path: `${src}/jobs/rollup.ts` },
        result: "export const ROLLUP = `select ...`",
        at: 14,
      },
      {
        tool: "Bash",
        input: { command: "git log --since=7.days --oneline -- src/jobs" },
        result: "9f04c16 widen the rollup window\n32a5aa2 add the events join",
        at: 30,
        took: 2,
      },
      {
        tool: "Read",
        input: { file_path: `${src}/jobs/events.sql` },
        result: "select * from events join ...",
        at: 60,
      },
      {
        tool: "Bash",
        input: {
          command: "psql -c 'explain select * from events join accounts using (account_id)'",
        },
        result:
          'Exit code 2\npsql: error: connection to server on socket "/tmp/.s.PGSQL.5432" failed: No such file or directory',
        at: 75,
        took: 1,
        error: true,
      },
      { say: "No local database. Reading the plan from the replica instead.", at: 78 },
      {
        tool: "Bash",
        input: { command: "psql $REPLICA_URL -c 'explain select * from events join accounts'" },
        result: "Seq Scan on events  (cost=0.00..918273.00 rows=41000000)",
        at: 80,
        took: 3,
      },
    ],
    result: { text: SURVEY_RESULT, at: 151 },
  });
  writeAgent(fx, {
    cwd,
    sessionId,
    id: FANOUT.planner,
    agentType: "Explore",
    description: "Find what changed in the planner stats",
    prompt: "Compare pg_stats for the events table before and after the 09-19 migration.",
    startedAgoMs: 25 * MIN + 40_000,
    steps: [
      {
        tool: "Bash",
        input: { command: "psql -c 'select * from pg_stat_user_tables'" },
        result: "relname | last_analyze\nevents | 2026-09-19",
        at: 6,
        took: 3,
      },
      {
        tool: "Grep",
        input: { pattern: "ANALYZE", path: `${cwd}/migrations` },
        result: "migrations/0191_events.sql:3",
        at: 40,
      },
      {
        tool: "Read",
        input: { file_path: `${cwd}/migrations/0191_events.sql` },
        result: "alter table events set (autovacuum_enabled = false);",
        at: 70,
      },
    ],
    result: {
      text: "autovacuum stopped analyzing the events table after the 09-19 migration turned it off, so the planner still thinks the table is small.",
      at: 280,
    },
  });
  writeAgent(fx, {
    cwd,
    sessionId,
    id: FANOUT.guide,
    agentType: "claude-code-guide",
    description: "Check how pg_stat_statements resets",
    model: "claude-haiku-4-5-20251001",
    prompt: "When does pg_stat_statements reset its counters, and does a restart clear them?",
    startedAgoMs: 24 * MIN,
    steps: [
      {
        tool: "WebFetch",
        input: {
          url: "https://www.postgresql.org/docs/current/pgstatstatements.html",
          prompt: "reset",
        },
        result: "pg_stat_statements_reset discards all statistics",
        at: 5,
        took: 4,
      },
    ],
    apiError: {
      text: "API Error: Connection refused - a firewall or proxy may be blocking it (ConnectionRefused)",
      at: 70,
    },
  });
  writeAgent(fx, {
    cwd,
    sessionId,
    id: FANOUT.replay,
    agentType: "general-purpose",
    description: "Reproduce the spike against a replica",
    model: "claude-opus-5",
    prompt:
      "Replay the 02:00 batch against the read replica and capture the plan of anything slower than 1s.",
    startedAgoMs: 20 * MIN,
    steps: [
      {
        tool: "Bash",
        input: { command: "pg_dump --schema-only prod > /tmp/schema.sql" },
        result: "",
        at: 10,
        took: 20,
      },
      {
        tool: "Bash",
        input: { command: "psql replica -f replay.sql" },
        result: 'Exit code 1\nERROR: relation "events_tmp" does not exist',
        at: 300,
        took: 40,
        error: true,
      },
      { say: "The replay needs the temp table the job creates first. Adding it.", at: 345 },
      {
        tool: "Edit",
        input: {
          file_path: `${cwd}/replay.sql`,
          old_string: "insert",
          new_string: "create temp table events_tmp as ...; insert",
        },
        result: "The file has been updated.",
        at: 350,
      },
      {
        tool: "Bash",
        input: { command: "psql replica -f replay.sql" },
        result: "Time: 48213.119 ms",
        at: 400,
        took: 60,
      },
    ],
  });
  writeAgent(fx, {
    cwd,
    sessionId,
    id: FANOUT.plan,
    agentType: "Plan",
    description: "Plan the index change",
    model: "claude-opus-5",
    prompt: "Plan an index for events(account_id) that can be built without locking the table.",
    startedAgoMs: 8 * MIN,
    steps: [
      {
        tool: "Read",
        input: { file_path: `${cwd}/migrations/0192_events_index.sql` },
        result: "-- empty",
        at: 20,
      },
      {
        say: "A concurrent index build avoids the lock, but it cannot run inside a transaction.",
        at: 60,
      },
    ],
  });
  return transcript;
}

export const DERIVE = {
  session: "eeeeeeee-0000-4000-8000-00000000000e",
  parent: "a2e0000000000001",
  writers: "a2e0000000000002",
  platform: "a2e0000000000003",
  run: "wf_a2e00000-001",
  implement: "a2e0000000000004",
  review: "a2e0000000000005",
};

/**
 * a session whose long-task agent sent two agents of its own, then ran a workflow of two more.
 * what a nested agent and a workflow look like, which nothing on a real machine had yet.
 */
export function writeDerive(fx: Fixture, cwd: string): string {
  const sessionId = DERIVE.session;
  const transcript = writeSession(fx, {
    cwd,
    sessionId,
    title: "Derive BDS table names instead of accepting them",
    prompt: "derive big_query_table_name on create instead of taking it from the request",
    ageMs: 2 * 3_600_000,
  });
  const HOUR = 3_600_000;
  const MIN = 60_000;
  writeAgent(fx, {
    cwd,
    sessionId,
    id: DERIVE.parent,
    agentType: "long-task",
    description: "Derive BDS table names on create",
    model: "claude-opus-5",
    prompt: "Make the serializer derive big_query_table_name on create and keep it on update.",
    startedAgoMs: 3 * HOUR,
    steps: [
      {
        tool: "Read",
        input: { file_path: `${cwd}/kirby/serializers/bds.py` },
        result: "class BdsSerializer: ...",
        at: 20,
      },
      {
        tool: "Agent",
        input: {
          description: "Find every writer of big_query_table_name",
          prompt: "Find every writer.",
          subagent_type: "Explore",
        },
        result: "Only the ORM path writes it.",
        at: 60,
        took: 180,
      },
      {
        tool: "Agent",
        input: {
          description: "Check what platform sends to the route",
          prompt: "Check platform.",
          subagent_type: "Explore",
        },
        result: "platform strips it before forwarding.",
        at: 70,
        took: 400,
      },
      {
        tool: "Edit",
        input: { file_path: `${cwd}/kirby/serializers/bds.py`, old_string: "a", new_string: "b" },
        result: "The file has been updated.",
        at: 500,
      },
    ],
    result: {
      text: "The serializer derives the name on create and keeps it on update, with two new tests.",
      at: 620,
    },
  });
  const child = (id: string, n: number, description: string, text: string, at: number) =>
    writeAgent(fx, {
      cwd,
      sessionId,
      id,
      agentType: "Explore",
      description,
      spawnDepth: 2,
      toolUseId: `toolu_${DERIVE.parent}_${n}`,
      prompt: description,
      startedAgoMs: 3 * HOUR - at * 1000,
      steps: [
        {
          tool: "Grep",
          input: { pattern: "big_query_table_name", path: cwd },
          result: "kirby/models.py:12",
          at: 5,
        },
      ],
      result: { text, at: 150 },
    });
  child(
    DERIVE.writers,
    1,
    "Find every writer of big_query_table_name",
    "Only kirby's own ORM path writes it.",
    62,
  );
  child(
    DERIVE.platform,
    2,
    "Check what platform sends to the route",
    "platform strips the name before forwarding, so nothing depends on it.",
    72,
  );

  const wf = (id: string, prompt: string, text: string, startedAgoMs: number) =>
    writeAgent(fx, {
      cwd,
      sessionId,
      id,
      agentType: "workflow-subagent",
      workflow: DERIVE.run,
      prompt,
      startedAgoMs,
      steps: [
        {
          tool: "Read",
          input: { file_path: `${cwd}/kirby/serializers/bds.py` },
          result: "...",
          at: 10,
        },
      ],
      result: { text, at: 300 },
    });
  wf(
    DERIVE.implement,
    "You are implementing an approved plan in the kirby repo.",
    "Working tree left uncommitted as instructed, 198 tests passing.",
    2 * HOUR + 40 * MIN,
  );
  wf(
    DERIVE.review,
    "Review the diff against the plan and list anything that contradicts it.",
    "One contradiction: the patch test should keep the literal name.",
    2 * HOUR + 30 * MIN,
  );
  const runDir = path.join(
    fx.projectsDir,
    claudeProjectSlug(cwd),
    sessionId,
    "subagents",
    "workflows",
    DERIVE.run,
  );
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, "journal.jsonl"),
    `${[
      { type: "started", key: "implement", agentId: DERIVE.implement },
      {
        type: "result",
        key: "implement",
        agentId: DERIVE.implement,
        result: "Working tree left uncommitted as instructed, 198 tests passing.",
      },
      { type: "started", key: "review", agentId: DERIVE.review },
      {
        type: "result",
        key: "review",
        agentId: DERIVE.review,
        result: "One contradiction: the patch test should keep the literal name.",
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")}\n`,
  );
  // what the session's own Workflow call got back: the only place the workflow's name is kept
  appendFileSync(
    transcript,
    `${JSON.stringify({
      type: "user",
      sessionId,
      timestamp: new Date(Date.now() - 2 * HOUR - 45 * MIN).toISOString(),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_wf", content: "launched" }],
      },
      toolUseResult: {
        runId: DERIVE.run,
        workflowName: "cdit-1249-derive-bds-table-name",
        status: "async_launched",
      },
    })}\n`,
  );
  // the session went quiet two hours ago: its file says so too, or it sorts as brand new
  const quiet = new Date(Date.now() - 2 * HOUR);
  utimesSync(transcript, quiet, quiet);
  return transcript;
}

/** where an agent of the fan-out writes its transcript */
export function agentFile(fx: Fixture, cwd: string, sessionId: string, id: string): string {
  return path.join(
    fx.projectsDir,
    claudeProjectSlug(cwd),
    sessionId,
    "subagents",
    `agent-${id}.jsonl`,
  );
}

/** what a running agent writes next: calls and what they returned, the way Claude Code appends them */
export function appendCalls(
  file: string,
  o: { agentId: string; sessionId: string; cwd: string; from: number; count: number },
): void {
  const lines: object[] = [];
  const base = (at: number) => ({
    isSidechain: true,
    agentId: o.agentId,
    timestamp: new Date(at).toISOString(),
    userType: "external",
    entrypoint: "claude-vscode",
    cwd: o.cwd,
    sessionId: o.sessionId,
    version: "2.1.278",
  });
  const now = Date.now();
  // a different tool each time, the way a busy agent goes: a run of one tool folds into a line
  const call = (i: number) => {
    const file = `${o.cwd}/src/tail/file-${i}.ts`;
    if (i % 3 === 0) return { name: "Read", input: { file_path: file } };
    if (i % 3 === 1) return { name: "Grep", input: { pattern: "export", path: file } };
    return { name: "Bash", input: { command: `wc -l src/tail/file-${i}.ts` } };
  };
  for (let i = o.from; i < o.from + o.count; i++) {
    const id = `toolu_tail_${i}`;
    const at = now - (o.from + o.count - i) * 1000;
    lines.push({
      type: "assistant",
      message: {
        model: "claude-opus-5",
        id: `msg_tail_${i}`,
        role: "assistant",
        content: [{ type: "tool_use", id, ...call(i) }],
        usage: {
          input_tokens: 2,
          output_tokens: 80,
          cache_read_input_tokens: 30_000 + i * 900,
          cache_creation_input_tokens: 400,
        },
      },
      ...base(at),
    });
    lines.push({
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: id, type: "tool_result", content: `// file ${i}` }],
      },
      ...base(at + 300),
    });
  }
  appendFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}
