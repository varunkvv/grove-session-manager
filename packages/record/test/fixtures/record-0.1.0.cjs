"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/bin.ts
var import_node_fs7 = __toESM(require("node:fs"), 1);

// src/cli.ts
var import_node_fs6 = __toESM(require("node:fs"), 1);
var import_node_path7 = __toESM(require("node:path"), 1);

// src/format.ts
var import_node_path = __toESM(require("node:path"), 1);

// src/version.ts
var BUNDLE_VERSION = "0.1.0";
var FORMAT_VERSION = 1;
var SERVER_NAME = "grove";

// src/format.ts
var PROJECT_FILE = import_node_path.default.join(".claude", "grove-project.json");
function paths(root) {
  const cards = import_node_path.default.join(root, "cards");
  const conclusions = import_node_path.default.join(root, "conclusions");
  return {
    project: import_node_path.default.join(root, PROJECT_FILE),
    cards,
    cardDir: (id) => import_node_path.default.join(cards, id),
    cardFile: (id) => import_node_path.default.join(cards, id, "card.md"),
    comments: (id) => import_node_path.default.join(cards, id, "comments"),
    claims: (id) => import_node_path.default.join(cards, id, "claims"),
    conclusions,
    index: import_node_path.default.join(conclusions, "INDEX.md")
  };
}
var CARD_ID = /^(?![DFV]-)[A-Z][A-Z0-9]{0,7}-[1-9][0-9]*$/;
var CONCLUSION_ID = /^[DFV]-[1-9][0-9]*$/;
var PREFIX = /^[A-Z][A-Z0-9]{0,7}$/;
var KIND_LETTER = { decision: "D", finding: "F", verdict: "V" };
var LETTER_KIND = { D: "decision", F: "finding", V: "verdict" };
function normId(raw) {
  return raw.trim().toUpperCase();
}
function idNumber(id) {
  const m = /-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}
