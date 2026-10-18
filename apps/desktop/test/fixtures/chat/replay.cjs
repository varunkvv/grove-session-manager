// claude in stream-json mode, played back from the spike's recordings (the *.jsonl next to this).
// required by a fake claude bin when it is run with `--output-format stream-json`: unit tests and
// e2e drive grove chat's host with it. what it does, by what it reads on stdin:
// - `initialize`: answered at once with the recorded answer
// - a user message: the recorded turn whose prompt it is (else the first one in turn.jsonl) plays
//   out. a recorded `can_use_tool` waits for its answer, a recorded interrupt waits for one
// - any other control request: answered with success
// it also writes the transcript the real claude would, so grove reads the turn back from disk.
// env: GROVE_FAKE_CHAT_LOG (what it got, a JSON line each), GROVE_FAKE_CHAT_DELAY_MS (the most it
// waits between two lines, 15 by default), GROVE_FAKE_CHAT_TOOL_MS (how long a main-thread tool
// runs before its result, 0 by default), GROVE_FAKE_CHAT_RECORDINGS (a folder of recordings to
// play instead of these: the perf script's long answer)
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const args = process.argv.slice(2);
/** `--name value` or `--name=value`: the sdk writes the second */
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
};
const LOG = process.env.GROVE_FAKE_CHAT_LOG;
const DELAY = Number(process.env.GROVE_FAKE_CHAT_DELAY_MS ?? 15);
/** how long a tool of the main thread takes before its result: 0, unless a test wants to see it run */
const TOOL_MS = Number(process.env.GROVE_FAKE_CHAT_TOOL_MS ?? 0);
const note = (o) => LOG && fs.appendFileSync(LOG, `${JSON.stringify(o)}\n`);

const DIR = process.env.GROVE_FAKE_CHAT_RECORDINGS || __dirname;
const recordings = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".jsonl"))
  .sort((a, b) => (a === "turn.jsonl" ? -1 : b === "turn.jsonl" ? 1 : a.localeCompare(b)))
  .map((f) =>
    fs
      .readFileSync(path.join(DIR, f), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.dir),
  );

const recordedIds = new Set();
for (const lines of recordings) {
  for (const l of lines) if (typeof l.msg?.session_id === "string") recordedIds.add(l.msg.session_id);
}
const sessionId = flag("--resume") ?? flag("--session-id") ?? crypto.randomUUID();
const asSession = (o) => {
  let text = JSON.stringify(o);
  for (const id of recordedIds) text = text.split(id).join(sessionId);
  return text;
};

note({
  argv: args,
  cwd: process.cwd(),
  env: {
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    CLAUDECODE: process.env.CLAUDECODE,
    checkpointing: process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING,
  },
});

const isInit = (m) => m?.type === "control_request" && m.request?.subtype === "initialize";
const initAnswer = recordings[0].find(
  (l) => l.dir === "out" && l.msg.type === "control_response" && l.msg.response?.response?.models,
).msg;

/** every recorded prompt and the lines that follow it, up to the next prompt */
const turns = [];
for (const lines of recordings) {
  lines.forEach((l, i) => {
    if (l.dir !== "in" || l.msg.type !== "user") return;
    const text = (l.msg.message.content ?? []).map((c) => c.text ?? "").join("");
    const end = lines.findIndex((x, j) => j > i && x.dir === "in" && x.msg.type === "user");
    turns.push({ text, lines: lines.slice(i + 1, end < 0 ? undefined : end) });
  });
}

// ---------- the transcript, where Claude Code keeps it
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(require("node:os").homedir(), ".claude");
const transcript = path.join(
  configDir,
  "projects",
  process.cwd().replace(/[^a-zA-Z0-9]/g, "-"),
  `${sessionId}.jsonl`,
);
let parentUuid = null;
function record(type, message, extra = {}) {
  const uuid = extra.uuid ?? crypto.randomUUID();
  const line = {
    type,
    parentUuid,
    isSidechain: false,
    userType: "external",
    entrypoint: "sdk-ts",
    cwd: process.cwd(),
    sessionId,
    version: "2.1.296",
    uuid,
    timestamp: new Date().toISOString(),
    message,
    ...extra,
  };
  parentUuid = uuid;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, `${JSON.stringify(line)}\n`);
}

// ---------- a subagent's own transcript and meta, where Claude Code keeps them
const agentsDir = path.join(path.dirname(transcript), sessionId, "subagents");
const agentParents = new Map();
function recordAgent(m) {
  fs.mkdirSync(agentsDir, { recursive: true });
  if (m.type === "system") {
    fs.writeFileSync(
      path.join(agentsDir, `agent-${m.task_id}.meta.json`),
      JSON.stringify({
        agentType: m.subagent_type ?? "general-purpose",
        description: m.description,
        toolUseId: m.tool_use_id,
        spawnDepth: m.spawn_depth ?? 1,
        requestShape: m.is_backgrounded ? "background" : "foreground",
      }),
    );
    m = { type: "user", agent_id: m.task_id, message: { role: "user", content: m.prompt ?? "" } };
  }
  const uuid = m.uuid ?? crypto.randomUUID();
  const line = {
    type: m.type,
    parentUuid: agentParents.get(m.agent_id) ?? null,
    isSidechain: true,
    agentId: m.agent_id,
    userType: "external",
    cwd: process.cwd(),
    sessionId,
    version: "2.1.296",
    uuid,
    timestamp: new Date().toISOString(),
    message: m.message,
  };
  agentParents.set(m.agent_id, uuid);
  fs.appendFileSync(path.join(agentsDir, `agent-${m.agent_id}.jsonl`), `${JSON.stringify(line)}\n`);
}

