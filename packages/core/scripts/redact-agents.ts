// turns a session's real subagents into a committable fixture: every line kept, every piece of
// text replaced.
//   node packages/core/scripts/redact-agents.ts <transcript.jsonl> <name> --agents <id>[,<id>] [--out dir]
//
// unlike redact-fixture.ts this keeps WHOLE files - a timeline needs every line, not a head and a
// tail. what it keeps is structure: entry and block types, tool names, timestamps, models, usage,
// error flags. ids are rewritten consistently across the parent, the agents, their metas and the
// workflow journal, so a tool_use still pairs with its tool_result and an agent with the parent's
// Agent call. the same original string always becomes the same filler, so the parent's copy of an
// agent's result still equals the agent's own. long strings are capped: offsets only have to be
// true within the fixture.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const [src, name] = args;
const flag = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const wanted = new Set((flag("--agents") ?? "").split(",").filter(Boolean));
if (!src || !name || wanted.size === 0) {
  console.error(
    "usage: redact-agents.ts <transcript.jsonl> <name> --agents <id>[,<id>] [--out dir]",
  );
  process.exit(2);
}
const outRoot = flag("--out") ?? path.join(import.meta.dirname, "../test/fixtures/timeline");
const CAP = Number(flag("--cap") ?? 160);

// string values that describe structure, not content
const KEEP_VALUES_FOR_KEYS = new Set([
  "type",
  "role",
  "entrypoint",
  "userType",
  "version",
  "timestamp",
  "model",
  "resolvedModel",
  "advisorModel",
  "stop_reason",
  "effort",
  "perTurnEffort",
  "service_tier",
  "inference_geo",
  "speed",
  "agentType",
  "attributionAgent",
  "requestShape",
  "status",
  "error",
  "taskType",
]);
// kept as the start of a string, because code reads them: they say how a step or an agent ended
const MARKERS = [
  "[Request interrupted by user]",
  "API Error:",
  "<tool_use_error>",
  "The user doesn't want to proceed with this tool use.",
  "The coordinator sent a message while you were working:",
  "[Subagent hand-back]",
];
const WORDS =
  "the agent read a file then ran tests and wrote notes about what changed in each module so the next step could start from there".split(
    " ",
  );

const ids = new Map<string, string>();
let counter = 0;
// every fixture made from another session gets ids of its own, so several can share one tree
const tag = createHash("sha1").update(name).digest("hex").slice(0, 4);

