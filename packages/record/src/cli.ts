// the command line front. the SessionStart hook runs `record state --hook`, agents fall back to
// `record call <tool> '<json>'` through Bash when the MCP tools are missing, and the MCP server
// spawns `record call <tool> -` once the bundle on disk is newer than the one it loaded.
import fs from "node:fs";
import path from "node:path";
import { PROJECT_FILE, paths } from "./format.ts";
import { holderStatus, procStart, registryDir, resolveCaller } from "./identity.ts";
import { serve } from "./mcp.ts";
import { attempt, EXIT, reindex, stateText } from "./ops.ts";
import { sweepTemps } from "./publish.ts";
import { listCardIds, readProject } from "./read.ts";
import { renderCliHelp, renderToolList } from "./render.ts";
import { runTool } from "./tools.ts";
import { BUNDLE_VERSION, FORMAT_VERSION } from "./version.ts";

export interface Io {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** the file this process was started from. */
  entry: string;
  stdin: () => string;
  out: (s: string) => void;
  err: (s: string) => void;
}

/** --root, else $GROVE_RECORD_ROOT, else the nearest folder at or above cwd that holds the project file. */
export function findRoot(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | null {
  if (flag) return path.resolve(cwd, flag);
  if (env.GROVE_RECORD_ROOT) return path.resolve(env.GROVE_RECORD_ROOT);
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, PROJECT_FILE))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

const NO_ROOT =
  "record unavailable: no Grove project found. Pass --root <dir>, or run this inside a project folder (one that holds .claude/grove-project.json)";

/** returns the exit code. never throws. */
export function main(io: Io): number {
  const args = [...io.argv];
  const cmd = args.shift();
  const rootFlag = takeOption(args, "--root");

  if (cmd === "mcp") {
    const root = findRoot(rootFlag, io.env, io.cwd) ?? path.resolve(io.cwd);
    serve({
      root,
      entry: io.entry,
      env: io.env,
      input: process.stdin,
      output: process.stdout,
      exit: (code) => process.exit(code),
    });
    return -1; // the server owns the process from here
  }

  if (cmd === "state") {
    const hook = takeFlag(args, "--hook");
    const all = takeFlag(args, "--all");
    const root = findRoot(rootFlag, io.env, io.cwd);
    // a SessionStart hook gets {"session_id": ...} on stdin. that is the one reliable source there
    let hookSession: string | undefined;
    if (hook) {
      try {
        const j = JSON.parse(io.stdin());
        if (j && typeof j.session_id === "string") hookSession = j.session_id;
      } catch {
        // run by hand, or stdin was empty. the env is used instead
      }
    }
    const r = attempt(() => {
      if (!root) throw new Error(NO_ROOT.replace("record unavailable: ", ""));
      const caller = resolveCaller({ env: io.env, hookSession });
      return { ok: true, text: stateText({ root, caller, env: io.env }, { all }) };
    });
    if (r.ok) {
      io.out(`${r.text}\n`);
      return 0;
    }
    // a hook that prints nothing or fails leaves a session with no state and no notice. one line, exit 0
    const reason = r.text.replace(/^record unavailable: /, "").split(". ")[0];
    if (hook) {
      io.out(`record unavailable: ${reason}. open Grove once\n`);
      return 0;
    }
    io.err(`${r.text}\n`);
    return EXIT.unavailable;
  }

  if (cmd === "call") {
    const name = args.shift();
    const json = args.shift();
    if (!name || args.length) {
      io.err(
        `usage: record call <tool> '<json>' [--root <dir>]. the arguments are one JSON object in one single-quoted argument. \`record tools\` lists the tools.\n`,
      );
      return EXIT.invalid;
    }
    let raw: unknown = {};
    const source = json === "-" ? io.stdin() : json;
    if (source !== undefined && source.trim() !== "") {
      try {
        raw = JSON.parse(source);
      } catch (e) {
        io.err(
          `${name}: the arguments are not valid JSON (${(e as Error).message}). Pass one JSON object in single quotes, like '{"card":"AUTH-3"}'. Write a ' inside it as '\\''.\n`,
        );
        return EXIT.invalid;
      }
    }
    const root = findRoot(rootFlag, io.env, io.cwd);
    if (!root) {
      io.err(`${NO_ROOT}.\n`);
      return EXIT.unavailable;
    }
    const r = runTool(name, raw, { root, env: io.env });
    if (r.ok) {
      io.out(`${r.text}\n`);
      return 0;
    }
    io.err(`${r.text}\n`);
    return EXIT[r.code ?? "unavailable"];
  }

  if (cmd === "tools") {
    io.out(renderToolList());
    return 0;
  }

  if (cmd === "doctor") return doctor(io, findRoot(rootFlag, io.env, io.cwd));

  if (cmd === "version" || cmd === "--version") {
    io.out(`${BUNDLE_VERSION}\n`);
    return 0;
  }

  (cmd === undefined || cmd === "help" || cmd === "--help" ? io.out : io.err)(renderCliHelp());
  return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : EXIT.invalid;
}

