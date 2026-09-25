// turns a session's real subagents into a committable fixture: every line kept, every piece of
// text replaced.
//   node packages/core/scripts/redact-agents.ts <transcript.jsonl> <name> --agents <id>[,<id>] [--out dir]
//   node packages/core/scripts/redact-agents.ts <transcript.jsonl> <name> --lines <from>:<to> [--agents ...]
//
// with --lines it is the session's own conversation that is kept: every line of that stretch of
// the main transcript (0-based, `to` exclusive), whole. start it on a prompt and end it before one,
// or the fixture begins and ends in the middle of a turn. --agents is optional then.
//
// unlike redact-fixture.ts this keeps WHOLE files - a timeline needs every line, not a head and a
// tail. what it keeps is structure: entry and block types, tool names, timestamps, models, usage,
// error flags. ids are rewritten consistently across the parent, the agents, their metas and the
// workflow journal, so a tool_use still pairs with its tool_result and an agent with the parent's
// Agent call. the same original string always becomes the same filler, so the parent's copy of an
// agent's result still equals the agent's own. long strings are capped: offsets only have to be
// true within the fixture.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const [src, name] = args;
const flag = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const wanted = new Set((flag("--agents") ?? "").split(",").filter(Boolean));
const range = /^(\d+):(\d+)$/.exec(flag("--lines") ?? "");
if (!src || !name || (wanted.size === 0 && !range)) {
  console.error(
    "usage: redact-agents.ts <transcript.jsonl> <name> (--agents <id>[,<id>] | --lines <from>:<to>) [--out dir]",
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
  // what a session's own lines are read by: a system line's kind, who a user line came from, how
  // a queued message was sent, what started a compaction
  "subtype",
  "kind",
  "commandMode",
  "trigger",
  "permissionMode",
  "media_type",
  "level",
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
// a turned-down tool call says who said no, then their words. the words are replaced, the phrase
// that introduces them is not: it is how the person's reply is found.
const PHRASES = ["reason for the rejection:", "the user said:"];
// a command's name and a task's status are what a line is read by, not what anyone wrote
const KEEP_TAG_TEXT = new Set(["command-name", "command-message", "status"]);
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

/** the folders the transcript ran in, longest first. a session can move between repos. */
let realCwds: string[] = [];
const fakeCwd = `/fixture/${name}`;
/** prose and paths that went in, checked against what came out */
const replaced = new Set<string>();
const keptValues = new Set<string>();

let cap = CAP;

/**
 * an envelope Claude Code wraps text in (`<command-name>`, `<local-command-stdout>`,
 * `<task-notification>`...): the tags stay, what is between them is replaced
 */
function redactTagged(value: string): string {
  let open = "";
  return value
    .split(/(<\/?[a-zA-Z][\w-]*>)/)
    .map((part) => {
      const tag = /^<(\/?)([a-zA-Z][\w-]*)>$/.exec(part);
      if (tag) {
        open = tag[1] ? "" : tag[2]!;
        return part;
      }
      if (!part.trim() || KEEP_TAG_TEXT.has(open)) return part;
      if (ids.has(part.trim())) return part.replace(part.trim(), ids.get(part.trim())!);
      replaced.add(part.trim().slice(0, 60));
      return filler(part, Math.min(part.length, cap));
    })
    .join("");
}

function redactString(key: string, value: string, parentType: unknown): string {
  if (ids.has(value)) return ids.get(value)!;
  if (/^\s*<[a-zA-Z][\w-]*>/.test(value) && value.includes("</")) return redactTagged(value);
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
  const realCwd = realCwds.find((c) => value.startsWith(`${c}/`));
  if (realCwd) {
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
    const phrase = PHRASES.find((p) => value.includes(p));
    if (phrase) {
      keptValues.add(phrase);
      const words = value.slice(value.indexOf(phrase) + phrase.length);
      return `${m} ${phrase} ${filler(words, Math.min(words.length, cap))}`;
    }
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
      // a prose key (AskUserQuestion's answers are keyed by the question) is cut like a value
      // made from the same words, so the two still match
      const safeKey = ids.has(k)
        ? ids.get(k)!
        : /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k) && !/^(toolu|srvtoolu|msg|req)_/.test(k)
          ? k
          : filler(k, Math.min(k.length, cap));
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
  "source_uuid",
  "logicalParentUuid",
  "messageId",
  "snapshotMessageId",
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
const found = (wanted.size ? readdirSync(subagents, { recursive: true }) : [])
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
// from the parent: the calls that started these agents, what came back, and any line that names
// one of them (a background agent's completion notice, a workflow's launch result). or, for a
// session's own conversation, every line of the stretch asked for.
const parentLines = readFileSync(src, "utf8").split("\n").filter(Boolean);
// a session's stretch is mostly lines its fold never reads: hook results, token reminders, file
// history, titles written again and again. one in LEAN of each stays, so the fixture still has
// them to skip, and the rest go - they would be most of its bytes.
const LEAN = 25;
const noise = new Map<string, number>();
const stretch = (range ? parentLines.slice(Number(range[1]), Number(range[2])) : []).filter(
  (line) => {
    const row = JSON.parse(line) as { type?: string; attachment?: { type?: string } };
    if (row.type === "user" || row.type === "assistant" || row.type === "system") return true;
    if (row.attachment?.type === "queued_command") return true;
    const kind = `${row.type}:${row.attachment?.type ?? ""}`;
    const n = noise.get(kind) ?? 0;
    noise.set(kind, n + 1);
    return n % LEAN === 0;
  },
);
realCwds = [
  ...new Set(
    [...agents.flatMap((a) => a.lines), ...stretch.map((l) => JSON.parse(l) as unknown)].flatMap(
      (l) => {
        const cwd = (l as { cwd?: unknown }).cwd;
        return typeof cwd === "string" && cwd.length > 1 ? [cwd] : [];
      },
    ),
  ),
].sort((a, b) => b.length - a.length);
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
const kept = (
  range ? stretch : parentLines.filter((line) => [...needles].some((n) => line.includes(n)))
).map((l) => JSON.parse(l) as unknown);
for (const l of kept) collectIds(l);

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
// attachments (hook results, tool listings) are never read by the timeline. every line stays,
// but their strings are cut short - they are most of the bytes.
const redactLine = (row: unknown) => {
  cap = (row as { type?: unknown }).type === "attachment" ? 24 : CAP;
  return JSON.stringify(redact(range ? lean(row) : row));
};

/**
 * a session's lines without what nothing reads and most of the bytes are: the usage breakdown
 * past the four counts, and the wire copy of every tool input (a timeline never reads it)
 */
function lean(row: unknown): unknown {
  const r = row as { message?: { usage?: Record<string, unknown> }; wireToolInputs?: unknown };
  if (!r || typeof r !== "object") return row;
  const { wireToolInputs: _wire, ...rest } = r as Record<string, unknown>;
  const usage = r.message?.usage;
  if (!usage) return rest;
  const keep = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ];
  return {
    ...rest,
    message: {
      ...r.message,
      usage: Object.fromEntries(keep.flatMap((k) => (k in usage ? [[k, usage[k]]] : []))),
    },
  };
}
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
const outDir = path.join(outRoot, outSession);
const everything = (existsSync(outDir) ? readdirSync(outDir, { recursive: true }) : [])
  .map(String)
  .filter((n) => n.endsWith(".json") || n.endsWith(".jsonl"))
  .map((n) => readFileSync(path.join(outDir, n), "utf8"))
  .join("\n")
  .concat(readFileSync(path.join(outRoot, `${outSession}.jsonl`), "utf8"));
for (const real of ids.keys()) {
  if (everything.includes(real)) throw new Error(`leak: id ${real} survived`);
}
for (const needle of [...realCwds, sessionId, path.basename(path.dirname(src))]) {
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
