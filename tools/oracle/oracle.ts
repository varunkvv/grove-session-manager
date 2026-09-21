// dev only: `pnpm oracle [--strict] [--verbose]`
// the Agent SDK's listSessions() is the official reader of ~/.claude/projects. we do not depend on
// it at runtime (no cache hooks, huge install), but it is the best available check that our
// parser still agrees with Claude Code after a release.
import { createSessionIndex, getProjectsDir } from "../../packages/core/src/index.ts";

const strict = process.argv.includes("--strict");
const verbose = process.argv.includes("--verbose");

const sdk = await import("@anthropic-ai/claude-agent-sdk").catch(() => null);
if (!sdk || typeof sdk.listSessions !== "function") {
  console.error(
    "install first: (cd tools/oracle && pnpm install --ignore-workspace --no-optional)",
  );
  process.exit(2);
}

const theirs = await sdk.listSessions();
const index = createSessionIndex({ projectsDir: getProjectsDir(), cacheDir: null });
await index.refresh();
const ours = index.list();

const byId = new Map(ours.map((r) => [r.sessionId, r]));
const theirIds = new Set(theirs.map((s) => s.sessionId));

const onlyTheirs = theirs.filter((s) => !byId.has(s.sessionId));
// they hide sessions with no title at all. those are our untitled rows and teleport stubs.
const onlyOurs = ours.filter((r) => !theirIds.has(r.sessionId));
const onlyOursTitled = onlyOurs.filter((r) => r.title && !r.stub);

type Field = "cwd" | "gitBranch" | "customTitle" | "firstPrompt" | "createdAt" | "fileSize";
const fields: Field[] = ["cwd", "gitBranch", "customTitle", "firstPrompt", "createdAt", "fileSize"];
const strictFields = new Set<Field>(["cwd", "customTitle"]);
const mismatches: Record<Field, string[]> = {
  cwd: [],
  gitBranch: [],
  customTitle: [],
  firstPrompt: [],
  createdAt: [],
  fileSize: [],
};
let titleAgree = 0;

const norm = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v);

for (const t of theirs) {
  const o = byId.get(t.sessionId);
  if (!o) continue;
  const mine: Record<Field, unknown> = {
    cwd: o.relocatedCwd ?? o.cwd,
    gitBranch: o.gitBranch,
    // the SDK docs disagree on whether customTitle can hold the generated title. accept either.
    customTitle: o.customTitle ?? o.agentName,
    firstPrompt: o.firstPrompt,
    createdAt: o.createdAt,
    fileSize: o.size,
  };
  for (const f of fields) {
    let theirsV: unknown = norm(t[f]);
    let mineV: unknown = norm(mine[f]);
    if (f === "gitBranch" && (theirsV === "HEAD" || theirsV === ".invalid")) theirsV = undefined;
    if (f === "customTitle" && theirsV !== mineV && theirsV === norm(o.aiTitle)) mineV = theirsV;
    if (f === "firstPrompt" && typeof theirsV === "string" && typeof mineV === "string") {
      // both sides truncate, at different lengths
      const n = Math.min(theirsV.length, mineV.length, 120);
      theirsV = theirsV.slice(0, n).replace(/…$/, "");
      mineV = (mineV as string).slice(0, n).replace(/…$/, "");
      if ((theirsV as string).startsWith((mineV as string).slice(0, 40))) theirsV = mineV;
    }
    if ((theirsV ?? null) !== (mineV ?? null)) {
      mismatches[f].push(
        `${t.sessionId} theirs=${JSON.stringify(theirsV)} ours=${JSON.stringify(mineV)}`,
      );
    }
  }
  if (norm(t.summary) === norm(o.title)) titleAgree++;
}

console.log(
  `theirs: ${theirs.length}  ours: ${ours.length} (${ours.filter((r) => r.stub).length} stubs, ${ours.filter((r) => !r.title).length} untitled)`,
);
console.log(
  `only in theirs: ${onlyTheirs.length}   only in ours with a title: ${onlyOursTitled.length}`,
);
for (const s of onlyTheirs)
  console.log(`  theirs only: ${s.sessionId} ${JSON.stringify(s.summary)}`);
for (const r of onlyOursTitled)
  console.log(`  ours only:   ${r.sessionId} ${JSON.stringify(r.title)} (${r.titleSource})`);
for (const f of fields) {
  console.log(
    `${f.padEnd(12)} ${mismatches[f].length === 0 ? "agree" : `${mismatches[f].length} differ`}`,
  );
  if (verbose || strictFields.has(f)) for (const m of mismatches[f]) console.log(`  ${m}`);
}
console.log(
  `display title equals their summary in ${titleAgree}/${theirs.length} (informational: precedence differs by design - they rank lastPrompt above firstPrompt)`,
);

const failed = onlyTheirs.length > 0 || [...strictFields].some((f) => mismatches[f].length > 0);
if (strict && failed) process.exit(1);