/** every line starts with ok, warn or FAIL. exit 0 when nothing failed. */
function doctor(io: Io, root: string | null): number {
  let failed = 0;
  const line = (level: "ok" | "warn" | "FAIL", what: string, detail: string) => {
    if (level === "FAIL") failed++;
    io.out(`${level.padEnd(4)} ${what}: ${detail}\n`);
  };
  line("ok", "bundle", `${io.entry} version ${BUNDLE_VERSION}, format ${FORMAT_VERSION}`);
  line(
    io.env.GROVE_RECORD_BIN ? "ok" : "warn",
    "launcher",
    io.env.GROVE_RECORD_BIN || "not run through the launcher (GROVE_RECORD_BIN is not set)",
  );
  line(
    "ok",
    "runtime",
    `${process.execPath} node ${process.versions.node}${process.versions.electron ? ` electron ${process.versions.electron}` : ""}`,
  );
  if (!root) line("FAIL", "root", "no project found from here. pass --root <dir>");
  else {
    const project = readProject(root);
    if (!project) line("FAIL", "root", `${root} has no ${PROJECT_FILE}. open Grove once`);
    else if (project.problems.length)
      line("FAIL", "root", `${root}: ${project.problems.join(", ")}`);
    else {
      line("ok", "root", `${root} prefix ${project.prefix}, ${listCardIds(root).length} cards`);
      const p = paths(root);
      // the probe goes beside the project file, so doctor never makes an empty cards/ folder
      const probe = path.join(path.dirname(p.project), `.tmp.doctor.${process.pid}`);
      try {
        fs.writeFileSync(probe, "x");
        fs.linkSync(probe, `${probe}.l`);
        line("ok", "filesystem", "hard links work here");
      } catch (e) {
        line(
          "FAIL",
          "filesystem",
          `cannot hard link under ${root} (${(e as NodeJS.ErrnoException).code}). records cannot be published on this volume`,
        );
      } finally {
        for (const f of [probe, `${probe}.l`]) fs.rmSync(f, { force: true });
      }
      const swept = sweepTemps([
        p.cards,
        p.conclusions,
        ...listCardIds(root).flatMap((id) => [p.comments(id), p.claims(id)]),
      ]);
      const indexed = reindex(root);
      line("ok", "upkeep", `${swept} stale temp files removed, ${indexed} index lines added`);
    }
  }
  const c = resolveCaller({ env: io.env });
  if (c.session)
    line(
      "ok",
      "session",
      `${c.session} (from ${c.sessionSource})${c.agent ? ` "${c.agent}"` : ""}`,
    );
  else
    line(
      "warn",
      "session",
      `no Claude session id found (registry ${registryDir(io.env)}, CLAUDE_CODE_SESSION_ID not set). claims need one`,
    );
  if (c.pid)
    line(
      procStart(c.pid) ? "ok" : "warn",
      "process",
      `claude pid ${c.pid} (from ${c.pidSource}) ${procStart(c.pid) ? `started ${procStart(c.pid)}` : "is not running"}`,
    );
  else line("warn", "process", "no claude process id (CLAUDE_PID not set). claims need one");
  const ps = procStart(process.pid);
  line(
    ps ? "ok" : "warn",
    "ps",
    ps
      ? "works"
      : `/bin/ps gave nothing for this process. holders will read as "cannot be checked" (${holderStatus({ session: "x", pid: process.pid, pidStart: "", host: "" }, io.env)})`,
  );
  return failed ? 1 : 0;
}
