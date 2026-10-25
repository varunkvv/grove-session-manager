/**
 * what a pull request a session linked is at, from `gh api graphql`. pure: the app runs gh, this
 * makes the query and reads what came back. a repo grove cannot see comes back as a null alias
 * beside the ones it can, with gh exiting 1, so stdout is read whenever it has `data`
 */

export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
  /** the link as the transcript has it: the key everything else uses */
  url: string;
}

/** colour on the mark: green ready, red failing, faint the rest. the shape says open, draft, done */
export type PrState = "ready" | "failing" | "pending" | "draft" | "merged" | "closed";
export type PrReview = "approved" | "changes" | "required";

export interface PrStatus {
  title: string;
  state: PrState;
  review?: PrReview;
  /** the rollup's own word (SUCCESS, FAILURE, ...): when it moves, the failing checks are stale */
  rollup?: string;
  /** when the PR last changed, on github */
  updatedAt?: number;
}

export interface FailingCheck {
  name: string;
  url?: string;
}

/** at most this many in one query: 65 in one 502'd */
export const PR_CHUNK = 20;

/** a name github allows, and nothing that could leave a quoted string */
const NAME = /^[A-Za-z0-9_.-]+$/;

export function parsePrUrl(url: string): PrRef | null {
  const m = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/.exec(url);
  if (!m) return null;
  const [, host, owner, repo, n] = m;
  if (!host || !owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return null;
  return { host, owner, repo, number: Number(n), url };
}

export function chunk<T>(xs: readonly T[], size = PR_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** a repo per alias, its PRs under it: `r0.p123`. the same refs always get the same aliases */
function aliases(refs: readonly PrRef[]): Map<string, PrRef[]> {
  const repos = new Map<string, PrRef[]>();
  for (const r of refs) {
    const key = `${r.owner}/${r.repo}`.toLowerCase();
    const list = repos.get(key) ?? [];
    if (!list.some((x) => x.number === r.number)) list.push(r);
    repos.set(key, list);
  }
  return repos;
}

const PR_FIELDS =
  "number url title state isDraft mergedAt updatedAt reviewDecision " +
  "commits(last:1){nodes{commit{statusCheckRollup{state}}}}";

/** one query for PRs on one host. the caller chunks */
export function prQuery(refs: readonly PrRef[]): string {
  const parts = [...aliases(refs).values()].map((list, i) => {
    const first = list[0] as PrRef;
    const prs = list.map((r) => `p${r.number}: pullRequest(number: ${r.number}) { ${PR_FIELDS} }`);
    return `r${i}: repository(owner: "${first.owner}", name: "${first.repo}") { ${prs.join(" ")} }`;
  });
  return `query { ${parts.join(" ")} }`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function dataOf(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isObject(parsed) && isObject(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

function rollupOf(node: Record<string, unknown>): Record<string, unknown> | undefined {
  const commits = node.commits;
  const nodes = isObject(commits) && Array.isArray(commits.nodes) ? commits.nodes : [];
  const last = nodes[nodes.length - 1];
  const commit = isObject(last) && isObject(last.commit) ? last.commit : undefined;
  return commit && isObject(commit.statusCheckRollup) ? commit.statusCheckRollup : undefined;
}

const REVIEW: Record<string, PrReview> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  REVIEW_REQUIRED: "required",
};

/** merged > closed > draft > failing > pending > ready. changes requested is failing */
export function prState(node: Record<string, unknown>): PrState {
  if (node.state === "MERGED" || node.mergedAt) return "merged";
  if (node.state === "CLOSED") return "closed";
  if (node.isDraft === true) return "draft";
  const rollup = rollupOf(node)?.state;
  if (rollup === "FAILURE" || rollup === "ERROR" || node.reviewDecision === "CHANGES_REQUESTED") {
    return "failing";
  }
  if (!rollup || rollup === "PENDING" || rollup === "EXPECTED") return "pending";
  return "ready";
}

function statusOf(node: Record<string, unknown>): PrStatus {
  const state = prState(node);
  const rollup = rollupOf(node)?.state;
  const updated = typeof node.updatedAt === "string" ? Date.parse(node.updatedAt) : Number.NaN;
  // a draft's review means nothing yet
  const review =
    state === "draft" || typeof node.reviewDecision !== "string"
      ? undefined
      : REVIEW[node.reviewDecision];
  return {
    title: typeof node.title === "string" ? node.title : "",
    state,
    ...(review ? { review } : {}),
    ...(typeof rollup === "string" ? { rollup } : {}),
    ...(Number.isFinite(updated) ? { updatedAt: updated } : {}),
  };
}

/**
 * what came back for `refs`, by url. `missing` is the ones github says are not there (or not
 * there for this login). null when stdout has no data at all: a 502, an auth failure, nothing
 */
export function parsePrResponse(
  stdout: string,
  refs: readonly PrRef[],
): { found: Map<string, PrStatus>; missing: string[] } | null {
  const data = dataOf(stdout);
  if (!data) return null;
  const found = new Map<string, PrStatus>();
  const missing: string[] = [];
  // the same PR linked twice in different case shares an alias: each link gets its answer
  const repoAt = new Map([...aliases(refs).keys()].map((k, i) => [k, i]));
  for (const r of refs) {
    const repo = data[`r${repoAt.get(`${r.owner}/${r.repo}`.toLowerCase())}`];
    const node = isObject(repo) ? repo[`p${r.number}`] : undefined;
    if (isObject(node)) found.set(r.url, statusOf(node));
    else missing.push(r.url);
  }
  return { found, missing };
}

/** the checks of one PR's last commit, for the panel. only the failed ones are kept */
export function checksQuery(ref: PrRef): string {
  return (
    `query { repository(owner: "${ref.owner}", name: "${ref.repo}") { ` +
    `pullRequest(number: ${ref.number}) { commits(last:1){nodes{commit{statusCheckRollup{state ` +
    "contexts(first:50){nodes{__typename ... on CheckRun{name conclusion detailsUrl} " +
    "... on StatusContext{context state targetUrl}}}}}}} } } }"
  );
}

const FAILED_RUN = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);
const FAILED_STATUS = new Set(["FAILURE", "ERROR"]);

/** null when stdout has no data */
export function parseFailingChecks(stdout: string): FailingCheck[] | null {
  const data = dataOf(stdout);
  if (!data) return null;
  const repo = data.repository;
  const pr = isObject(repo) && isObject(repo.pullRequest) ? repo.pullRequest : undefined;
  const contexts = pr && rollupOf(pr)?.contexts;
  const nodes = isObject(contexts) && Array.isArray(contexts.nodes) ? contexts.nodes : [];
  const out: FailingCheck[] = [];
  for (const n of nodes) {
    if (!isObject(n)) continue;
    const run = typeof n.name === "string" && FAILED_RUN.has(String(n.conclusion));
    const status = typeof n.context === "string" && FAILED_STATUS.has(String(n.state));
    const name = run ? n.name : status ? n.context : undefined;
    if (typeof name !== "string") continue;
    const url = run ? n.detailsUrl : n.targetUrl;
    out.push({ name, ...(typeof url === "string" && url ? { url } : {}) });
  }
  return out;
}

export const PR_STATE_WORD: Record<PrState, string> = {
  ready: "Checks passed",
  failing: "Failing",
  pending: "Checks running",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

export const PR_REVIEW_WORD: Record<PrReview, string> = {
  approved: "approved",
  changes: "changes requested",
  required: "review required",
};

/** at most this many failing checks by name on the panel's second line, then `+N` */
export const CHECKS_SHOWN = 3;

/**
 * the panel's second line, as parts: the state, the review when there is one, the failing checks
 * when it fails (names, at most three, then how many more) and when it last changed
 */
export function prDetail(
  s: PrStatus,
  checks: readonly FailingCheck[] | undefined,
  ago: (at: number) => string,
): { words: string[]; checks: FailingCheck[]; more: number; updated?: string } {
  const failing = s.state === "failing" ? (checks ?? []) : [];
  const done = s.state === "merged" || s.state === "closed";
  return {
    // a merged or closed PR's review is history: the state says all of it
    words: [PR_STATE_WORD[s.state], ...(s.review && !done ? [PR_REVIEW_WORD[s.review]] : [])],
    checks: failing.slice(0, CHECKS_SHOWN),
    more: Math.max(0, failing.length - CHECKS_SHOWN),
    ...(s.updatedAt ? { updated: `updated ${ago(s.updatedAt)}` } : {}),
  };
}
