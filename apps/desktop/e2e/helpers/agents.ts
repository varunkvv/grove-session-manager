// a session that sent five agents out, as their own transcripts: two finished, one that died on an
// api error, two still running. what the inspector screenshots are taken of.
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
    ],
    result: {
      text: "The job runs 14 queries, and two of them changed on Tuesday: the rollup now scans a 30 day window, and a new join pulls in `events` without an index on `account_id`.",
      at: 151,
    },
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
