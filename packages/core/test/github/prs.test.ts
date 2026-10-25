import { describe, expect, it } from "vitest";
import {
  checksQuery,
  chunk,
  type PrRef,
  parseFailingChecks,
  parsePrResponse,
  parsePrUrl,
  prDetail,
  prQuery,
  prState,
} from "../../src/github/prs.ts";

const ref = (url: string) => parsePrUrl(url) as PrRef;

// what gh printed on 2026-10-25 for a real PR beside a repo that is not there (it exited 1)
const PARTIAL = JSON.stringify({
  data: {
    r0: {
      p141091: {
        number: 141091,
        url: "https://github.com/Appboy/platform/pull/141091",
        title: "CDIT-1239: turn off google auth methods flag in GCS source e2e",
        state: "CLOSED",
        isDraft: false,
        mergedAt: null,
        updatedAt: "2026-09-25T16:48:11Z",
        reviewDecision: "REVIEW_REQUIRED",
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      },
    },
    r1: null,
  },
  errors: [{ type: "NOT_FOUND", path: ["r1"], message: "Could not resolve to a Repository" }],
});

const open = (o: Record<string, unknown> = {}) => ({
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...o,
});
const rollup = (state: string | null) => ({
  commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] },
});

describe("parsePrUrl", () => {
  it("reads a github link, enterprise hosts too", () => {
    expect(parsePrUrl("https://github.com/o/r.js/pull/12")).toEqual({
      host: "github.com",
      owner: "o",
      repo: "r.js",
      number: 12,
      url: "https://github.com/o/r.js/pull/12",
    });
    expect(parsePrUrl("https://git.corp.io/a/b/pull/3")?.host).toBe("git.corp.io");
  });

  it("anything else, or a name that could leave the query's quotes, is no PR", () => {
    expect(parsePrUrl("https://github.com/o/r/issues/1")).toBeNull();
    expect(parsePrUrl('https://github.com/o"){x}/r/pull/1')).toBeNull();
    expect(parsePrUrl("http://github.com/o/r/pull/1")).toBeNull();
  });
});

describe("prQuery", () => {
  it("aliases a repo once with each of its PRs under it", () => {
    const q = prQuery([
      ref("https://github.com/o/r/pull/1"),
      ref("https://github.com/o/r/pull/2"),
      ref("https://github.com/o/s/pull/1"),
    ]);
    expect(q).toContain('r0: repository(owner: "o", name: "r") { p1: pullRequest(number: 1)');
    expect(q).toContain("p2: pullRequest(number: 2)");
    expect(q).toContain('r1: repository(owner: "o", name: "s")');
    expect(q).toContain("updatedAt reviewDecision");
  });

  it("chunks at 20", () => {
    expect(chunk(Array.from({ length: 45 }, (_, i) => i)).map((c) => c.length)).toEqual([
      20, 20, 5,
    ]);
  });
});

describe("parsePrResponse", () => {
  const refs = [
    ref("https://github.com/Appboy/platform/pull/141091"),
    ref("https://github.com/Appboy/nope-not-real/pull/1"),
  ];

  it("reads the data beside a NOT_FOUND, and says which were missing", () => {
    const out = parsePrResponse(PARTIAL, refs);
    expect(out?.found.get(refs[0]?.url as string)).toEqual({
      title: "CDIT-1239: turn off google auth methods flag in GCS source e2e",
      state: "closed",
      review: "required",
      rollup: "SUCCESS",
      updatedAt: Date.parse("2026-09-25T16:48:11Z"),
    });
    expect(out?.missing).toEqual([refs[1]?.url]);
  });

  it("empty stdout, a 502 page or an error with no data is nothing at all", () => {
    expect(parsePrResponse("", refs)).toBeNull();
    expect(parsePrResponse("<html>502 Bad Gateway</html>", refs)).toBeNull();
    expect(parsePrResponse('{"message":"Bad credentials"}', refs)).toBeNull();
  });

  it("the same PR linked in another case gets the same answer", () => {
    const twins = [
      ref("https://github.com/appboy/platform/pull/141091"),
      ref("https://github.com/Appboy/platform/pull/141091"),
    ];
    const out = parsePrResponse(PARTIAL, twins);
    expect(out?.found.size).toBe(2);
    expect(out?.missing).toEqual([]);
  });
});

describe("prState", () => {
  it("merged > closed > draft > failing > pending > ready", () => {
    expect(prState(open({ state: "MERGED", isDraft: true }))).toBe("merged");
    expect(prState(open({ state: "CLOSED", isDraft: true }))).toBe("closed");
    expect(prState(open({ isDraft: true, ...rollup("FAILURE") }))).toBe("draft");
    expect(prState(open(rollup("FAILURE")))).toBe("failing");
    expect(prState(open(rollup("ERROR")))).toBe("failing");
    expect(prState(open({ reviewDecision: "CHANGES_REQUESTED" }))).toBe("failing");
    expect(prState(open(rollup("PENDING")))).toBe("pending");
    expect(prState(open(rollup("EXPECTED")))).toBe("pending");
    expect(prState(open(rollup(null)))).toBe("pending");
    expect(prState(open())).toBe("ready");
  });
});

describe("failing checks", () => {
  const out = (nodes: unknown[]) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            commits: {
              nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes } } } }],
            },
          },
        },
      },
    });

  it("keeps the failed check runs and statuses, with where they lead", () => {
    const checks = parseFailingChecks(
      out([
        { __typename: "CheckRun", name: "build", conclusion: "SUCCESS", detailsUrl: "https://a" },
        { __typename: "CheckRun", name: "unit", conclusion: "FAILURE", detailsUrl: "https://b" },
        { __typename: "CheckRun", name: "e2e", conclusion: "TIMED_OUT", detailsUrl: null },
        {
          __typename: "StatusContext",
          context: "buildkite",
          state: "ERROR",
          targetUrl: "https://c",
        },
        { __typename: "StatusContext", context: "ok", state: "SUCCESS", targetUrl: "https://d" },
      ]),
    );
    expect(checks).toEqual([
      { name: "unit", url: "https://b" },
      { name: "e2e" },
      { name: "buildkite", url: "https://c" },
    ]);
  });

  it("no data is null, and the query asks for both kinds", () => {
    expect(parseFailingChecks("")).toBeNull();
    const q = checksQuery(ref("https://github.com/o/r/pull/9"));
    expect(q).toContain("... on CheckRun{name conclusion detailsUrl}");
    expect(q).toContain("... on StatusContext{context state targetUrl}");
    expect(q).toContain("pullRequest(number: 9)");
  });
});

describe("the panel's second line", () => {
  const ago = () => "12m ago";

  it("leaves the review out when there is none", () => {
    expect(prDetail({ title: "t", state: "ready", updatedAt: 1 }, undefined, ago)).toEqual({
      words: ["Checks passed"],
      checks: [],
      more: 0,
      updated: "updated 12m ago",
    });
    expect(prDetail({ title: "t", state: "pending", review: "approved" }, [], ago).words).toEqual([
      "Checks running",
      "approved",
    ]);
  });

  it("names three failing checks, then how many more", () => {
    const checks = ["a", "b", "c", "d", "e"].map((name) => ({ name }));
    const d = prDetail({ title: "t", state: "failing", review: "changes" }, checks, ago);
    expect(d.words).toEqual(["Failing", "changes requested"]);
    expect(d.checks.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(d.more).toBe(2);
  });

  it("checks are only named while it fails", () => {
    expect(prDetail({ title: "t", state: "ready" }, [{ name: "a" }], ago).checks).toEqual([]);
  });
});