// ---------- stdout
const out = (msg) => process.stdout.write(`${asSession(msg)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the host's settings controls, answered as claude 2.1.296 does (recordings/c-start.jsonl):
// effort and ultracode live in the flag layer, setModel moves effort to the model's default
const MODELS = initAnswer.response.response.models;
const modelOf = (v) => MODELS.find((m) => m.value === v || m.resolvedModel === v);
const applied = {
  model: modelOf("haiku")?.resolvedModel ?? "claude-haiku-5-5",
  effort: "medium",
  ultracode: false,
  ultracodeRequested: false,
  ultracodeAvailable: true,
};
function settingsControl(r) {
  if (r.subtype === "get_settings") return { effective: {}, sources: [], applied: { ...applied } };
  if (r.subtype === "apply_flag_settings") {
    const s = r.settings ?? {};
    if ("effortLevel" in s) {
      applied.effort = s.effortLevel ?? "medium";
      // a level sent without the ultracode key turns ultracode off
      if (!("ultracode" in s)) applied.ultracode = applied.ultracodeRequested = false;
    }
    if ("ultracode" in s) {
      applied.ultracodeRequested = s.ultracode === true;
      applied.ultracode = applied.ultracodeRequested && applied.ultracodeAvailable;
    }
    return {};
  }
  // the agent goes on in the recording: what it says after a stop is what was recorded
  if (r.subtype === "stop_task") return {};
  if (r.subtype === "set_model") {
    const m = modelOf(r.model);
    const levels = m?.supportedEffortLevels ?? [];
    applied.model = m?.resolvedModel ?? r.model;
    applied.effort = levels.length ? "medium" : null;
    applied.ultracodeAvailable = levels.length > 0;
    applied.ultracode = applied.ultracodeRequested = false;
    return {};
  }
  return undefined;
}

// ---------- stdin: what arrives, and who is waiting for which kind of it
const inbox = [];
let wake = null;
let ended = false;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    note({ in: m });
    if (isInit(m)) {
      out({ ...initAnswer, response: { ...initAnswer.response, request_id: m.request_id } });
      continue;
    }
    const answer = m.type === "control_request" ? settingsControl(m.request) : undefined;
    if (answer !== undefined) {
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: answer } });
      continue;
    }
    inbox.push(m);
    wake?.();
  }
});
process.stdin.on("end", () => {
  ended = true;
  wake?.();
});

/** the next message that `match` takes. control requests nobody waits for are answered on the way */
async function next(match) {
  for (;;) {
    const i = inbox.findIndex(match);
    if (i >= 0) return inbox.splice(i, 1)[0];
    const j = inbox.findIndex((m) => m.type === "control_request");
    if (j >= 0) {
      const [m] = inbox.splice(j, 1);
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
      continue;
    }
    if (ended) return null;
    await new Promise((r) => {
      wake = r;
    });
    wake = null;
  }
}

async function play(turn) {
  let last = null;
  for (const l of turn.lines) {
    if (l.dir === "in") {
      if (l.msg.type === "control_request") {
        // the host decides when: an interrupt, a mode change
        const got = await next((m) => m.type === "control_request" && m.request?.subtype === l.msg.request.subtype);
        if (!got) return;
        const answer = turn.lines.find(
          (x) => x.dir === "out" && x.msg.type === "control_response" && x.msg.response?.request_id === l.msg.request_id,
        );
        out({
          type: "control_response",
          response: { ...(answer?.msg.response ?? { subtype: "success", response: {} }), request_id: got.request_id },
        });
      }
      // a recorded answer to our own control request is waited for at the request
      continue;
    }
    const m = l.msg;
    // answers to the host's requests go out when the request comes in, above
    if (m.type === "control_response") continue;
    if (last !== null) await sleep(Math.min(DELAY, Math.max(0, l.t - last)));
    last = l.t;
    const result = m.type === "user" && !m.parent_tool_use_id && m.message?.content?.[0]?.type === "tool_result";
    if (TOOL_MS && result) await sleep(TOOL_MS);
    if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
      out(m);
      const got = await next((x) => x.type === "control_response" && x.response?.request_id === m.request_id);
      if (!got) return;
      continue;
    }
    if (m.type === "control_request") continue;
    out(m);
    if (m.type === "system" && m.subtype === "task_started" && m.task_type === "local_agent") recordAgent(m);
    if (m.parent_tool_use_id && m.agent_id && (m.type === "assistant" || m.type === "user")) recordAgent(m);
    if (!m.parent_tool_use_id && (m.type === "assistant" || m.type === "user")) {
      record(m.type, m.message, {
        uuid: m.uuid,
        ...(m.tool_use_result !== undefined ? { toolUseResult: m.tool_use_result } : {}),
      });
    }
  }
}

(async () => {
  for (;;) {
    const m = await next((x) => x.type === "user");
    if (!m) break;
    const text = (Array.isArray(m.message.content) ? m.message.content : [{ text: m.message.content }])
      .map((c) => c.text ?? "")
      .join("");
    record("user", m.message);
    await play(turns.find((t) => t.text === text) ?? turns[0]);
  }
  process.exit(0);
})();
