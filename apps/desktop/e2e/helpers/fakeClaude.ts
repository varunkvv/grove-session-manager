import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * a stand-in for `claude`, pointed at by GROVE_CLAUDE_BIN. it logs every call (argv, cwd, PATH) and
 * plays the supervisor from a JSON file: `agents --json --all` prints it, `stop <id>` takes the
 * worker off the row, and `--bg` adds a row - or refuses, like 2.1.281 does in a folder the CLI
 * has not trusted, while the `untrusted` marker file exists. `-p` is the recap call: it logs the
 * prompt it was sent on stdin and answers from the `recap` file, by the first line of that file's
 * JSON map that the prompt holds. node, not sh: a prompt is typed text, quotes and newlines and
 * all, and the log has to hold it exactly.
 */
export interface FakeClaude {
  bin: string;
  log: string;
  /** what `claude agents --json --all` prints. rewrite it to move the supervisor on. */
  agents: string;
  /** while this file exists, every `--bg` exits 1 with the not-trusted message */
  untrusted: string;
  /** what `claude -p` answers: see `setFakeRecaps`. while it is missing every `-p` exits 1 */
  recap: string;
}

export interface FakeClaudeCall {
  argv: string[];
  cwd: string;
  path: string;
  /** what a `-p` call was sent on stdin */
  input?: string;
}

export const FAKE_SHORT_ID = "abcd1234";

export function writeFakeClaude(dir: string, agents: unknown[] = []): FakeClaude {
  const fake: FakeClaude = {
    bin: path.join(dir, "fake-claude"),
    log: path.join(dir, "claude.log"),
    agents: path.join(dir, "agents.json"),
    untrusted: path.join(dir, "untrusted"),
    recap: path.join(dir, "recap.json"),
  };
  writeFileSync(fake.log, "");
  setFakeAgents(fake, agents);
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const input = args[0] === "-p" ? fs.readFileSync(0, "utf8") : undefined;
fs.appendFileSync(${JSON.stringify(fake.log)}, JSON.stringify({ argv: args, cwd: process.cwd(), path: process.env.PATH || "", input }) + "\\n");
if (input !== undefined) {
  let answers;
  try {
    answers = JSON.parse(fs.readFileSync(${JSON.stringify(fake.recap)}, "utf8"));
  } catch {
    process.stderr.write("Not logged in\\n");
    process.exit(1);
  }
  const hit = answers.find((a) => input.includes(a.when));
  if (!hit) process.exit(1);
  setTimeout(() => {
    process.stdout.write(hit.say);
    process.exit(0);
  }, hit.afterMs || 0);
  return;
}
const file = ${JSON.stringify(fake.agents)};
const rows = () => JSON.parse(fs.readFileSync(file, "utf8"));
if (args[0] === "agents") {
  process.stdout.write(fs.readFileSync(file, "utf8"));
  process.exit(0);
}
if (args[0] === "stop") {
  const next = rows().map((r) => {
    if (r.id !== args[1]) return r;
    const { pid, status, waitingFor, ...rest } = r;
    return { ...rest, state: "stopped" };
  });
  fs.writeFileSync(file, JSON.stringify(next));
  process.exit(0);
}
if (args.includes("--bg")) {
  if (fs.existsSync(${JSON.stringify(fake.untrusted)})) {
    process.stderr.write("Workspace not trusted. Run \`claude\` in " + process.cwd() + " once and accept the trust prompt, then retry.\\n");
    process.exit(1);
  }
  const resume = args.indexOf("--resume");
  const sessionId = resume >= 0 ? args[resume + 1] : "eeeeeeee-0000-4000-8000-00000000000e";
  fs.writeFileSync(file, JSON.stringify([
    ...rows().filter((r) => r.sessionId !== sessionId),
    { pid: 99999, id: ${JSON.stringify(FAKE_SHORT_ID)}, sessionId, cwd: process.cwd(), kind: "background", status: "busy", state: "working", startedAt: Date.now() },
  ]));
  process.stdout.write("backgrounded \\u00b7 ${FAKE_SHORT_ID}\\n");
  process.exit(0);
}
process.exit(0);
`;
  writeFileSync(fake.bin, script);
  chmodSync(fake.bin, 0o755);
  return fake;
}

export interface FakeRecap {
  /** text the prompt holds: a session's title, its last message */
  when: string;
  /** what haiku says back, whole */
  say: string;
  /** how long it takes */
  afterMs?: number;
}

/** what `claude -p` answers from now on. the first entry whose `when` the prompt holds wins */
export function setFakeRecaps(fake: FakeClaude, answers: FakeRecap[]): void {
  writeFileSync(fake.recap, JSON.stringify(answers));
}

/** the four lines, the way haiku sends them */
export const recapSays = (goal: string, done: string, state: string, needs: string): string =>
  `goal: ${goal}\n\ndone: ${done}\n\nstate: ${state}\n\nneeds: ${needs}\n`;

export function setFakeAgents(fake: FakeClaude, agents: unknown[]): void {
  writeFileSync(fake.agents, JSON.stringify(agents));
}

export function fakeClaudeCalls(fake: FakeClaude): FakeClaudeCall[] {
  if (!existsSync(fake.log)) return [];
  return readFileSync(fake.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeClaudeCall);
}

export function setUntrusted(fake: FakeClaude, untrusted: boolean): void {
  if (untrusted) writeFileSync(fake.untrusted, "");
  else rmSync(fake.untrusted, { force: true });
}
