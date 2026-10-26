import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeRun } from "../../src/main/services/background.ts";
import {
  IDLE_MS,
  MAX_MS,
  offReason,
  PrService,
  type PrWant,
  parseHosts,
  RECHECK_OFF_MS,
  WORKING_MS,
} from "../../src/main/services/prs.ts";

const A = "https://github.com/o/r/pull/1";
const B = "https://github.com/o/r/pull/2";
const HOSTS = JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true }] } });

const node = (n: number, o: Record<string, unknown> = {}) => ({
  number: n,
  title: `pr ${n}`,
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  updatedAt: "2026-10-25T10:00:00Z",
  reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...o,
});
const answer = (prs: Record<string, unknown>): ClaudeRun => ({
  code: 0,
  stdout: JSON.stringify({ data: { r0: prs } }),
  stderr: "",
});

type Reply = (args: readonly string[]) => ClaudeRun;

function setup(o: { reply: Reply; want?: PrWant[]; visible?: boolean }) {
  const calls: string[][] = [];
  let now = 1_000_000;
  let want = o.want ?? [{ url: A, working: false }];
  const changes: number[] = [];
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-prs-")));
  const prs = new PrService({
    stateFile: path.join(dir, "prs.json"),
    ghBin: async () => "gh",
    env: async () => ({}),
    enabled: () => true,
    visible: () => o.visible ?? true,
    wanted: () => want,
    onChange: () => changes.push(now),
    now: () => now,
    run: async (_bin, args) => {
      calls.push([...args]);
      if (args[0] === "auth") return { code: 0, stdout: HOSTS, stderr: "" };
      return o.reply(args);
    },
  });
  return {
    prs,
    calls,
    changes,
    dir,
    graphql: () => calls.filter((c) => c[0] === "api"),
    advance: (ms: number) => {
      now += ms;
    },
    setWant: (w: PrWant[]) => {
      want = w;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("asking github about the PRs", () => {
  it("one query for the open ones, kept by url and written to disk", async () => {
    const t = setup({
      reply: () => answer({ p1: node(1), p2: node(2, { isDraft: true }) }),
      want: [
        { url: A, working: false },
        { url: B, working: false },
      ],
    });
    await t.prs.tick();
    expect(t.graphql()).toHaveLength(1);
    expect(t.prs.get(A)).toMatchObject({ title: "pr 1", state: "ready", checkedAt: 1_000_000 });
    expect(t.prs.get(B)?.state).toBe("draft");
    expect(t.changes).toHaveLength(1);
    await vi.waitFor(() =>
      expect(Object.keys(JSON.parse(readFileSync(path.join(t.dir, "prs.json"), "utf8")))).toEqual([
        A,
        B,
      ]),
    );
  });

  it("a missing repo beside a real one: the real one's data is read, the missing one never asked again", async () => {
    const t = setup({
      reply: () => ({
        code: 1,
        stdout: JSON.stringify({ data: { r0: { p1: node(1) } }, errors: [{ type: "NOT_FOUND" }] }),
        stderr: "gh: Could not resolve",
      }),
      want: [
        { url: A, working: false },
        { url: "https://github.com/o/gone/pull/9", working: false },
      ],
    });
    await t.prs.tick();
    expect(t.prs.get(A)?.state).toBe("ready");
    t.advance(IDLE_MS);
    await t.prs.tick();
    expect(t.graphql()[1]?.[3]).not.toContain("gone");
  });

  it("merged is never asked about again", async () => {
    const t = setup({ reply: () => answer({ p1: node(1, { state: "MERGED" }) }) });
    await t.prs.tick();
    expect(t.prs.get(A)?.state).toBe("merged");
    t.advance(IDLE_MS);
    await t.prs.tick();
    expect(t.graphql()).toHaveLength(1);
  });

  it("every minute while a session works, every five otherwise, and nothing while hidden", async () => {
    const t = setup({ reply: () => answer({ p1: node(1) }), want: [{ url: A, working: true }] });
    await t.prs.tick();
    await vi.advanceTimersByTimeAsync(WORKING_MS - 1);
    expect(t.graphql()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.graphql()).toHaveLength(2);

    t.setWant([{ url: A, working: false }]);
    await vi.advanceTimersByTimeAsync(WORKING_MS);
    expect(t.graphql()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(t.graphql()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.graphql()).toHaveLength(4);

    const hidden = setup({ reply: () => answer({ p1: node(1) }), visible: false });
    await hidden.prs.tick();
    expect(hidden.calls).toEqual([]);
  });

  it("a failure doubles the wait, up to 30 minutes, and marks what it has as stale", async () => {
    let fail = false;
    const t = setup({
      reply: () => (fail ? { code: 1, stdout: "", stderr: "HTTP 502" } : answer({ p1: node(1) })),
    });
    await t.prs.tick();
    fail = true;
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(t.graphql()).toHaveLength(2);
    expect(t.prs.get(A)).toMatchObject({ state: "ready", stale: true });
    // the next is 10 minutes away, not 5
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(t.graphql()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(t.graphql()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(MAX_MS * 4);
    const gaps = t.graphql().length;
    await vi.advanceTimersByTimeAsync(MAX_MS);
    expect(t.graphql().length).toBe(gaps + 1);
  });

  it("a new link is asked about two seconds after it shows", async () => {
    const t = setup({ reply: () => answer({ p1: node(1), p2: node(2) }) });
    await t.prs.tick();
    t.setWant([
      { url: A, working: false },
      { url: B, working: false },
    ]);
    t.prs.poke();
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.graphql()).toHaveLength(2);
    expect(t.prs.get(B)?.state).toBe("ready");
  });
});

describe("no gh, or logged out", () => {
  it("logged out (exit 4) turns it off until focus, at most every 10 minutes", async () => {
    const calls: string[][] = [];
    let now = 0;
    let loggedIn = false;
    const prs = new PrService({
      stateFile: path.join(os.tmpdir(), "grove-prs-unused.json"),
      ghBin: async () => "gh",
      env: async () => ({}),
      enabled: () => true,
      visible: () => true,
      wanted: () => [{ url: A, working: false }],
      onChange: () => {},
      now: () => now,
      run: async (_b, args) => {
        calls.push([...args]);
        if (args[0] === "auth") {
          return loggedIn
            ? { code: 0, stdout: HOSTS, stderr: "" }
            : { code: 4, stdout: "", stderr: "not logged in" };
        }
        return answer({ p1: node(1) });
      },
    });
    await prs.tick();
    expect(calls).toEqual([["auth", "status", "--json", "hosts"]]);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(calls).toHaveLength(1);

    loggedIn = true;
    now = RECHECK_OFF_MS - 1;
    prs.kick();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    now = RECHECK_OFF_MS;
    prs.kick();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prs.get(A)?.state).toBe("ready");
  });

  it("knows ENOENT, exit 4 and a bad token when it sees them", () => {
    expect(offReason({ code: null, stdout: "", stderr: "spawn gh ENOENT" })).toBe("no gh");
    expect(offReason({ code: 4, stdout: "", stderr: "" })).toBe("logged out");
    expect(offReason({ code: 1, stdout: "", stderr: "HTTP 401: Bad credentials" })).toBe(
      "logged out",
    );
    expect(offReason({ code: 1, stdout: "", stderr: "HTTP 502" })).toBeUndefined();
  });

  it("reads the hosts gh is logged in to", () => {
    expect([...(parseHosts(HOSTS) ?? [])]).toEqual(["github.com"]);
    expect(
      parseHosts(JSON.stringify({ hosts: { "git.corp.io": [{ state: "error" }] } }))?.size,
    ).toBe(0);
    expect(parseHosts("unknown flag: --json")).toBeNull();
  });

  it("a PR on a host gh is not logged in to is never asked about", async () => {
    const t = setup({
      reply: () => answer({}),
      want: [{ url: "https://git.corp.io/o/r/pull/1", working: false }],
    });
    await t.prs.tick();
    expect(t.graphql()).toEqual([]);
  });
});

describe("failing checks for the panel", () => {
  const failing = node(1, {
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  });
  const checks = (name: string): ClaudeRun => ({
    code: 0,
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      state: "FAILURE",
                      contexts: {
                        nodes: [{ name, conclusion: "FAILURE", detailsUrl: "https://ci/1" }],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    }),
    stderr: "",
  });

  it("asked once per rollup state, never for a PR that is not failing", async () => {
    let rollup = failing;
    const t = setup({
      reply: (args) => (args[3]?.includes("contexts") ? checks("unit") : answer({ p1: rollup })),
    });
    await t.prs.tick();
    expect(await t.prs.failingChecks(A)).toEqual([{ name: "unit", url: "https://ci/1" }]);
    expect(await t.prs.failingChecks(A)).toHaveLength(1);
    expect(t.graphql()).toHaveLength(2);

    rollup = node(1);
    t.advance(IDLE_MS);
    await t.prs.tick();
    expect(await t.prs.failingChecks(A)).toEqual([]);
    expect(t.graphql()).toHaveLength(3);
  });
});

describe("the PR pane's ask", () => {
  const info: ClaudeRun = {
    code: 0,
    stdout: JSON.stringify({
      data: { repository: { pullRequest: { ...node(1), baseRefName: "main", headRefName: "x" } } },
    }),
    stderr: "",
  };

  it("asks fresh each time, and only for a PR a session linked", async () => {
    const t = setup({
      reply: (args) => (args[3]?.includes("baseRefName") ? info : answer({ p1: node(1) })),
    });
    // not known yet: nothing linked it
    expect(await t.prs.info(A)).toBeNull();
    await t.prs.tick();
    expect(await t.prs.info(A)).toMatchObject({ title: "pr 1", base: "main", head: "x" });
    await t.prs.info(A);
    expect(t.graphql().filter((c) => c[3]?.includes("baseRefName"))).toHaveLength(2);
    expect(await t.prs.info("https://github.com/evil/repo/pull/9")).toBeNull();
  });
});