function pad4(n) {
  return String(n).padStart(4, "0");
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function oneLine(s) {
  return s.replace(/\s+/g, " ").trim();
}
function cut(s, max) {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join("") + "\u2026";
}
function cutBytes(s, maxBytes) {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (used + b > maxBytes - 3) break;
    out += ch;
    used += b;
  }
  return out + "\u2026";
}
function shortTime(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : "?";
}
function bare(s) {
  return { bare: s };
}
function renderRecord(fields, body = "") {
  const lines = ["---", `v: ${FORMAT_VERSION}`];
  for (const [key, value] of fields) {
    if (value === void 0) continue;
    if (typeof value === "string") lines.push(`${key}: ${JSON.stringify(value)}`);
    else if (typeof value === "number" || typeof value === "boolean") lines.push(`${key}: ${value}`);
    else if (Array.isArray(value)) lines.push(`${key}: ${JSON.stringify(value)}`);
    else lines.push(`${key}: ${value.bare}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n" + body + "\n";
}
function parseScalar(raw) {
  const v = raw.trim();
  if (v === "") return "";
  if (v[0] === '"') {
    try {
      return JSON.parse(v);
    } catch {
      const end = v.lastIndexOf('"');
      return v.slice(1, end > 0 ? end : void 0).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  if (v[0] === "'") {
    const end = v.lastIndexOf("'");
    return v.slice(1, end > 0 ? end : void 0).replace(/''/g, "'");
  }
  if (v[0] === "[" || v[0] === "{") {
    try {
      return JSON.parse(v);
    } catch {
      if (v[0] === "[") {
        return v.replace(/^\[|\]$/g, "").split(",").map((s) => String(parseScalar(s))).filter((s) => s !== "");
      }
      return v;
    }
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v) && v.length < 16) return Number(v);
  return v;
}
function parseRecord(textIn) {
  const problems = [];
  const fields = {};
  const text = String(textIn ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { fields, body: text.replace(/\n$/, ""), problems: ["no frontmatter"] };
  }
  let i = 1;
  let closed = false;
  let listKey = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      closed = true;
      i++;
      break;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      fields[listKey].push(parseScalar(item[1]));
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*)|\s*)$/.exec(line);
    if (!m) {
      problems.push(`line ${i + 1} is not "key: value"`);
      listKey = null;
      continue;
    }
    const key = m[1];
    if (key in fields) {
      problems.push(`"${key}" is there twice, the first one counts`);
      listKey = null;
      continue;
    }
    if (m[2] === void 0 || m[2].trim() === "") {
      const next = lines[i + 1];
      if (next !== void 0 && /^\s+-\s+/.test(next)) {
        fields[key] = [];
        listKey = key;
      } else {
        fields[key] = "";
        listKey = null;
      }
      continue;
    }
    listKey = null;
    fields[key] = parseScalar(m[2]);
  }
  if (!closed) problems.push("frontmatter is not closed");
  const v = fields.v;
  if (typeof v === "number" && v > FORMAT_VERSION) problems.push(`written with format ${v}, this reader knows ${FORMAT_VERSION}`);
  const body = closed ? lines.slice(i).join("\n").replace(/\n$/, "") : "";
  return { fields, body, problems };
}
function str(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return 0;
}
function bool(v) {
  return v === true || v === "true" || v === "yes";
}
function strList(v) {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter((s2) => s2 !== "");
  const s = str(v).trim();
  if (!s) return [];
  return s.split(/[\s,]+/).filter(Boolean);
}
function isIso(s) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) && !Number.isNaN(Date.parse(s));
}

// src/identity.ts
var import_node_child_process = require("node:child_process");
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path3 = __toESM(require("node:path"), 1);

// src/publish.ts
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
var tmpSeq = 0;
var HOST = import_node_os.default.hostname().split(".")[0] || "unknown";
function hostName() {
  return HOST;
}
function highest(dir, re, counts) {
  let names;
  try {
    names = import_node_fs.default.readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return 0;
    throw e;
  }
  const nums = [];
  for (const name of names) {
    const m = re.exec(name);
    if (m) nums.push([Number(m[1]), name]);
  }
  if (!counts) return nums.reduce((max, [n]) => n > max ? n : max, 0);
  nums.sort((a, b) => b[0] - a[0]);
  for (const [n, name] of nums) if (counts(name)) return n;
  return 0;
}
function publishNext(tmpDir, next, finalFor, contentFor) {
  import_node_fs.default.mkdirSync(tmpDir, { recursive: true });
  const tmp = import_node_path2.default.join(tmpDir, `.tmp.${HOST}.${process.pid}.${tmpSeq++}`);
  try {
    for (let attempts = 1; attempts <= 500; attempts++) {
      const n = next();
      const file = finalFor(n);
      import_node_fs.default.mkdirSync(import_node_path2.default.dirname(file), { recursive: true });
      import_node_fs.default.writeFileSync(tmp, contentFor(n));
      try {
        import_node_fs.default.linkSync(tmp, file);
        return { n, file, attempts };
      } catch (e) {
        const code2 = e.code;
        if (code2 === "EEXIST") continue;
        throw new Error(`cannot create ${file} (${code2}). the name is free, so this is permissions, disk space or a filesystem without hard links`);
      }
    }
    throw new Error("gave up after 500 attempts to get the next number");
  } finally {
    try {
      import_node_fs.default.unlinkSync(tmp);
    } catch {
    }
  }
}
function publishAt(file, content) {
  const dir = import_node_path2.default.dirname(file);
  import_node_fs.default.mkdirSync(dir, { recursive: true });
  const tmp = import_node_path2.default.join(dir, `.tmp.${HOST}.${process.pid}.${tmpSeq++}`);
  try {
    import_node_fs.default.writeFileSync(tmp, content);
    try {
      import_node_fs.default.linkSync(tmp, file);
      return true;
    } catch (e) {
      const code2 = e.code;
      if (code2 === "EEXIST") return false;
      throw new Error(`cannot create ${file} (${code2}). the name is free, so this is permissions, disk space or a filesystem without hard links`);
    }
  } finally {
    try {
      import_node_fs.default.unlinkSync(tmp);
    } catch {
    }
  }
}
function appendLine(file, line) {
  import_node_fs.default.mkdirSync(import_node_path2.default.dirname(file), { recursive: true });
  import_node_fs.default.appendFileSync(file, line.endsWith("\n") ? line : line + "\n");
}
function sweepTemps(dirs, olderThanMs = 36e5) {
  let removed = 0;
  const cutoff = Date.now() - olderThanMs;
  for (const dir of dirs) {
    let names;
    try {
      names = import_node_fs.default.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(".tmp.")) continue;
      const file = import_node_path2.default.join(dir, name);
      try {
        if (import_node_fs.default.statSync(file).mtimeMs < cutoff) {
          import_node_fs.default.unlinkSync(file);
          removed++;
        }
      } catch {
      }
    }
  }
  return removed;
}

// src/identity.ts
function registryDir(env) {
  return env.GROVE_RECORD_REGISTRY || import_node_path3.default.join(env.CLAUDE_CONFIG_DIR || import_node_path3.default.join(env.HOME || import_node_os2.default.homedir(), ".claude"), "sessions");
}
function readRegistryEntry(dir, pid) {
  try {
    const j = JSON.parse(import_node_fs2.default.readFileSync(import_node_path3.default.join(dir, `${pid}.json`), "utf8"));
    if (!j || typeof j.sessionId !== "string" || !j.sessionId) return null;
    return { pid, sessionId: j.sessionId, name: typeof j.name === "string" ? j.name : "" };
  } catch {
    return null;
  }
}
function findRegistryBySession(dir, session) {
  let names = [];
  try {
    names = import_node_fs2.default.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = /^([1-9]\d*)\.json$/.exec(name);
    if (!m) continue;
    const entry = readRegistryEntry(dir, Number(m[1]));
    if (entry?.sessionId === session) return entry;
  }
  return null;
}
function toPid(v) {
  return v && /^[1-9]\d*$/.test(v) ? Number(v) : null;
}
function resolveCaller(input) {
  const env = input.env;
  const host = hostName();
  const sub = input.as?.trim() || void 0;
  if (input.person || env.GROVE_RECORD_ACTOR === "person") {
    return { actor: "person", session: "person", sessionSource: "person", pid: null, pidSource: "none", agent: "", sub, toolUseId: input.toolUseId, host };
  }
  let pid = null;
  let pidSource = "none";
  const over = toPid(env.GROVE_RECORD_PID);
  const claudePid = toPid(env.CLAUDE_PID);
  if (over) [pid, pidSource] = [over, "override"];
  else if (claudePid) [pid, pidSource] = [claudePid, "CLAUDE_PID"];
  else if (input.ppid && input.ppid > 1) [pid, pidSource] = [input.ppid, "ppid"];
  const reg = pid ? readRegistryEntry(registryDir(env), pid) : null;
  let session = "";
  let sessionSource = "none";
  if (env.GROVE_RECORD_SESSION) [session, sessionSource] = [env.GROVE_RECORD_SESSION, "override"];
  else if (reg) [session, sessionSource] = [reg.sessionId, "registry"];
  else if (input.hookSession) [session, sessionSource] = [input.hookSession, "hook"];
  else if (env.CLAUDE_CODE_SESSION_ID) [session, sessionSource] = [env.CLAUDE_CODE_SESSION_ID, "env"];
  if (!/^[A-Za-z0-9._@-]*$/.test(session)) [session, sessionSource] = ["", "none"];
  const named = reg?.name || (session && !reg && !env.GROVE_RECORD_AGENT ? findRegistryBySession(registryDir(env), session)?.name : "");
  const agent = env.GROVE_RECORD_AGENT || named || (session ? session.slice(0, 8) : "");
  return { actor: "agent", session, sessionSource, pid, pidSource, agent, sub, toolUseId: input.toolUseId || env.GROVE_RECORD_TOOL_USE_ID || void 0, host };
}
function procStart(pid) {
  try {
    return (0, import_node_child_process.execFileSync)("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      env: { LC_ALL: "C", TZ: "UTC0", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3
    }).trim();
  } catch {
    return "";
  }
}
function holderStatus(holder, env) {
  if (holder.host !== hostName()) return "unknown";
  if (!procStart(process.pid)) return "unknown";
  const dir = registryDir(env);
  let names = [];
  try {
    names = import_node_fs2.default.readdirSync(dir);
  } catch {
  }
  for (const name of names) {
    const m = /^([1-9]\d*)\.json$/.exec(name);
    if (!m) continue;
    const entry = readRegistryEntry(dir, Number(m[1]));
    if (entry?.sessionId === holder.session && procStart(entry.pid)) return "alive";
  }
  if (!holder.pid) return "unknown";
  const started = procStart(holder.pid);
  if (!started) return "dead";
  if (holder.pidStart && started !== holder.pidStart) return "dead";
  const now = readRegistryEntry(dir, holder.pid);
  if (now && now.sessionId !== holder.session) return "dead";
  return "alive";
}

// src/mcp.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs5 = __toESM(require("node:fs"), 1);
var import_node_path6 = __toESM(require("node:path"), 1);

// src/ops.ts
var import_node_fs4 = __toESM(require("node:fs"), 1);
var import_node_path5 = __toESM(require("node:path"), 1);

// src/read.ts
var import_node_fs3 = __toESM(require("node:fs"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);
function readText(file) {
  try {
    return import_node_fs3.default.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function mtimeIso(file) {
  try {
    return import_node_fs3.default.statSync(file).mtime.toISOString();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}
function author(f, file, problems) {
  let at = str(f.at);
  if (!isIso(at)) {
    problems.push(at ? `"at" is not a time: ${at}` : `no "at"`);
    at = mtimeIso(file);
  }
  const session = str(f.session);
  const by = str(f.by) === "person" || !f.by && session === "person" ? "person" : "agent";
  return { by, session, agent: str(f.agent), sub: str(f.sub) || void 0, toolUseId: str(f.tool_use_id) || void 0, at };
}
function artifacts(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const a of v) {
    if (a && typeof a === "object" && typeof a.ref === "string") {
      const t = a.type;
      out.push({ type: t === "file" || t === "branch" || t === "pr" || t === "link" ? t : "link", ref: a.ref });
    } else if (typeof a === "string" && a) out.push({ type: "link", ref: a });
  }
  return out;
}
function readProject(root) {
  const text = readText(paths(root).project);
  if (text === null) return null;
  const problems = [];
  let j = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed;
    else problems.push("not a JSON object");
  } catch {
    problems.push("not valid JSON");
  }
  const prefix = str(j.prefix).toUpperCase();
  if (!prefix) problems.push("no prefix");
  return { v: num(j.v) || 1, name: str(j.name), prefix, goal: str(j.goal), rev: num(j.rev), problems };
}
function numbered(dir) {
  let names;
  try {
    names = import_node_fs3.default.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = /^(\d+)\.md$/.exec(name);
    if (m) out.push([Number(m[1]), import_node_path4.default.join(dir, name)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
function listCardIds(root) {
  const p = paths(root);
  let names;
  try {
    names = import_node_fs3.default.readdirSync(p.cards);
  } catch {
    return [];
  }
  return names.filter((n) => CARD_ID.test(n) && import_node_fs3.default.existsSync(p.cardFile(n))).sort((a, b) => a.split("-")[0] === b.split("-")[0] ? idNumber(a) - idNumber(b) : a < b ? -1 : 1);
}
function parseClaim(card2, seq, file) {
  const parsed = parseRecord(readText(file) ?? "");
  const f = parsed.fields;
  const problems = [...parsed.problems];
  if (f.seq !== void 0 && num(f.seq) !== seq) problems.push(`"seq" says ${str(f.seq)}, the file name says ${seq}`);
  const pid = num(f.pid);
  return {
    ...author(f, file, problems),
    card: card2,
    seq,
    event: str(f.event),
    pid: pid > 0 ? pid : null,
    pidStart: str(f.pid_start),
    host: str(f.host),
    via: str(f.via),
    prev: num(f.prev),
    prevSession: str(f.prev_session),
    note: str(f.note),
    body: parsed.body,
    artifacts: artifacts(f.artifacts),
    file,
    problems
  };
}
function readClaims(root, card2) {
  return numbered(paths(root).claims(card2)).map(([seq, file]) => parseClaim(card2, seq, file));
}
function lastClaim(root, card2) {
  const all = numbered(paths(root).claims(card2));
  const top = all[all.length - 1];
  return top ? parseClaim(card2, top[0], top[1]) : null;
}
function isHeld(e) {
  return !!e && (e.event === "claim" || e.event === "takeover");
}
function deriveStatus(claims) {
  let status = "todo";
  let holder = null;
  for (const e of claims) {
    if (e.event === "claim" || e.event === "takeover") {
      const before = holder;
      const since = before && before.session === e.session ? before.since : e.at;
      holder = { session: e.session, agent: e.agent, pid: e.pid, pidStart: e.pidStart, host: e.host, since };
      status = "in_progress";
    } else if (e.event === "release") {
      holder = null;
      status = "todo";
    } else if (e.event === "done") {
      status = "done";
      holder = null;
    } else if (e.event === "cancel") {
      status = "canceled";
      holder = null;
    }
  }
  return { status, holder };
}
function readComments(root, card2) {
  return numbered(paths(root).comments(card2)).map(([seq, file]) => {
    const parsed = parseRecord(readText(file) ?? "");
    const f = parsed.fields;
    const problems = [...parsed.problems];
    const kindRaw = str(f.kind);
    const kind = kindRaw === "question" || kindRaw === "answer" ? kindRaw : "comment";
    const c = { ...author(f, file, problems), card: card2, seq, kind, text: parsed.body, artifacts: artifacts(f.artifacts), file, problems };
    if (kind === "question") c.to = str(f.to) || "person";
    if (kind === "answer") c.answers = num(f.answers) || void 0;
    return c;
  });
}
function questionsOf(comments) {
  const answers = /* @__PURE__ */ new Map();
  for (const c of comments) {
    if (c.kind === "answer" && c.answers) answers.set(c.answers, [...answers.get(c.answers) ?? [], c.seq]);
  }
  return comments.filter((c) => c.kind === "question").map((c) => {
    const answeredBy = answers.get(c.seq) ?? [];
    return { ...c, kind: "question", to: c.to ?? "person", open: answeredBy.length === 0, answeredBy };
  });
}
function readCard(root, id) {
  const p = paths(root);
  const file = p.cardFile(id);
  const text = readText(file);
  if (text === null) return null;
  const parsed = parseRecord(text);
  const f = parsed.fields;
  const problems = [...parsed.problems];
  if (f.id !== void 0 && str(f.id).toUpperCase() !== id) problems.push(`"id" says ${str(f.id)}, the folder says ${id}`);
  const claims = readClaims(root, id);
  const comments = readComments(root, id);
  const questions = questionsOf(comments);
  const who2 = author(f, file, problems);
  let lastActivity = who2.at;
  for (const x of [...claims, ...comments]) if (x.at > lastActivity) lastActivity = x.at;
  return {
    ...who2,
    id,
    title: str(f.title) || "(no title)",
    body: parsed.body,
    from: str(f.from).toUpperCase() || void 0,
    needs: strList(f.needs).map((s) => s.toUpperCase()),
    file,
    problems,
    ...deriveStatus(claims),
    claims,
    comments,
    questions,
    asksPerson: questions.some((q) => q.open && q.to === "person"),
    lastActivity
  };
}
function readCards(root) {
  const out = [];
  for (const id of listCardIds(root)) {
    const c = readCard(root, id);
    if (c) out.push(c);
  }
  return out;
}
function conclusionFiles(root) {
  const dir = paths(root).conclusions;
  let names;
  try {
    names = import_node_fs3.default.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".md") && CONCLUSION_ID.test(n.slice(0, -3))).map((n) => n.slice(0, -3));
}
function listConclusionIds(root) {
  return conclusionFiles(root);
}
function parseConclusion(root, id) {
  const file = import_node_path4.default.join(paths(root).conclusions, `${id}.md`);
  const text = readText(file);
  if (text === null) return null;
  const parsed = parseRecord(text);
  const f = parsed.fields;
  const problems = [...parsed.problems];
  const kind = LETTER_KIND[id[0]];
  if (f.kind !== void 0 && str(f.kind) !== kind) problems.push(`"kind" says ${str(f.kind)}, the id says ${kind}`);
  const what = str(f.what) || parsed.body.split("\n")[0] || "(nothing written)";
  return {
    ...author(f, file, problems),
    id,
    kind,
    what,
    why: str(f.why),
    card: str(f.card).toUpperCase() || void 0,
    replaces: str(f.replaces).toUpperCase() || void 0,
    related: strList(f.related).map((s) => s.toUpperCase()),
    changesPlan: bool(f.changes_plan),
    area: str(f.area) || void 0,
    file,
    problems,
    replacedBy: [],
    superseded: false
  };
}
function readConclusions(root) {
  const all = [];
  for (const id of conclusionFiles(root)) {
    const c = parseConclusion(root, id);
    if (c) all.push(c);
  }
  markSuperseded(all);
  return all.sort((a, b) => a.at === b.at ? idNumber(b.id) - idNumber(a.id) : a.at < b.at ? 1 : -1);
}
function markSuperseded(all) {
  const byId = new Map(all.map((c) => [c.id, c]));
  const oldestFirst = [...all].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  for (const c of oldestFirst) {
    const target = c.replaces ? byId.get(c.replaces) : void 0;
    if (target && target !== c) {
      target.replacedBy.push(c.id);
      target.superseded = true;
    }
  }
}
function readIndex(root) {
  const text = readText(paths(root).index) ?? "";
  const seen = /* @__PURE__ */ new Map();
  for (const line of text.split("\n")) {
    const parts = line.split(" | ");
    if (parts.length < 7) continue;
    const id = parts[0].trim();
    if (!CONCLUSION_ID.test(id) || seen.has(id)) continue;
    const dash = (s) => s.trim() === "-" ? void 0 : s.trim();
    seen.set(id, {
      id,
      kind: LETTER_KIND[id[0]],
      at: parts[2].trim(),
      card: dash(parts[3]),
      by: parts[4].trim() === "person" ? "person" : "agent",
      replaces: dash(parts[5]),
      what: parts.slice(6).join(" | "),
      replacedBy: [],
      superseded: false
    });
  }
  for (const id of conclusionFiles(root)) {
    if (seen.has(id)) continue;
    const c = parseConclusion(root, id);
    if (c) seen.set(id, { id, kind: c.kind, at: c.at, card: c.card, by: c.by, replaces: c.replaces, what: c.what, replacedBy: [], superseded: false });
  }
  const onDisk = new Set(conclusionFiles(root));
  const all = [...seen.values()].filter((l) => onDisk.has(l.id));
  markSuperseded(all);
  return all.sort((a, b) => a.at === b.at ? idNumber(b.id) - idNumber(a.id) : a.at < b.at ? 1 : -1);
}
function revisionOf(project, cards, conclusionCount) {
  let n = (project?.rev ?? 0) + conclusionCount;
  for (const c of cards) n += 1 + c.comments.length + c.claims.length;
  return n;
}

// src/ops.ts
var EXIT = { invalid: 1, not_found: 2, held: 3, holder_gone: 4, not_holder: 5, closed: 6, refused: 7, unavailable: 8 };
var Fail = class extends Error {
  code;
  constructor(code2, text) {
    super(text);
    this.code = code2;
  }
};
var ok = (text) => ({ ok: true, text });
var fail = (code2, text) => {
  throw new Fail(code2, text);
};
function attempt(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Fail) return { ok: false, code: e.code, text: e.message };
    return { ok: false, code: "unavailable", text: `record unavailable: ${e.message}. Nothing was written by this call unless the text says so. Call record_state to check before you retry.` };
  }
}
function needProject(ctx) {
  const project = readProject(ctx.root);
  if (!project) {
    return fail("unavailable", `record unavailable: ${paths(ctx.root).project} is missing, so ${ctx.root} is not set up as a Grove project. Tell the person to open Grove once. Do not create record files by hand.`);
  }
  if (!PREFIX.test(project.prefix)) {
    return fail("unavailable", `record unavailable: ${paths(ctx.root).project} has no usable card prefix (${project.problems.join(", ") || `"${project.prefix}"`}). Tell the person to open Grove once.`);
  }
  return project;
}
function needCard(ctx, raw) {
  const id = normId(raw);
  if (!CARD_ID.test(id)) fail("not_found", `"${raw}" is not a card id. A card id looks like ${needProject(ctx).prefix}-3. Call record_state to see the cards.`);
  if (!import_node_fs4.default.existsSync(paths(ctx.root).cardFile(id))) fail("not_found", `There is no card ${id}. Call record_state to see the cards.`);
  return id;
}
function needConclusion(ctx, raw, what) {
  const id = normId(raw);
  if (!CONCLUSION_ID.test(id)) fail("not_found", `${what} "${raw}" is not a conclusion id. Conclusion ids look like D-4, F-2 or V-7.`);
  if (!import_node_fs4.default.existsSync(import_node_path5.default.join(paths(ctx.root).conclusions, `${id}.md`))) fail("not_found", `${what} ${id} does not exist. Call conclusion_search to find the right id.`);
  return id;
}
function authorFields(c, by) {
  return [
    ["by", bare(by ?? (c.actor === "person" ? "person" : "agent"))],
    ["session", bare(c.session || "unknown")],
    ["agent", c.agent || void 0],
    ["sub", c.sub],
    ["at", bare(nowIso())],
    ["tool_use_id", c.toolUseId ? bare(c.toolUseId) : void 0]
  ];
}
function who(e) {
  if (e.session === "person") return "the person";
  const name = e.agent || e.session.slice(0, 8) || "an unknown agent";
  return e.sub ? `${name} (${e.sub})` : name;
}
function holderName(e) {
  return `${e.agent || "an agent"} (session ${e.session.slice(0, 8)})`;
}
function cardCreate(ctx, a) {
  const project = needProject(ctx);
  const p = paths(ctx.root);
  const from = a.from ? needCard(ctx, a.from) : void 0;
  const needs = (a.needs ?? []).map((n) => needCard(ctx, n));
  const re = new RegExp(`^${project.prefix}-([1-9][0-9]*)$`);
  const fields = (id2) => [
    ["id", bare(id2)],
    ["title", oneLine(a.title)],
    ...authorFields(ctx.caller),
    ["from", from ? bare(from) : void 0],
    ["needs", needs.length ? needs : void 0]
  ];
  const made = publishNext(
    p.cards,
    () => highest(p.cards, re, (name) => import_node_fs4.default.existsSync(p.cardFile(name))) + 1,
    (n) => p.cardFile(`${project.prefix}-${n}`),
    (n) => renderRecord(fields(`${project.prefix}-${n}`), a.body ?? "")
  );
  const id = `${project.prefix}-${made.n}`;
  return ok(`${id} created: "${cut(oneLine(a.title), 80)}". It is todo and nobody holds it. To work on it yourself, call card_claim with card "${id}".`);
}
function strongIdentity(ctx, verb) {
  const c = ctx.caller;
  if (c.actor === "person") return fail("invalid", `The person does not hold cards, so the person cannot ${verb} one. An agent does that from its own session.`);
  if (!c.session || !c.pid) {
    return fail("unavailable", `record unavailable: cannot tell which Claude session is calling (session: ${c.sessionSource}, process: ${c.pidSource}). A claim needs both. Call this through the mcp__grove__* tools or from the Bash tool of a Claude session.`);
  }
  return { pid: c.pid, start: procStart(c.pid) };
}
function writeClaim(ctx, card2, last, event, me, note, body = "", artifacts2) {
  const c = ctx.caller;
  const seq = (last?.seq ?? 0) + 1;
  const content = renderRecord(
    [
      ["card", bare(card2)],
      ["seq", seq],
      ["event", bare(event)],
      ...authorFields(c),
      ["pid", me.pid ?? void 0],
      ["pid_start", me.pid ? me.start : void 0],
      ["host", bare(c.host)],
      ["via", bare(`${c.sessionSource}/${c.pidSource}`)],
      ["prev", last?.seq ?? 0],
      ["prev_session", last ? bare(last.session || "unknown") : void 0],
      ["note", note || void 0],
      ["artifacts", artifacts2?.length ? artifacts2 : void 0]
    ],
    body
  );
  return publishAt(import_node_path5.default.join(paths(ctx.root).claims(card2), `${pad4(seq)}.md`), content);
}
function liveness(ctx, e) {
  return holderStatus({ session: e.session, pid: e.pid, pidStart: e.pidStart, host: e.host }, ctx.env);
}
var LIVE_WORDS = { alive: "is running", dead: "is not running", unknown: "cannot be checked from here" };
function closedText(card2, e) {
  const word = e.event === "done" ? "done" : "canceled";
  return `${card2} is ${word}. A ${word} card stays ${word}. If there is more to do, create a new card with card_create and from "${card2}".`;
}
var isClosed = (e) => !!e && (e.event === "done" || e.event === "cancel");
function cardClaim(ctx, a) {
  needProject(ctx);
  const card2 = needCard(ctx, a.card);
  const me = strongIdentity(ctx, "claim");
  for (let tries = 0; tries < 200; tries++) {
    const last = lastClaim(ctx.root, card2);
    if (isClosed(last)) fail("closed", closedText(card2, last));
    if (isHeld(last)) {
      if (last.session === ctx.caller.session) {
        if (last.pid === me.pid && last.pidStart === me.start) return ok(`${card2} is already yours.`);
        if (writeClaim(ctx, card2, last, "claim", me, "same session, new process")) return ok(`${card2} is yours. The claim was refreshed, because this session now runs in a new process.`);
        continue;
      }
      const st = liveness(ctx, last);
      if (st === "dead") {
        fail("holder_gone", `${card2} is held by ${holderName(last)}, whose process is not running. That is normal for a closed VS Code tab and does not mean the card is free. Do not work on it. Ask the person whether you should take it over. If they say yes, call card_takeover with card "${card2}".`);
      }
      fail("held", `${card2} is held by ${holderName(last)}, which ${LIVE_WORDS[st]}. Do not work on it. Pick another card, or leave that agent a question with question_ask (to "${card2}").`);
    }
    if (writeClaim(ctx, card2, last, "claim", me, "")) return ok(`${card2} claimed. It is yours until you call card_done, card_release or card_cancel. Read it with card_show before you start.`);
  }
  return fail("unavailable", `record unavailable: could not settle the claim on ${card2} after 200 tries. Call card_show with card "${card2}" to see who holds it.`);
}
function cardRelease(ctx, a) {
  needProject(ctx);
  const card2 = needCard(ctx, a.card);
  const person = ctx.caller.actor === "person";
  const me = person ? { pid: null, start: "" } : strongIdentity(ctx, "release");
  for (let tries = 0; tries < 200; tries++) {
    const last = lastClaim(ctx.root, card2);
    if (isClosed(last)) fail("closed", closedText(card2, last));
    if (!isHeld(last)) fail("not_holder", `${card2} is not claimed, so there is nothing to release.`);
    const mine = last.session === ctx.caller.session;
    if (!mine && !person) fail("not_holder", `You do not hold ${card2}. ${holderName(last)} does. Only its holder or the person can release it.`);
    const note = mine ? "" : `released by the person. it was held by ${last.agent || last.session}`;
    if (writeClaim(ctx, card2, last, "release", me, note, a.note ?? "")) return ok(`${card2} released. It is todo again and anyone can claim it.`);
  }
  return fail("unavailable", `record unavailable: could not release ${card2} after 200 tries. Call card_show with card "${card2}".`);
}
function cardTakeover(ctx, a) {
  needProject(ctx);
  const card2 = needCard(ctx, a.card);
  const me = strongIdentity(ctx, "take over");
  for (let tries = 0; tries < 200; tries++) {
    const last = lastClaim(ctx.root, card2);
    if (isClosed(last)) fail("closed", closedText(card2, last));
    if (!isHeld(last)) {
      if (writeClaim(ctx, card2, last, "claim", me, "")) return ok(`${card2} claimed. Nobody held it, so nothing was taken over.`);
      continue;
    }
    if (last.session === ctx.caller.session) return ok(`${card2} is already yours.`);
    const st = liveness(ctx, last);
    if (st === "dead") {
      if (writeClaim(ctx, card2, last, "takeover", me, `holder process ${last.pid ?? "?"} was gone`)) return ok(`${card2} taken over from ${holderName(last)}. It is yours now. Read it with card_show before you carry on, its thread says where they stopped.`);
      continue;
    }
    if (a.force) {
      if (writeClaim(ctx, card2, last, "takeover", me, `forced. holder was ${st}`)) return ok(`${card2} taken over from ${holderName(last)}, which ${LIVE_WORDS[st]} (forced). It is yours now. That agent learns it lost the card the next time it calls my_cards.`);
      continue;
    }
    fail("refused", `${card2} was not taken: ${holderName(last)} holds it and ${LIVE_WORDS[st]}. Pass force true only when the person told you, in so many words, to take this card from an agent that is still running.`);
  }
  return fail("unavailable", `record unavailable: could not take over ${card2} after 200 tries. Call card_show with card "${card2}".`);
}
function cardDone(ctx, a) {
  needProject(ctx);
  const card2 = needCard(ctx, a.card);
  const me = strongIdentity(ctx, "finish");
  for (let tries = 0; tries < 200; tries++) {
    const last = lastClaim(ctx.root, card2);
    if (last?.event === "done") return ok(`${card2} is already done.`);
    if (last?.event === "cancel") fail("closed", closedText(card2, last));
    if (!isHeld(last)) fail("not_holder", `You do not hold ${card2}, nobody does. Claim it with card_claim first, then call card_done.`);
    if (last.session !== ctx.caller.session) fail("not_holder", `You do not hold ${card2}. ${holderName(last)} does. Only its holder can mark it done.`);
    if (writeClaim(ctx, card2, last, "done", me, "", a.summary, a.artifacts)) return ok(`${card2} is done. The person sees it in their inbox with your summary.`);
  }
  return fail("unavailable", `record unavailable: could not mark ${card2} done after 200 tries. Call card_show with card "${card2}".`);
}
function cardCancel(ctx, a) {
  needProject(ctx);
  const card2 = needCard(ctx, a.card);
  const person = ctx.caller.actor === "person";
  const me = person ? { pid: null, start: "" } : { pid: ctx.caller.pid, start: ctx.caller.pid ? procStart(ctx.caller.pid) : "" };
  for (let tries = 0; tries < 200; tries++) {
    const last = lastClaim(ctx.root, card2);
    if (last?.event === "cancel") return ok(`${card2} is already canceled.`);
    if (last?.event === "done") fail("closed", closedText(card2, last));
    if (isHeld(last) && !person && last.session !== ctx.caller.session) {
      fail("not_holder", `${card2} is held by ${holderName(last)}. Only its holder or the person can cancel it. If you think it should not be done, say why with comment_add on "${card2}".`);
    }
    if (writeClaim(ctx, card2, last, "cancel", me, "", a.reason)) return ok(`${card2} canceled. It keeps its id and its thread.`);
  }
  return fail("unavailable", `record unavailable: could not cancel ${card2} after 200 tries. Call card_show with card "${card2}".`);
}
function publishComment(ctx, card2, fields, text) {
  const dir = paths(ctx.root).comments(card2);
  const made = publishNext(
    dir,
    () => highest(dir, /^(\d+)\.md$/) + 1,
    (n) => import_node_path5.default.join(dir, `${pad4(n)}.md`),
    (n) => renderRecord([["card", bare(card2)], ["seq", n], ...fields], text)
  );
  return made.n;
}
function commentAdd(ctx, a) {
  needProject(ctx);
  const card2 = needCard(ctx, a.card);
  const n = publishComment(ctx, card2, [["kind", bare("comment")], ...authorFields(ctx.caller), ["artifacts", a.artifacts?.length ? a.artifacts : void 0]], a.text);
  return ok(`${card2}#${n} added.`);
}
function questionAsk(ctx, a) {
  needProject(ctx);
  const card2 = needCard(ctx, a.card);
  const toRaw = (a.to ?? "person").trim();
  const to = /^(person|the person|you|human|user)$/i.test(toRaw) ? "person" : needCard(ctx, toRaw);
  const n = publishComment(ctx, card2, [["kind", bare("question")], ["to", bare(to)], ...authorFields(ctx.caller)], a.text);
  const close = `It stays open until someone calls question_answer with card "${card2}" and question ${n}.`;
  if (to === "person") {
    return ok(`${card2}#${n} asked, to the person. ${close} Now ask the person the same question in the chat: the record does not notify them inside this conversation. If you can carry on without the answer, say what you assume and carry on.`);
  }
  const holder = lastClaim(ctx.root, to);
  const whom = isHeld(holder) ? `${holder.agent || "an agent"} holds ${to} now` : `nobody holds ${to} now, so it waits for whoever claims it`;
  return ok(`${card2}#${n} asked, to the agent on ${to} (${whom}). They see it when they call my_cards. ${close} Call my_cards later to see the answer.`);
}
function questionAnswer(ctx, a) {
  needProject(ctx);
  const card2 = needCard(ctx, a.card);
  const full = readCard(ctx.root, card2);
  const q = full?.questions.find((x) => x.seq === a.question);
  if (!q) {
    const open = full?.questions.filter((x) => x.open).map((x) => `#${x.seq}`) ?? [];
    fail("not_found", `${card2}#${a.question} is not a question. ${open.length ? `Open questions on ${card2}: ${open.join(", ")}.` : `${card2} has no open question.`} Call card_show with card "${card2}" to see its thread.`);
  }
  const by = a.by ?? (ctx.caller.actor === "person" ? "person" : "agent");
  const n = publishComment(ctx, card2, [["kind", bare("answer")], ["answers", a.question], ...authorFields(ctx.caller, by)], a.text);
  const was = q.open ? `${card2}#${a.question} is closed.` : `${card2}#${a.question} already had an answer (#${q.answeredBy.join(", #")}), yours was added.`;
  return ok(`${card2}#${n} answers #${a.question}. ${was} If this answer settles something, record it too: conclusion_record with card "${card2}"${by === "person" ? ' and by "person"' : ""}.`);
}
function indexLine(c) {
  return `${c.id} | ${c.kind} | ${c.at} | ${c.card ?? "-"} | ${c.by} | ${c.replaces ?? "-"} | ${cutBytes(oneLine(c.what), 700)}`;
}
function conclusionRecord(ctx, a) {
  needProject(ctx);
  const p = paths(ctx.root);
  const card2 = a.card ? needCard(ctx, a.card) : void 0;
  const replaces = a.replaces ? needConclusion(ctx, a.replaces, "replaces:") : void 0;
  const related = (a.related ?? []).map((r) => needConclusion(ctx, r, "related:"));
  const by = a.by ?? (ctx.caller.actor === "person" ? "person" : "agent");
  const letter = KIND_LETTER[a.kind];
  const author2 = authorFields(ctx.caller, by);
  const at = author2.find(([k]) => k === "at")[1].bare;
  const what = oneLine(a.what);
  const made = publishNext(
    p.conclusions,
    () => highest(p.conclusions, new RegExp(`^${letter}-([1-9][0-9]*)\\.md$`)) + 1,
    (n) => import_node_path5.default.join(p.conclusions, `${letter}-${n}.md`),
    (n) => renderRecord([
      ["id", bare(`${letter}-${n}`)],
      ["kind", bare(a.kind)],
      ["what", what],
      ["why", a.why ?? ""],
      ...author2,
      ["card", card2 ? bare(card2) : void 0],
      ["replaces", replaces ? bare(replaces) : void 0],
      ["related", related.length ? related : void 0],
      ["changes_plan", a.changes_plan ? true : void 0],
      ["area", a.area ? oneLine(a.area).toLowerCase() : void 0]
    ])
  );
  const id = `${letter}-${made.n}`;
  appendLine(p.index, indexLine({ id, kind: a.kind, at, card: card2, by, replaces, what }));
  const whose = by === "person" ? "the person's" : "yours";
  return ok(
    `${id} recorded: ${a.kind}, ${whose}.${replaces ? ` It replaces ${replaces}, which now shows as superseded.` : ""}${a.changes_plan ? " It is flagged as changing the plan, so the person sees it in their inbox." : ""} Cite it as ${id} in cards, comments and commit messages.`
  );
}
function reindex(root) {
  const p = paths(root);
  let text = "";
  try {
    text = import_node_fs4.default.readFileSync(p.index, "utf8");
  } catch {
  }
  const have = new Set(text.split("\n").map((l) => l.split(" | ")[0].trim()));
  let added = 0;
  for (const c of readConclusions(root).reverse()) {
    if (have.has(c.id)) continue;
    appendLine(p.index, indexLine(c));
    added++;
  }
  return added;
}
function conclusionSearch(ctx, a) {
  needProject(ctx);
  const all = readConclusions(ctx.root);
  const card2 = a.card ? normId(a.card) : void 0;
  const q = (a.query ?? "").trim();
  const asId = CONCLUSION_ID.test(q.toUpperCase()) ? q.toUpperCase() : null;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = all.filter((c) => {
    if (a.kind && c.kind !== a.kind) return false;
    if (card2 && c.card !== card2) return false;
    if (asId) return c.id === asId;
    if (!terms.length) return true;
    const hay = [c.id, c.kind, c.what, c.why, c.area ?? "", c.card ?? "", c.agent, c.sub ?? "", c.by === "person" ? "person you the person" : "agent"].join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const shown = matches.filter((c) => asId || a.include_replaced || !c.superseded);
  const hidden = matches.filter((c) => !shown.includes(c));
  const limit = Math.min(Math.max(a.limit ?? 20, 1), 50);
  const lines = [];
  for (const c of shown.slice(0, limit)) {
    const head2 = [`${c.id} ${c.kind}`, c.by === "person" ? `by the person (recorded by ${c.agent || "an agent"})` : `by ${who(c)}`, shortTime(c.at)];
    if (c.card) head2.push(c.card);
    if (c.area) head2.push(`area ${c.area}`);
    if (c.changesPlan) head2.push("changes the plan");
    if (c.replaces) head2.push(`replaces ${c.replaces}`);
    if (c.related.length) head2.push(`related ${c.related.join(", ")}`);
    if (c.superseded) head2.push(`SUPERSEDED by ${c.replacedBy.join(", ")} - do not follow this one`);
    lines.push(head2.join(" | "), `  what: ${c.what}`);
    if (c.why) lines.push(`  why: ${cut(oneLine(c.why), 600)}`);
  }
  const head = `${shown.length} conclusion${shown.length === 1 ? "" : "s"} match${shown.length === 1 ? "es" : ""}${q ? ` "${q}"` : ""}${a.kind ? `, kind ${a.kind}` : ""}${card2 ? `, card ${card2}` : ""} (of ${all.length} in the project).`;
  const tail = [];
  if (shown.length > limit) tail.push(`${shown.length - limit} more match. Narrow the query, or pass a larger limit (up to 50).`);
  if (hidden.length) tail.push(`${hidden.length} superseded and not shown: ${hidden.map((c) => `${c.id} (replaced by ${c.replacedBy.join(", ")})`).join(", ")}. Pass include_replaced true to see them.`);
  if (!shown.length && !hidden.length) tail.push(q ? "Nothing is settled on this yet as far as the record knows. Try fewer or other words before you conclude that." : "No conclusions recorded yet.");
  return ok([head, ...lines, ...tail].join("\n"));
}
function allOpenQuestions(cards) {
  return cards.flatMap((c) => c.questions.filter((q) => q.open)).sort((a, b) => a.at < b.at ? 1 : -1);
}
function you(ctx) {
  const c = ctx.caller;
  if (c.actor === "person") return "you: the person";
  if (!c.session) return "you: unknown session (no Claude session id could be found)";
  return `you: session ${c.session}${c.agent ? ` "${c.agent}"` : ""}`;
}
var STATE_BUDGET = 9e3;
function stateText(ctx, opts = {}) {
  const project = needProject(ctx);
  const cards = readCards(ctx.root);
  const index = readIndex(ctx.root);
  const rev = revisionOf(project, cards, listConclusionIds(ctx.root).length);
  const all = !!opts.all;
  const caps = all ? { q: 1e9, active: 1e9, closed: 1e9, concl: 50 } : { q: 6, active: 30, closed: 3, concl: 10 };
  const mine = cards.filter((c) => c.holder && c.holder.session === ctx.caller.session && ctx.caller.actor === "agent");
  const out = [];
  out.push(`# record ${project.prefix} rev ${rev}${project.name ? ` - ${cut(oneLine(project.name), 60)}` : ""}`);
  out.push(`goal: ${project.goal ? cut(oneLine(project.goal), 300) : "(none written yet)"}`);
  out.push(`${you(ctx)}. ${mine.length ? `you hold ${mine.map((c) => c.id).join(", ")}` : "you hold no card"}`);
  const questions = allOpenQuestions(cards);
  questions.sort((a, b) => (a.to === "person" ? 0 : 1) - (b.to === "person" ? 0 : 1) || (a.at < b.at ? 1 : -1));
  out.push("", `## open questions (${questions.length})`);
  for (const q of questions.slice(0, caps.q)) {
    out.push(cut(`${q.card}#${q.seq} -> ${q.to === "person" ? "the person" : q.to} | ${who(q)} | ${shortTime(q.at)} | ${oneLine(q.text)}`, all ? 2e3 : 200));
  }
  if (questions.length > caps.q) out.push(`(${questions.length - caps.q} more. record_state with all true lists them)`);
  const count = (s) => cards.filter((c) => c.status === s).length;
  out.push("", `## cards (${cards.length}: ${count("in_progress")} in progress, ${count("todo")} todo, ${count("done")} done, ${count("canceled")} canceled)`);
  const line = (c) => {
    const bits = [c.id, c.status];
    if (c.holder) bits.push(`[${c.holder.agent || c.holder.session.slice(0, 8)}]`);
    if (c.asksPerson) bits.push("asks the person");
    if (c.needs.length) bits.push(`needs ${c.needs.join(",")}`);
    return cut(`${bits.join(" ")} | ${c.title}`, all ? 400 : 140);
  };
  const active = [...cards.filter((c) => c.status === "in_progress"), ...cards.filter((c) => c.status === "todo")];
  for (const c of active.slice(0, caps.active)) out.push(line(c));
  if (active.length > caps.active) out.push(`(${active.length - caps.active} more todo cards. record_state with all true lists them)`);
  const closed = cards.filter((c) => c.status === "done" || c.status === "canceled").sort((a, b) => a.lastActivity < b.lastActivity ? 1 : -1);
  for (const c of closed.slice(0, caps.closed)) out.push(line(c));
  if (closed.length > caps.closed) out.push(`(${closed.length - caps.closed} more done or canceled)`);
  if (!cards.length) out.push("(no cards yet. create the first with card_create)");
  out.push("", `## newest conclusions (${Math.min(caps.concl, index.length)} of ${index.length})`);
  for (const c of index.slice(0, caps.concl)) {
    const bits = [`${c.id} ${c.kind}${c.by === "person" ? " (the person's)" : ""}`];
    if (c.card) bits.push(c.card);
    if (c.replaces) bits.push(`replaces ${c.replaces}`);
    if (c.superseded) bits.push(`SUPERSEDED by ${c.replacedBy.join(",")}`);
    out.push(cut(`${bits.join(" ")} | ${c.what}`, all ? 800 : 180));
  }
  if (index.length > caps.concl) out.push(`(${index.length - caps.concl} older. call conclusion_search before you settle anything)`);
  if (!index.length) out.push("(none yet)");
  out.push("", "write through the mcp__grove__* tools. start with my_cards, then card_claim before you work on a card. rules: .claude/rules/grove-record.md");
  let text = out.join("\n");
  if (!all && text.length > STATE_BUDGET) {
    text = `${text.slice(0, STATE_BUDGET - 80)}
(cut to stay under the hook's limit. call record_state with all true)`;
  }
  return text;
}
function recordState(ctx, a) {
  return ok(stateText(ctx, a));
}
function threadLines(card2) {
  const entries = [];
  const text = (s, file) => s.length > 1500 ? `${s.slice(0, 1500)}\u2026 (${s.length - 1500} more characters in ${file})` : s;
  for (const c of card2.comments) {
    const q = card2.questions.find((x) => x.seq === c.seq);
    let head = `#${c.seq} `;
    if (c.kind === "question") head += `question to ${c.to === "person" ? "the person" : c.to} ${q?.open ? "[OPEN]" : `[answered in #${q?.answeredBy.join(", #")}]`}`;
    else if (c.kind === "answer") head += `answer to #${c.answers ?? "?"}${c.by === "person" ? ", the person's" : ""}`;
    else head += "comment";
    head += ` | ${c.by === "person" && c.session !== "person" ? `written by ${who(c)}` : who(c)} | ${shortTime(c.at)}`;
    const lines = [head, ...text(c.text, c.file).split("\n").map((l) => `  ${l}`)];
    if (c.artifacts.length) lines.push(`  made: ${c.artifacts.map((x) => `${x.type} ${x.ref}`).join(", ")}`);
    entries.push({ at: c.at, order: 0, lines });
  }
  for (const e of card2.claims) {
    const verb = { claim: "claimed", release: "released", takeover: "took over", done: "marked done", cancel: "canceled" };
    const lines = [`-- ${who(e)} ${verb[e.event] ?? e.event} | ${shortTime(e.at)}${e.note ? ` | ${e.note}` : ""}`];
    if (e.body) lines.push(...text(e.body, e.file).split("\n").map((l) => `  ${l}`));
    if (e.artifacts.length) lines.push(`  made: ${e.artifacts.map((x) => `${x.type} ${x.ref}`).join(", ")}`);
    entries.push({ at: e.at, order: 1, lines });
  }
  entries.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order);
  const keep = entries.slice(-40);
  const out = [];
  if (entries.length > keep.length) out.push(`(${entries.length - keep.length} earlier entries are in ${import_node_path5.default.dirname(card2.file)})`);
  for (const e of keep) out.push(...e.lines);
  return out;
}
function cardShow(ctx, a) {
  needProject(ctx);
  const id = needCard(ctx, a.card);
  const card2 = readCard(ctx.root, id);
  const out = [`${card2.id} ${card2.status} | ${card2.title}`];
  const last = card2.claims[card2.claims.length - 1] ?? null;
  if (card2.holder && isHeld(last)) {
    const st = liveness(ctx, last);
    const mine = card2.holder.session === ctx.caller.session;
    out.push(`held by ${mine ? "you" : holderName(last)} since ${shortTime(card2.holder.since)}${mine ? "" : `. its process ${LIVE_WORDS[st]}`}`);
  } else if (card2.status === "todo") out.push("nobody holds it. card_claim takes it");
  const meta = [`created ${shortTime(card2.at)} by ${who(card2)}`];
  if (card2.from) meta.push(`from ${card2.from}`);
  if (card2.needs.length) meta.push(`needs ${card2.needs.join(", ")}`);
  out.push(meta.join(" | "));
  if (card2.problems.length) out.push(`(this card file has problems: ${card2.problems.join("; ")})`);
  out.push("", card2.body || "(no description)");
  const concl = readConclusions(ctx.root).filter((c) => c.card === id);
  out.push("", `## thread (${card2.comments.length} comments)`);
  const lines = threadLines(card2);
  out.push(...lines.length ? lines : ["(nothing yet)"]);
  if (concl.length) {
    out.push("", `## conclusions on this card (${concl.length})`);
    for (const c of concl) out.push(cut(`${c.id} ${c.kind}${c.by === "person" ? ", the person's" : ""}${c.superseded ? ` SUPERSEDED by ${c.replacedBy.join(",")}` : ""} | ${c.what}`, 300));
  }
  const others = readCards(ctx.root).filter((c) => c.id !== id);
  const links = [];
  for (const c of others) {
    if (c.from === id) links.push(`${c.id} was created from this card`);
    if (c.needs.includes(id)) links.push(`${c.id} needs this card`);
    for (const q of c.questions) if (q.open && q.to === id) links.push(`${c.id}#${q.seq} is an open question for this card's agent: ${cut(oneLine(q.text), 160)}`);
  }
  if (links.length) out.push("", "## linked", ...links);
  return ok(out.join("\n"));
}
function myCards(ctx) {
  needProject(ctx);
  const c = ctx.caller;
  if (c.actor === "person") return ok("The person does not hold cards.");
  if (!c.session) return fail("unavailable", `record unavailable: cannot tell which Claude session is calling (session: ${c.sessionSource}, process: ${c.pidSource}).`);
  const myStart = c.pid ? procStart(c.pid) : "";
  const cards = readCards(ctx.root);
  const out = [you(ctx)];
  const mine = [];
  const notes = [];
  for (const card2 of cards) {
    const last = card2.claims[card2.claims.length - 1] ?? null;
    if (isHeld(last) && last.session === c.session) {
      mine.push(card2);
      if (c.pid && (last.pid !== c.pid || last.pidStart !== myStart)) {
        const done = writeClaim(ctx, card2.id, last, "claim", { pid: c.pid, start: myStart }, "same session, new process");
        notes.push(done ? `${card2.id}: claim refreshed, this session now runs in a new process.` : `${card2.id}: its claim changed while refreshing. call card_show with card "${card2.id}".`);
      }
      continue;
    }
    if (!last) continue;
    if (last.prevSession !== c.session || last.session === c.session) {
      if (isHeld(last) && c.pid && last.pid === c.pid && last.pidStart === myStart) {
        notes.push(`${card2.id} is held by the session this window had before /clear (${last.session.slice(0, 8)}). It is not yours now. Ask the person whether to carry on with it. If yes, call card_takeover with card "${card2.id}".`);
      }
      continue;
    }
    if (last.event === "takeover") notes.push(`${card2.id} is no longer yours: ${who(last)} took it over at ${shortTime(last.at)}. Stop working on it.`);
    else if (last.event === "release") notes.push(`${card2.id} is no longer yours: ${who(last)} released it at ${shortTime(last.at)}. Stop working on it, or claim it again with card_claim if nobody else has.`);
    else if (last.event === "cancel") notes.push(`${card2.id} was canceled by ${who(last)} at ${shortTime(last.at)}: ${cut(oneLine(last.body), 200)}. Stop working on it.`);
  }
  if (!mine.length) {
    const todo = cards.filter((x) => x.status === "todo").map((x) => x.id);
    out.push(`you hold no card. ${todo.length ? `todo and unclaimed: ${todo.slice(0, 12).join(", ")}${todo.length > 12 ? ` and ${todo.length - 12} more` : ""}. claim one with card_claim before you work on it` : "there is no todo card. create one with card_create, or ask the person what to do next"}.`);
  } else {
    out.push(`you hold ${mine.length} card${mine.length === 1 ? "" : "s"}:`);
  }
  const myIds = new Set(mine.map((x) => x.id));
  for (const card2 of mine) {
    out.push(`${card2.id} in progress since ${shortTime(card2.holder.since)} | ${cut(card2.title, 120)}`);
    let since = "";
    for (const x of [...card2.comments, ...card2.claims]) if (x.session === c.session && x.at > since) since = x.at;
    const fresh = card2.comments.filter((x) => x.session !== c.session && x.at > since);
    for (const x of fresh.slice(-5)) out.push(cut(`  new ${describe(x)} | ${who(x)} | ${shortTime(x.at)} | ${oneLine(x.text)}`, 320));
    if (fresh.length > 5) out.push(`  (${fresh.length - 5} more new comments. card_show with card "${card2.id}")`);
    for (const q of card2.questions.filter((x) => x.open && x.to === "person")) out.push(cut(`  still open, to the person: #${q.seq} ${oneLine(q.text)}`, 240));
    if (!fresh.length) out.push("  nothing new on it");
  }
  const forMe = cards.flatMap((x) => x.questions.filter((q) => q.open && myIds.has(q.to) && q.session !== c.session));
  if (forMe.length) {
    out.push("", "questions other agents left for you:");
    for (const q of forMe) out.push(cut(`${q.card}#${q.seq} for ${q.to} | ${who(q)} | ${shortTime(q.at)} | ${oneLine(q.text)}`, 400), `  answer with question_answer: card "${q.card}", question ${q.seq}`);
  }
  if (notes.length) out.push("", ...notes);
  return ok(out.join("\n"));
}
function describe(c) {
  if (c.kind === "question") return `question #${c.seq} to ${c.to === "person" ? "the person" : c.to}`;
  if (c.kind === "answer") return `answer #${c.seq} to #${c.answers ?? "?"}${c.by === "person" ? " from the person" : ""}`;
  return `comment #${c.seq}`;
}
function renderProjectFile(p) {
  return `${JSON.stringify({ v: FORMAT_VERSION, name: p.name, prefix: p.prefix, goal: p.goal, rev: p.rev }, null, 2)}
`;
}
function projectInit(ctx, a) {
  const p = paths(ctx.root);
  const prefix = normId(a.prefix);
  if (!PREFIX.test(prefix)) fail("invalid", `prefix "${a.prefix}" must be 1 to 8 letters or digits, starting with a letter.`);
  if (prefix.length === 1 && "DFV".includes(prefix)) fail("invalid", `prefix "${prefix}" is taken by conclusion ids (D-1, F-1, V-1). Use two or more characters.`);
  const before = readProject(ctx.root);
  const existing = listCardIds(ctx.root);
  if (existing.length && before?.prefix && before.prefix !== prefix) {
    fail("invalid", `this project already has cards with prefix ${before.prefix} (${existing.length} of them). the prefix cannot change.`);
  }
  const next = { v: FORMAT_VERSION, name: oneLine(a.name ?? before?.name ?? ""), prefix, goal: oneLine(a.goal ?? before?.goal ?? ""), rev: before?.rev ?? 0 };
  const same = before && !before.problems.length && before.name === next.name && before.prefix === next.prefix && before.goal === next.goal;
  if (same) return ok(`project unchanged. prefix ${prefix}, rev ${before.rev}`);
  next.rev = (before?.rev ?? 0) + 1;
  import_node_fs4.default.mkdirSync(import_node_path5.default.dirname(p.project), { recursive: true });
  const tmp = `${p.project}.${process.pid}.tmp`;
  import_node_fs4.default.writeFileSync(tmp, renderProjectFile(next));
  import_node_fs4.default.renameSync(tmp, p.project);
  return ok(`project ready. prefix ${prefix}, rev ${next.rev}`);
}

// src/validate.ts
var ARTIFACT_TYPES = ["file", "branch", "pr", "link"];
function jsonSchema(spec) {
  const properties = {};
  for (const [name, p] of Object.entries(spec.properties)) {
    if (p.type === "ids") properties[name] = { type: "array", items: { type: "string" }, description: p.description };
    else if (p.type === "artifacts") {
      properties[name] = {
        type: "array",
        description: p.description,
        items: {
          type: "object",
          properties: { type: { type: "string", enum: ARTIFACT_TYPES }, ref: { type: "string" } },
          required: ["type", "ref"],
          additionalProperties: false
        }
      };
    } else {
      const s = { type: p.type, description: p.description };
      if (p.enum) s.enum = p.enum;
      if (p.max) s.maxLength = p.max;
      properties[name] = s;
    }
  }
  return { type: "object", properties, required: spec.required, additionalProperties: false };
}
function usage(tool2, spec) {
  const names = Object.keys(spec.properties).map((n) => spec.required.includes(n) ? `${n} (required)` : n);
  return `${tool2} takes: ${names.length ? names.join(", ") : "no arguments"}. Example: ${JSON.stringify(spec.example)}`;
}
function guessArtifact(s) {
  const m = /^(file|branch|pr|link):\s*(.+)$/i.exec(s);
  if (m) return { type: m[1].toLowerCase(), ref: m[2].trim() };
  if (/^https?:\/\//.test(s)) return { type: /\/pull\/\d+|\/merge_requests\/\d+/.test(s) ? "pr" : "link", ref: s };
  return { type: "file", ref: s };
}
function check(tool2, spec, raw) {
  const bad = (why) => ({ ok: false, text: `${tool2}: ${why}. ${usage(tool2, spec)}` });
  if (raw === void 0 || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) return bad("the arguments must be one JSON object");
  const input = { ...raw };
  for (const [alias, real] of Object.entries(spec.aliases ?? {})) {
    if (alias in input && !(real in input)) {
      input[real] = input[alias];
      delete input[alias];
    }
  }
  const args = {};
  for (const key of Object.keys(input)) {
    if (!(key in spec.properties)) return bad(`unknown argument "${key}"`);
  }
  for (const [name, p] of Object.entries(spec.properties)) {
    let v = input[name];
    const required = spec.required.includes(name);
    if (v === void 0 || v === null || typeof v === "string" && v.trim() === "" && p.type !== "boolean") {
      if (required) return bad(`"${name}" is required${v === "" ? " and was empty" : ""}`);
      continue;
    }
    if (p.type === "string") {
      if (typeof v === "number" || typeof v === "boolean") v = String(v);
      if (typeof v !== "string") return bad(`"${name}" must be text`);
      let s = v;
      if (p.format === "id") s = normId(s);
      if (p.format === "line") s = oneLine(s);
      if (p.enum) {
        const hit = p.enum.find((e) => e === s.trim().toLowerCase());
        if (!hit) return bad(`"${name}" must be one of: ${p.enum.join(", ")}. got "${s}"`);
        s = hit;
      }
      if (p.max && Array.from(s).length > p.max) return bad(`"${name}" is ${Array.from(s).length} characters, the limit is ${p.max}. Shorten it${name === "what" || name === "title" ? " and put the detail in the other text argument" : ""}`);
      args[name] = s;
    } else if (p.type === "boolean") {
      if (v === true || v === "true") args[name] = true;
      else if (v === false || v === "false" || v === "") args[name] = false;
      else return bad(`"${name}" must be true or false`);
    } else if (p.type === "integer") {
      const m = typeof v === "string" ? /(?:^|#)(\d+)$/.exec(v.trim()) : null;
      const n = typeof v === "number" ? v : m ? Number(m[1]) : Number.NaN;
      if (!Number.isInteger(n) || n < 1) return bad(`"${name}" must be a whole number, 1 or more`);
      args[name] = n;
    } else if (p.type === "ids") {
      const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : null;
      if (!list || list.some((x) => typeof x !== "string")) return bad(`"${name}" must be a list of ids`);
      args[name] = list.map(normId).filter(Boolean);
    } else {
      const list = Array.isArray(v) ? v : [v];
      const out = [];
      for (const item of list) {
        if (typeof item === "string" && item.trim()) out.push(guessArtifact(item.trim()));
        else if (item && typeof item === "object" && typeof item.ref === "string") {
          const t = String(item.type ?? "").toLowerCase();
          if (!ARTIFACT_TYPES.includes(t)) return bad(`each entry of "${name}" needs a type: ${ARTIFACT_TYPES.join(", ")}`);
          out.push({ type: t, ref: oneLine(item.ref) });
        } else return bad(`each entry of "${name}" must be {"type": "file" | "branch" | "pr" | "link", "ref": "..."}`);
      }
      args[name] = out;
    }
  }
  return { ok: true, args };
}

// src/tools.ts
var card = (description) => ({ type: "string", format: "id", max: 40, description });
var AS = {
  type: "string",
  format: "line",
  max: 40,
  description: `Only when you are a subagent: a short name for yourself, like "long-task" or "explore". It is stored on the record so the person can tell your writes from your parent session's. Leave it out in a main session.`
};
var ARTIFACTS = {
  type: "artifacts",
  description: 'What you made, so it shows on the card: [{"type": "file", "ref": "artifacts/report.md"}, {"type": "branch", "ref": "feat/login-sso"}, {"type": "pr", "ref": "https://github.com/org/repo/pull/12"}]. type is file, branch, pr or link. A file ref is a path from the project root.'
};
var TOOLS = [
  {
    name: "record_state",
    summary: "the goal, every card with status and holder, open questions, newest conclusions, who you are",
    description: "Read the shared project record: the goal, every card with its status and holder, the open questions, the newest conclusions (decisions, findings, verdicts) and which session you are. Call it before you start any work in this project, and again whenever you need the current picture. A subagent, and a session started inside a working copy, gets no state at session start, so for them this call is the only way to see it. Read-only.",
    input: {
      properties: { all: { type: "boolean", description: "true lists every card and open question and up to 50 conclusions, with no size cap. Leave it out for the normal view." } },
      required: [],
      example: {}
    },
    writes: false,
    readOnly: true,
    alwaysLoad: true,
    run: (ctx, a) => recordState(ctx, { all: a.all })
  },
  {
    name: "my_cards",
    summary: "the cards you hold, what is new on them, questions left for you. also refreshes your claims after a resume",
    description: "List the cards this session holds, what is new on them since your last write (comments, answers to your questions) and the open questions other agents left for you. Call it at the start of every turn, and after a resume or a fork. It refreshes your claims when the session came back in a new process, and tells you when a card was taken over, released or canceled by someone else. Takes no arguments.",
    input: { properties: {}, required: [], example: {} },
    writes: false,
    alwaysLoad: true,
    run: (ctx) => myCards(ctx)
  },
  {
    name: "card_show",
    summary: "one card in full: description, holder, the whole thread, its conclusions, linked cards",
    description: "Read one card in full: its description, status, who holds it and whether their process is running, the whole thread (comments, questions with their answers, claim events), the conclusions recorded on it and the cards linked to it. Call it before you claim or work on a card, and before you answer a question on it. Read-only.",
    input: { properties: { card: card("The card id, like AUTH-3.") }, required: ["card"], example: { card: "AUTH-3" } },
    writes: false,
    readOnly: true,
    run: (ctx, a) => cardShow(ctx, { card: a.card })
  },
  {
    name: "card_create",
    summary: "create a card for work that is not part of your own card",
    description: "Create a card: one sizeable piece of work that an agent can pick up and finish. Call it when you find work that is not part of your own card, or when the person asks for something new. Do not do that work yourself unless it is small and blocks you. The new card is todo and unclaimed, the person sees it in their inbox, and any agent may claim it. Creating a card does not claim it. Write the body as a brief for an agent that has not seen your conversation: what to do, what done looks like, what you already know, and the ids of related cards and conclusions. Returns the new id, like AUTH-7.",
    input: {
      properties: {
        title: { type: "string", format: "line", max: 200, description: "One line that says what the work is." },
        body: { type: "string", max: 2e4, description: "The brief, in markdown." },
        from: card("The card you were working on when you found this work. Leave it out when there is none."),
        needs: { type: "ids", description: 'Ids of cards that have to be done before this one can start, like ["AUTH-4"].' },
        as: AS
      },
      required: ["title"],
      example: { title: "Rate limit the callback endpoint", body: "Found while doing AUTH-1. ...", from: "AUTH-1" }
    },
    writes: true,
    run: (ctx, a) => cardCreate(ctx, { title: a.title, body: a.body, from: a.from, needs: a.needs })
  },
  {
    name: "card_claim",
    summary: "claim a card before you work on it. one session holds a card",
    description: "Claim a card before you work on it. Exactly one session holds a card, which is how two agents never do the same work. It succeeds when the card is todo or already yours. If another agent holds it, you are told so: do not work on it. If the holder's process is gone, you are told that too: ask the person, do not take it. Subagents do not claim: they work under their parent session's claim.",
    input: { properties: { card: card("The card id, like AUTH-3."), as: AS }, required: ["card"], example: { card: "AUTH-3" } },
    writes: true,
    alwaysLoad: true,
    run: (ctx, a) => cardClaim(ctx, { card: a.card })
  },
  {
    name: "card_release",
    summary: "give a card back unfinished, with a note on where you stopped",
    description: "Give back a card you hold, unfinished, so that another agent can claim it. Say in note where you stopped and what is left. Use card_done when the work is complete, and card_cancel when it should not be done at all.",
    input: {
      properties: { card: card("The card id."), note: { type: "string", max: 4e3, description: "Where you stopped and what is left, for the next agent." }, as: AS },
      required: ["card"],
      aliases: { text: "note" },
      example: { card: "AUTH-3", note: "The form is done. The redirect for SSO-only orgs is not started." }
    },
    writes: true,
    run: (ctx, a) => cardRelease(ctx, { card: a.card, note: a.note })
  },
  {
    name: "card_done",
    summary: "mark your card done, with a summary of what was and was not done",
    description: "Mark a card you hold as done. You decide when it is complete. summary is what the person and later agents read instead of your transcript: what was done, what was not done, how you checked it, and the ids of the conclusions that matter (D-4, F-2). List what you made in artifacts. A done card cannot be reopened. Follow-up work is a new card created with from.",
    input: {
      properties: { card: card("The card id."), summary: { type: "string", max: 4e3, description: "What was done, what was not, and how you checked it." }, artifacts: ARTIFACTS, as: AS },
      required: ["card", "summary"],
      aliases: { text: "summary" },
      example: { card: "AUTH-3", summary: "Login page with the SSO button is in. Email-first step sends SSO orgs to okta (D-5). Not done: the error page for a disabled org, see AUTH-9. Checked with the e2e suite." }
    },
    writes: true,
    run: (ctx, a) => cardDone(ctx, { card: a.card, summary: a.summary, artifacts: a.artifacts })
  },
  {
    name: "card_cancel",
    summary: "cancel a card that should not be done, with the reason",
    description: "Cancel a card that should not be done: it is a duplicate, the plan changed, or a conclusion made it pointless. reason is required and should cite the card or conclusion that explains it. You can cancel a card you hold or a card nobody holds. A canceled card keeps its id and its thread, and cannot be reopened.",
    input: {
      properties: { card: card("The card id."), reason: { type: "string", max: 4e3, description: "Why it should not be done. Cite the card or conclusion id that explains it." }, as: AS },
      required: ["card", "reason"],
      aliases: { text: "reason" },
      example: { card: "AUTH-8", reason: "Duplicate of AUTH-5." }
    },
    writes: true,
    run: (ctx, a) => cardCancel(ctx, { card: a.card, reason: a.reason })
  },
  {
    name: "card_takeover",
    summary: "take a card another session holds. only when the person told you to",
    description: "Take a card that another session holds. Call this only when the person told you to take that card. Without force it works only when the holder's process is gone (a closed tab, a crash). force true also takes the card from an agent that is still running, and is only for when the person explicitly said to do that. Never use it to get a card you would like to work on.",
    input: {
      properties: { card: card("The card id."), force: { type: "boolean", description: "true only when the person explicitly told you to take the card from an agent that is still running." }, as: AS },
      required: ["card"],
      example: { card: "AUTH-3" }
    },
    writes: true,
    run: (ctx, a) => cardTakeover(ctx, { card: a.card, force: a.force })
  },
  {
    name: "comment_add",
    summary: "add a note to a card's thread: what you made, what you learned, where you stopped",
    description: "Add a comment to a card's thread. Use it when you made something (a branch, a PR, a file under artifacts/ - list it in artifacts), when you learned something the next agent would otherwise have to find out again, or when you stopped early or hit something you could not solve. Refer to other cards and to conclusions by id (AUTH-3, D-4). Not for questions (use question_ask) and not for conclusions (use conclusion_record).",
    input: {
      properties: { card: card("The card to comment on. It can be any card, not only one you hold."), text: { type: "string", max: 2e4, description: "The comment, in markdown." }, artifacts: ARTIFACTS, as: AS },
      required: ["card", "text"],
      example: { card: "AUTH-4", text: "Okta app settings per environment are written up.", artifacts: [{ type: "file", ref: "artifacts/okta-app-settings.md" }] }
    },
    writes: true,
    run: (ctx, a) => commentAdd(ctx, { card: a.card, text: a.text, artifacts: a.artifacts })
  },
  {
    name: "question_ask",
    summary: "put a question on the record, to the person or to the agent on another card",
    description: `Put a question on the record. Every question goes here, with its answer once there is one. A question that lives only in the chat is lost to every other agent and never reaches the person's inbox. card is the card the question is about, normally the one you hold. to is "person" (the default) for the person who runs the project, or a card id to ask whichever agent holds that card. After asking the person here, ask them in the chat as well. If you cannot carry on without the answer, stop there. If you can, say what you assumed and carry on. Returns the question's id, like AUTH-4#6.`,
    input: {
      properties: {
        card: card("The card the question is about, normally the one you hold."),
        text: { type: "string", max: 2e4, description: "The question, with the options you see and what you would pick." },
        to: { type: "string", max: 40, description: 'Who should answer: "person" (the default), or a card id like AUTH-4 for the agent that holds that card.' },
        as: AS
      },
      required: ["card", "text"],
      example: { card: "AUTH-4", text: "Staging has no okta tenant. Create a dev tenant, or point staging at the prod tenant with its own app? I would create a dev tenant.", to: "person" }
    },
    writes: true,
    alwaysLoad: true,
    run: (ctx, a) => questionAsk(ctx, { card: a.card, text: a.text, to: a.to })
  },
  {
    name: "question_answer",
    summary: "record the answer to an open question, which closes it",
    description: `Answer an open question, which closes it. Use it when the person answered one of your questions in the chat (record their answer in their words, with by "person"), when another agent's question is addressed to a card you hold (my_cards lists those), or when you found the answer to your own question. card and question are the two parts of the question's id: AUTH-4#6 is card "AUTH-4", question 6. If the answer settles something, also call conclusion_record.`,
    input: {
      properties: {
        card: card("The card the question is on: the part before # in AUTH-4#6."),
        question: { type: "integer", description: "The question's number: the part after # in AUTH-4#6." },
        text: { type: "string", max: 2e4, description: "The answer." },
        by: { type: "string", enum: ["agent", "person"], description: 'Whose answer it is. "person" when the person gave it and you are writing it down. Default "agent".' },
        as: AS
      },
      required: ["card", "question", "text"],
      example: { card: "AUTH-4", question: 6, text: "Create a dev tenant. I will get the okta admin to approve it.", by: "person" }
    },
    writes: true,
    run: (ctx, a) => questionAnswer(ctx, { card: a.card, question: a.question, text: a.text, by: a.by })
  },
  {
    name: "conclusion_record",
    summary: "record a decision, a finding or a verdict the moment it is settled, yours or the person's",
    description: 'Record something that is now settled, so that the person and every later agent can look it up instead of deciding or finding it again. Three kinds. decision: what we will do ("refresh tokens stay on the server"). finding: what turned out to be true ("staging has no okta tenant in terraform state"). verdict: a judgement on an option, an approach or a piece of work ("the saml strategy cannot be reused for oidc"). Record it the moment it is settled, not at the end of the work. That includes the ones nobody announced: a default, a limit, a name, a library or a file layout you picked, something you took as true without checking, something you ruled out or left out of scope. It also includes every one the person makes in the chat or in an answer to your question ("go with that", "no, use redis", "8h, to match the policy"): those are by "person". Call conclusion_search first. If it is already settled, follow it and cite its id. If you go against an earlier conclusion, pass its id in replaces and say why. Do not record routine edits or what the diff already says. Returns the id, like D-12. Cite it in cards, comments and commit messages.',
    input: {
      properties: {
        kind: { type: "string", enum: ["decision", "finding", "verdict"], description: "decision: what we will do. finding: what turned out to be true. verdict: a judgement on an option, an approach or a piece of work." },
        what: { type: "string", format: "line", max: 300, description: "What was concluded, as one sentence that stands on its own without the conversation." },
        why: { type: "string", max: 2e3, description: "The reason or the evidence, in one or two lines. For a finding, how you checked." },
        card: card("The card it belongs to, normally the one you hold. Leave it out when it is about the whole project."),
        by: { type: "string", enum: ["agent", "person"], description: 'Whose conclusion it is, always given. "person" when the person decided, picked, answered, approved or judged it, in the chat or in an answer to your question, and you are writing it down. "agent" only when you reached it yourself.' },
        replaces: card("The id of an earlier conclusion that this one overrules, like D-4. That one then shows as superseded."),
        related: { type: "ids", description: 'Ids of conclusions this one depends on or affects, like ["D-4", "F-2"].' },
        changes_plan: { type: "boolean", description: "true when this changes what the project should do, so the person has to see it. It then goes to their inbox. Mostly for findings: an agent's decisions and verdicts go to the inbox anyway." },
        area: { type: "string", format: "line", max: 40, description: "One word for the part of the system: api, web, infra, tests." },
        as: AS
      },
      required: ["kind", "what", "by"],
      example: { kind: "decision", what: "Refresh tokens stay on the server. The browser only gets an opaque session id.", why: "Keeps tokens out of the page. Costs one redis read per request.", card: "AUTH-1", by: "agent", area: "api" }
    },
    writes: true,
    alwaysLoad: true,
    run: (ctx, a) => conclusionRecord(ctx, a)
  },
  {
    name: "conclusion_search",
    summary: "search what is already settled, before you decide or investigate",
    description: `Search the project's conclusions (decisions, findings, verdicts). Call it before you decide something, before you investigate something that may already be known, and whenever you need the id of an earlier conclusion to cite or replace. query is words that must all appear (in what, why, area, card or author; "person" finds the person's own), or an id like D-4. With no arguments it lists the newest. Superseded conclusions are left out and counted, unless include_replaced is true. Read-only.`,
    input: {
      properties: {
        query: { type: "string", format: "line", max: 200, description: 'Words that must all appear, or a conclusion id like "D-4".' },
        kind: { type: "string", enum: ["decision", "finding", "verdict"], description: "Only this kind." },
        card: card("Only conclusions recorded on this card."),
        include_replaced: { type: "boolean", description: "true also lists superseded conclusions, marked as such." },
        limit: { type: "integer", description: "How many to list. Default 20, at most 50." }
      },
      required: [],
      example: { query: "session redis" }
    },
    writes: false,
    readOnly: true,
    run: (ctx, a) => conclusionSearch(ctx, a)
  },
  {
    name: "project_init",
    summary: "write the project file (prefix, name, goal). grove's sync and the tests use it",
    description: "Write .claude/grove-project.json: the card prefix, the project's name and its goal. Grove calls this when it syncs a project. Not an agent tool.",
    input: {
      properties: {
        prefix: { type: "string", format: "id", max: 8, description: "The card prefix, like AUTH. 1 to 8 letters or digits, starting with a letter." },
        name: { type: "string", format: "line", max: 200, description: "The project's display name." },
        goal: { type: "string", format: "line", max: 2e3, description: "The project's goal, one line." }
      },
      required: ["prefix"],
      example: { prefix: "AUTH", name: "auth-sso", goal: "Org-wide SSO with okta." }
    },
    writes: false,
    mcp: false,
    run: (ctx, a) => projectInit(ctx, a)
  }
];
function tool(name) {
  return TOOLS.find((t) => t.name === name);
}
function mcpToolList() {
  return TOOLS.filter((t) => t.mcp !== false).map((t) => {
    const out = { name: t.name, description: t.description, inputSchema: jsonSchema(t.input) };
    if (t.readOnly) out.annotations = { readOnlyHint: true };
    if (t.alwaysLoad) out._meta = { "anthropic/alwaysLoad": true };
    return out;
  });
}
function runTool(name, rawArgs, o) {
  const t = tool(name);
  if (!t) {
    return { ok: false, code: "invalid", text: `There is no tool "${name}". The tools are: ${TOOLS.filter((x) => x.mcp !== false).map((x) => x.name).join(", ")}.` };
  }
  const checked = check(name, t.input, rawArgs);
  if (!checked.ok) return { ok: false, code: "invalid", text: checked.text };
  const { as, ...args } = checked.args;
  return attempt(() => {
    const caller = resolveCaller({ env: o.env, ppid: o.ppid, as, toolUseId: o.toolUseId, person: o.person });
    return t.run({ root: o.root, caller, env: o.env }, args);
  });
}

// src/render.ts
function renderInstructions() {
  return [
    "This server is the project's shared record: cards, questions and conclusions (decisions, findings, verdicts).",
    "The person running the project reads it instead of your transcript, and so does every other agent.",
    "Call record_state before you start work and my_cards at the start of each turn.",
    "Claim a card with card_claim before you work on it.",
    "Record each decision, finding and verdict with conclusion_record when it is settled, the person's included.",
    "Write only through these tools, never by hand under cards/ or conclusions/.",
    "Rules: .claude/rules/grove-record.md"
  ].join(" ");
}
var EXIT_HELP = "exit: 0 ok. 1 bad arguments. 2 no such card or conclusion. 3 held by another agent. 4 the holder's process is gone. 5 you do not hold it. 6 the card is done or canceled. 7 takeover refused. 8 the record is unavailable.";
function renderCliHelp() {
  return `record - the Grove project record

  record mcp                                   the stdio MCP server. the root comes from GROVE_RECORD_ROOT
  record state [--hook] [--all] [--root <dir>] print the project state. --hook never fails: on any error it prints one line and exits 0
  record call <tool> '<json>' [--root <dir>]   run one tool. the arguments are one JSON object. "-" reads it from stdin
  record tools [--json]                        list the tools with their arguments
  record doctor [--root <dir>]                 check the launcher, the bundle, the runtime, the root and who you are

the root is --root, else $GROVE_RECORD_ROOT, else the nearest folder above the current one that holds .claude/grove-project.json.
${EXIT_HELP}
`;
}
function renderToolList() {
  return TOOLS.map((t) => `${t.name}${t.mcp === false ? "  (CLI and library only)" : ""}
  ${t.summary}
  ${usage(t.name, t.input)}`).join("\n\n") + "\n";
}

// src/mcp.ts
var KNOWN_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
function stampOf(entry) {
  try {
    if (!/\.ts$/.test(entry)) {
      const s = import_node_fs5.default.statSync(entry);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    }
    const dir = import_node_path6.default.dirname(entry);
    return import_node_fs5.default.readdirSync(dir).filter((n) => n.endsWith(".ts")).sort().map((n) => {
      const s = import_node_fs5.default.statSync(import_node_path6.default.join(dir, n));
      return `${n}:${s.ino}:${s.size}:${s.mtimeMs}`;
    }).join("|");
  } catch {
    return "missing";
  }
}
function serve(o) {
  const loaded = stampOf(o.entry);
  const logDir = o.env.GROVE_RECORD_LOG;
  const log = (obj) => {
    if (!logDir) return;
    try {
      import_node_fs5.default.mkdirSync(logDir, { recursive: true });
      import_node_fs5.default.appendFileSync(import_node_path6.default.join(logDir, `server-${process.pid}.jsonl`), `${JSON.stringify({ t: Date.now(), ...obj })}
`);
    } catch {
    }
  };
  log({ ev: "start", version: BUNDLE_VERSION, root: o.root, entry: o.entry, ppid: process.ppid });
  const send = (msg) => {
    o.output.write(`${JSON.stringify(msg)}
`);
  };
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const error = (id, code2, message) => send({ jsonrpc: "2.0", id, error: { code: code2, message } });
  const text = (s, isError, code2) => isError ? { content: [{ type: "text", text: s }], isError: true, _meta: { "grove/code": code2 ?? "unavailable" } } : { content: [{ type: "text", text: s }] };
  const child = (args, input, toolUseId) => {
    const bin = o.env.GROVE_RECORD_BIN;
    const [cmd, pre] = bin && import_node_fs5.default.existsSync(bin) ? [bin, []] : [process.execPath, [...process.execArgv, o.entry]];
    return (0, import_node_child_process2.spawnSync)(cmd, [...pre, ...args], {
      input,
      env: {
        ...o.env,
        GROVE_RECORD_ROOT: o.root,
        // the child's parent is this server, not claude. hand it the claude pid and the call's id
        CLAUDE_PID: String(process.ppid),
        GROVE_RECORD_TOOL_USE_ID: toolUseId ?? ""
      },
      encoding: "utf8",
      timeout: 2e4,
      maxBuffer: 16 * 1024 * 1024
    });
  };
  let stale = false;
  const isStale = () => {
    if (stale) return true;
    const now = stampOf(o.entry);
    if (now === loaded || now === "missing") return false;
    stale = true;
    log({ ev: "stale", loaded, now });
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    return true;
  };
  const call = (name, args, toolUseId) => {
    const t0 = process.hrtime.bigint();
    let out;
    let via;
    if (!isStale()) {
      via = "inproc";
      const r = runTool(name, args, { root: o.root, env: o.env, ppid: process.ppid, toolUseId });
      out = { text: r.text, isError: !r.ok, code: r.code };
    } else {
      via = "child";
      const c = child(["call", name, "-"], JSON.stringify(args ?? {}), toolUseId);
      if (c.error || c.status === null) {
        out = { text: `record unavailable: could not run ${o.entry} (${c.error?.message ?? `killed by ${c.signal}`}). Tell the person to open Grove once.`, isError: true };
      } else if (c.status === 0) {
        out = { text: c.stdout.replace(/\n$/, ""), isError: false };
      } else {
        const code2 = Object.keys(EXIT).find((k) => EXIT[k] === c.status) ?? "unavailable";
        out = { text: (c.stderr || c.stdout).replace(/\n$/, "") || `record unavailable: ${o.entry} exited ${c.status}`, isError: true, code: code2 };
      }
    }
    log({ ev: "call", tool: name, via, ms: Number(process.hrtime.bigint() - t0) / 1e6, isError: out.isError });
    return out;
  };
  const toolList = () => {
    if (!isStale()) return mcpToolList();
    const c = child(["tools", "--json"], "");
    try {
      const j = JSON.parse(c.stdout);
      if (Array.isArray(j.tools)) return j.tools;
    } catch {
    }
    return mcpToolList();
  };
  const handle = (msg) => {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return error(null, -32600, "Invalid Request");
    const m = msg;
    if (m.method === void 0 && m.id !== void 0 && (m.result !== void 0 || m.error !== void 0)) return;
    if (typeof m.method !== "string") return error(m.id === void 0 ? null : m.id, -32600, "Invalid Request");
    if (m.id === void 0) return;
    const params = m.params ?? {};
    switch (m.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return reply(m.id, {
          protocolVersion: typeof asked === "string" && KNOWN_PROTOCOLS.includes(asked) ? asked : KNOWN_PROTOCOLS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: SERVER_NAME, version: BUNDLE_VERSION },
          instructions: renderInstructions()
        });
      }
      case "ping":
        return reply(m.id, {});
      case "tools/list":
        return reply(m.id, { tools: toolList() });
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || !name) return error(m.id, -32602, "Unknown tool: (no name)");
        const known = tool(name);
        if (!known && !isStale() || known?.mcp === false) return error(m.id, -32602, `Unknown tool: ${name}`);
        const meta = params._meta ?? {};
        const toolUseId = typeof meta["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] : void 0;
        const out = call(name, params.arguments, toolUseId);
        return reply(m.id, text(out.text, out.isError, out.code));
      }
      default:
        return error(m.id, -32601, `Method not found: ${m.method}`);
    }
  };
  let buf = "";
  o.input.setEncoding("utf8");
  o.input.on("data", (chunk) => {
    buf += chunk;
    for (; ; ) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.trim() === "") continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        error(null, -32700, "Parse error");
        continue;
      }
      try {
        handle(msg);
      } catch (e) {
        const id = msg?.id;
        if (id !== void 0) error(id, -32603, `Internal error: ${e.message}`);
      }
    }
  });
  o.input.on("end", () => {
    log({ ev: "stdin-end" });
    o.exit(0);
  });
  o.output.on("error", () => o.exit(0));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => o.exit(0));
}