/** same length, same prefix, same dashes. a uuid stays a valid uuid. */
function fakeId(real: string): string {
  const known = ids.get(real);
  if (known) return known;
  counter++;
  let fake: string;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(real)) {
    fake = `${tag}0000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  } else {
    const prefix = /^(srvtoolu_01|toolu_01|msg_01|req_01|wf_a|a)/.exec(real)?.[0] ?? "";
    const body = real.slice(prefix.length);
    const width = body.replace(/-/g, "").length;
    const digits = (tag + counter.toString(16).padStart(Math.max(0, width - 4), "0")).slice(-width);
    let at = 0;
    fake = prefix + [...body].map((c) => (c === "-" ? "-" : digits[at++])).join("");
  }
  ids.set(real, fake);
  return fake;
}

function filler(original: string, len: number): string {
  const h = createHash("sha1").update(original).digest();
  const out: string[] = [];
  let i = 0;
  while (out.join(" ").length < len) out.push(WORDS[h[i++ % h.length]! % WORDS.length]!);
  return out.join(" ").slice(0, len);
}

let realCwd = "";
const fakeCwd = `/fixture/${name}`;
/** prose and paths that went in, checked against what came out */
const replaced = new Set<string>();
const keptValues = new Set<string>();

let cap = CAP;

function redactString(key: string, value: string, parentType: unknown): string {
  if (ids.has(value)) return ids.get(value)!;
  if (KEEP_VALUES_FOR_KEYS.has(key)) {
    keptValues.add(value);
    return value;
  }
  // tool names are the tool api, not content
  if (key === "name" && (parentType === "tool_use" || parentType === "server_tool_use")) {
    keptValues.add(value);
    return value;
  }
  if (key === "cwd") return fakeCwd;
  if (!value) return value;
  if (value.length >= 12 && /[\s/]/.test(value)) replaced.add(value.slice(0, 60));
  const len = Math.min(value.length, key === "signature" || key === "encrypted_content" ? 16 : cap);
  if (realCwd && value.startsWith(`${realCwd}/`)) {
    // a path under the working directory keeps its shape: a target is shown relative to it
    const rest = value.slice(realCwd.length + 1, realCwd.length + 1 + cap);
    const shaped = rest
      .split("/")
      .map((seg) => seg.replace(/[^.]/g, "x"))
      .join("/");
    return `${fakeCwd}/${shaped}`;
  }
  const exit = /^(Error: )?Exit code \d+/.exec(value)?.[0];
  if (exit) return exit + filler(value, Math.max(0, len - exit.length));
  for (const m of MARKERS) {
    if (!value.startsWith(m)) continue;
    keptValues.add(m);
    return m + filler(value, Math.max(0, len - m.length));
  }
  return filler(value, len);
}

function redact(value: unknown, key = "", parentType?: unknown): unknown {
  if (typeof value === "string") return redactString(key, value, parentType);
  if (Array.isArray(value)) return value.map((v) => redact(v, key, parentType));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // wireToolInputs is keyed by tool id, file history by path
      const safeKey = ids.has(k)
        ? ids.get(k)!
        : /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k) && !/^(toolu|srvtoolu|msg|req)_/.test(k)
          ? k
          : filler(k, k.length);
      out[safeKey] = redact(v, k, obj.type);
    }
    return out;
  }
  return value;
}

/** every id-shaped value under a key that holds ids, registered before anything is redacted */
const ID_KEYS = new Set([
  "id",
  "tool_use_id",
  "toolUseId",
  "uuid",
  "parentUuid",
  "promptId",
  "sourceToolAssistantUUID",
  "requestId",
  "agentId",
  "sessionId",
  "session_id",
  "leafUuid",
  "taskId",
  "runId",
]);
function collectIds(value: unknown, key = ""): void {
  if (typeof value === "string") {
    if (ID_KEYS.has(key) && value && !/\s/.test(value)) fakeId(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/^(toolu|srvtoolu)_/.test(k)) fakeId(k);
      collectIds(v, k);
    }
  }
}

const parse = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return null;
      }
    })
    .filter((v) => v !== null);

// the agents, wherever they sit under subagents/
const sessionId = path.basename(src, ".jsonl");
const subagents = path.join(path.dirname(src), sessionId, "subagents");
const found = readdirSync(subagents, { recursive: true })
  .map(String)
  .flatMap((rel) => {
    const m = /(?:^|\/)agent-([^./]+)\.jsonl$/.exec(rel);
    return m && wanted.has(m[1]!) ? [{ id: m[1]!, rel }] : [];
  });
if (found.length !== wanted.size) throw new Error(`found ${found.length} of ${wanted.size} agents`);

fakeId(sessionId);
const agents = found.map(({ id, rel }) => {
  const file = path.join(subagents, rel);
  const metaFile = path.join(path.dirname(file), `agent-${id}.meta.json`);
  const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
  const lines = parse(file);
  const wf = rel.includes("workflows/") ? rel.split("/")[1] : undefined;
  const journal = wf ? parse(path.join(subagents, "workflows", wf, "journal.jsonl")) : [];
  fakeId(id);
  if (wf) fakeId(wf);
  collectIds(meta);
  for (const l of [...lines, ...journal]) collectIds(l);
  return { id, rel, meta, lines, wf, journal };
});
realCwd =
  (agents[0]?.lines.find((l) => (l as { cwd?: unknown }).cwd) as { cwd?: string })?.cwd ?? "";

// from the parent: the calls that started these agents, what came back, and any line that names
// one of them (a background agent's completion notice, a workflow's launch result)
const parentLines = readFileSync(src, "utf8").split("\n").filter(Boolean);
const needles = new Set<string>([
  ...agents.map((a) => a.id),
  ...agents.flatMap((a) => (typeof a.meta.toolUseId === "string" ? [a.meta.toolUseId] : [])),
  ...agents.flatMap((a) => (a.wf ? [a.wf] : [])),
]);
for (const line of parentLines) {
  if (![...needles].some((n) => line.includes(n))) continue;
  // a workflow's launch result names the run. the call it answers is the Workflow tool_use.
  for (const m of line.matchAll(/"tool_use_id":"(toolu_[A-Za-z0-9]+)"/g)) needles.add(m[1]!);
}
const kept = parentLines
  .filter((line) => [...needles].some((n) => line.includes(n)))
  .map((l) => JSON.parse(l) as unknown);
for (const l of kept) collectIds(l);

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
// attachments (hook results, tool listings) are never read by the timeline. every line stays,
// but their strings are cut short - they are most of the bytes.
const redactLine = (row: unknown) => {
  cap = (row as { type?: unknown }).type === "attachment" ? 24 : CAP;
  return JSON.stringify(redact(row));
};
const jsonl = (rows: unknown[]) => `${rows.map(redactLine).join("\n")}\n`;

const outSession = ids.get(sessionId)!;
write(path.join(outRoot, `${outSession}.jsonl`), jsonl(kept));
let bytes = 0;
for (const a of agents) {
  const dir = a.wf
    ? path.join(outRoot, outSession, "subagents", "workflows", ids.get(a.wf)!)
    : path.join(outRoot, outSession, "subagents");
  const fid = ids.get(a.id)!;
  const text = jsonl(a.lines);
  bytes += text.length;
  write(path.join(dir, `agent-${fid}.jsonl`), text);
  write(path.join(dir, `agent-${fid}.meta.json`), JSON.stringify(redact(a.meta)));
  if (a.wf) write(path.join(dir, "journal.jsonl"), jsonl(a.journal));
  console.log(`${a.id} -> ${fid}${a.wf ? ` (workflow ${a.wf} -> ${ids.get(a.wf)})` : ""}`);
}

// nothing real may survive: no id, no path, no piece of prose
const everything = readdirSync(path.join(outRoot, outSession), { recursive: true })
  .map(String)
  .filter((n) => n.endsWith(".json") || n.endsWith(".jsonl"))
  .map((n) => readFileSync(path.join(outRoot, outSession, n), "utf8"))
  .join("\n")
  .concat(readFileSync(path.join(outRoot, `${outSession}.jsonl`), "utf8"));
for (const real of ids.keys()) {
  if (everything.includes(real)) throw new Error(`leak: id ${real} survived`);
}
for (const needle of [realCwd, sessionId, path.basename(path.dirname(src))]) {
  if (needle && everything.includes(needle)) throw new Error(`leak: ${needle} survived`);
}
for (const original of replaced) {
  // a value kept under a structural key may also appear under another one
  if ([...keptValues].some((k) => k.includes(original))) continue;
  if (everything.includes(original)) {
    throw new Error(`leak: ${JSON.stringify(original.slice(0, 40))} survived`);
  }
}
console.log(`${outSession}: ${kept.length} parent lines, ${bytes} bytes of agent transcript`);