// src/cli.ts
function findRoot(flag, env, cwd) {
  if (flag) return import_node_path7.default.resolve(cwd, flag);
  if (env.GROVE_RECORD_ROOT) return import_node_path7.default.resolve(env.GROVE_RECORD_ROOT);
  let dir = import_node_path7.default.resolve(cwd);
  for (; ; ) {
    if (import_node_fs6.default.existsSync(import_node_path7.default.join(dir, PROJECT_FILE))) return dir;
    const up = import_node_path7.default.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}
function takeOption(args, name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return void 0;
  const [, value] = args.splice(i, 2);
  return value;
}
var NO_ROOT = "record unavailable: no Grove project found. Pass --root <dir>, or run this inside a project folder (one that holds .claude/grove-project.json)";
function main(io) {
  const args = [...io.argv];
  const cmd = args.shift();
  const rootFlag = takeOption(args, "--root");
  if (cmd === "mcp") {
    const root = findRoot(rootFlag, io.env, io.cwd) ?? import_node_path7.default.resolve(io.cwd);
    serve({ root, entry: io.entry, env: io.env, input: process.stdin, output: process.stdout, exit: (code2) => process.exit(code2) });
    return -1;
  }
  if (cmd === "state") {
    const hook = takeFlag(args, "--hook");
    const all = takeFlag(args, "--all");
    const root = findRoot(rootFlag, io.env, io.cwd);
    let hookSession;
    if (hook) {
      try {
        const j = JSON.parse(io.stdin());
        if (j && typeof j.session_id === "string") hookSession = j.session_id;
      } catch {
      }
    }
    const r = attempt(() => {
      if (!root) throw new Error(NO_ROOT.replace("record unavailable: ", ""));
      const caller = resolveCaller({ env: io.env, hookSession });
      return { ok: true, text: stateText({ root, caller, env: io.env }, { all }) };
    });
    if (r.ok) {
      io.out(`${r.text}
`);
      return 0;
    }
    const reason = r.text.replace(/^record unavailable: /, "").split(". ")[0];
    if (hook) {
      io.out(`record unavailable: ${reason}. open Grove once
`);
      return 0;
    }
    io.err(`${r.text}
`);
    return EXIT.unavailable;
  }
  if (cmd === "call") {
    const name = args.shift();
    const json = args.shift();
    if (!name || args.length) {
      io.err(`usage: record call <tool> '<json>' [--root <dir>]. the arguments are one JSON object in one single-quoted argument. \`record tools\` lists the tools.
`);
      return EXIT.invalid;
    }
    let raw = {};
    const source = json === "-" ? io.stdin() : json;
    if (source !== void 0 && source.trim() !== "") {
      try {
        raw = JSON.parse(source);
      } catch (e) {
        io.err(`${name}: the arguments are not valid JSON (${e.message}). Pass one JSON object in single quotes, like '{"card":"AUTH-3"}'. Write a ' inside it as '\\''.
`);
        return EXIT.invalid;
      }
    }
    const root = findRoot(rootFlag, io.env, io.cwd);
    if (!root) {
      io.err(`${NO_ROOT}.
`);
      return EXIT.unavailable;
    }
    const r = runTool(name, raw, { root, env: io.env });
    if (r.ok) {
      io.out(`${r.text}
`);
      return 0;
    }
    io.err(`${r.text}
`);
    return EXIT[r.code ?? "unavailable"];
  }
  if (cmd === "tools") {
    io.out(takeFlag(args, "--json") ? `${JSON.stringify({ tools: mcpToolList() }, null, 2)}
` : renderToolList());
    return 0;
  }
  if (cmd === "doctor") return doctor(io, findRoot(rootFlag, io.env, io.cwd));
  if (cmd === "version" || cmd === "--version") {
    io.out(`${BUNDLE_VERSION}
`);
    return 0;
  }
  (cmd === void 0 || cmd === "help" || cmd === "--help" ? io.out : io.err)(renderCliHelp());
  return cmd === void 0 || cmd === "help" || cmd === "--help" ? 0 : EXIT.invalid;
}
function doctor(io, root) {
  let failed = 0;
  const line = (level, what, detail) => {
    if (level === "FAIL") failed++;
    io.out(`${level.padEnd(4)} ${what}: ${detail}
`);
  };
  line("ok", "bundle", `${io.entry} version ${BUNDLE_VERSION}, format ${FORMAT_VERSION}`);
  line(io.env.GROVE_RECORD_BIN ? "ok" : "warn", "launcher", io.env.GROVE_RECORD_BIN || "not run through the launcher (GROVE_RECORD_BIN is not set)");
  line("ok", "runtime", `${process.execPath} node ${process.versions.node}${process.versions.electron ? ` electron ${process.versions.electron}` : ""}`);
  if (!root) line("FAIL", "root", "no project found from here. pass --root <dir>");
  else {
    const project = readProject(root);
    if (!project) line("FAIL", "root", `${root} has no ${PROJECT_FILE}. open Grove once`);
    else if (project.problems.length) line("FAIL", "root", `${root}: ${project.problems.join(", ")}`);
    else {
      line("ok", "root", `${root} prefix ${project.prefix}, ${listCardIds(root).length} cards`);
      const p = paths(root);
      const probe = import_node_path7.default.join(import_node_path7.default.dirname(p.project), `.tmp.doctor.${process.pid}`);
      try {
        import_node_fs6.default.writeFileSync(probe, "x");
        import_node_fs6.default.linkSync(probe, `${probe}.l`);
        line("ok", "filesystem", "hard links work here");
      } catch (e) {
        line("FAIL", "filesystem", `cannot hard link under ${root} (${e.code}). records cannot be published on this volume`);
      } finally {
        for (const f of [probe, `${probe}.l`]) import_node_fs6.default.rmSync(f, { force: true });
      }
      const swept = sweepTemps([p.cards, p.conclusions, ...listCardIds(root).flatMap((id) => [p.comments(id), p.claims(id)])]);
      const indexed = reindex(root);
      line("ok", "upkeep", `${swept} stale temp files removed, ${indexed} index lines added`);
    }
  }
  const c = resolveCaller({ env: io.env });
  if (c.session) line("ok", "session", `${c.session} (from ${c.sessionSource})${c.agent ? ` "${c.agent}"` : ""}`);
  else line("warn", "session", `no Claude session id found (registry ${registryDir(io.env)}, CLAUDE_CODE_SESSION_ID not set). claims need one`);
  if (c.pid) line(procStart(c.pid) ? "ok" : "warn", "process", `claude pid ${c.pid} (from ${c.pidSource}) ${procStart(c.pid) ? `started ${procStart(c.pid)}` : "is not running"}`);
  else line("warn", "process", "no claude process id (CLAUDE_PID not set). claims need one");
  const ps = procStart(process.pid);
  line(ps ? "ok" : "warn", "ps", ps ? "works" : `/bin/ps gave nothing for this process. holders will read as "cannot be checked" (${holderStatus({ session: "x", pid: process.pid, pidStart: "", host: "" }, io.env)})`);
  return failed ? 1 : 0;
}

// src/bin.ts
if (Number(process.versions.node.split(".")[0]) < 22) {
  process.stderr.write(`record unavailable: node ${process.versions.node} is too old (22 or newer is needed). open Grove once
`);
  process.exit(process.argv[2] === "state" ? 0 : 8);
}
var code = main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  entry: import_node_fs7.default.realpathSync(process.argv[1]),
  // never wait on a terminal: `record state --hook` typed by hand has no stdin to read
  stdin: () => process.stdin.isTTY ? "" : import_node_fs7.default.readFileSync(0, "utf8"),
  out: (s) => import_node_fs7.default.writeSync(1, s),
  err: (s) => import_node_fs7.default.writeSync(2, s)
});
if (code >= 0) process.exitCode = code;
