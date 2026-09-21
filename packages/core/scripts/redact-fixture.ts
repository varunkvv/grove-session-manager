// turns a real transcript into a committable fixture: structure kept, every piece of text replaced.
//   node packages/core/scripts/redact-fixture.ts <transcript.jsonl> <name> [--out dir]
//
// allowlist based. every string becomes ASCII filler with the same JSON-encoded byte length, so
// each line keeps its exact size and the byte offsets that matter (a title at 50,840 bytes, a
// head that ends mid-line) survive. files over 128KiB keep only what a head + tail read can see.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeProjectSlug } from "../src/slug.ts";

const CHUNK = 65536;
const [src, nameArg, ...rest] = process.argv.slice(2);
if (!src || !nameArg) {
  console.error("usage: redact-fixture.ts <transcript.jsonl> <name> [--out dir]");
  process.exit(2);
}
const name: string = nameArg;
const outRoot =
  rest[0] === "--out" && rest[1]
    ? rest[1]
    : path.join(import.meta.dirname, "../test/fixtures/projects");

// string values that describe structure, not content
const KEEP_VALUES_FOR_KEYS = new Set([
  "type",
  "subtype",
  "role",
  "entrypoint",
  "userType",
  "version",
  "operation",
  "mode",
  "permissionMode",
  "stop_reason",
  "level",
  "kind",
  "promptSource",
  "turnOrigin",
  "timestamp",
  "model",
  "requestShape",
]);
const TITLE_KEYS = new Set(["aiTitle", "customTitle", "agentName", "lastPrompt", "summary", "tag"]);
const KEEP_LITERALS = new Set(["HEAD", ".invalid", "main", "master"]);
const MARKERS = [
  "<ide_opened_file>",
  "<ide_selection>",
  "<system-reminder>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "Caveat:",
  "[Request interrupted",
];

const encodedLen = (s: string) => Buffer.byteLength(JSON.stringify(s)) - 2;
const filler = (len: number, seed = "x") => (seed + "x".repeat(len)).slice(0, Math.max(0, len));

const digest = createHash("sha1").update(name).digest("hex");
const fakeId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4000-8000-${digest.slice(12, 24)}`;
const titles = new Map<string, string>();
let fakeCwd: string | undefined;
const replaced = new Set<string>();
const kept = new Set<string>();

function redactString(key: string, value: string): string {
  if (KEEP_VALUES_FOR_KEYS.has(key) || KEEP_LITERALS.has(value)) {
    kept.add(value);
    return value;
  }
  if (key === "sessionId" || key === "session_id") return fakeId;
  const len = encodedLen(value);
  if (key === "cwd") {
    fakeCwd ??= `/fixture/${filler(Math.max(1, len - 9), name.replace(/[^a-z0-9]/gi, ""))}`;
    return value.length === encodedLen(fakeCwd) ? fakeCwd : filler(len, "/");
  }
  // only prose and paths are worth a leak check. bare identifiers (tool ids, key names) also
  // show up as object keys, which are structure.
  if (value.length >= 12 && /[\s/]/.test(value)) replaced.add(value);
  if (TITLE_KEYS.has(key)) {
    if (!titles.has(value)) titles.set(value, filler(len, `Title ${titles.size + 1} `));
    return titles.get(value)!;
  }
  // command envelopes keep their shape and the command name. nothing else.
  const cmd = /^<command-name>\s*(\/?[\w:-]+)\s*<\/command-name>/.exec(value);
  if (cmd) {
    const head = `<command-name>${cmd[1]}</command-name>`;
    return head + filler(len - head.length, "\n".length === 1 ? " " : " ");
  }
  for (const m of MARKERS) {
    if (value.startsWith(m)) return m + filler(len - m.length);
  }
  return filler(len);
}

function redact(value: unknown, key = ""): unknown {
  if (typeof value === "string") return redactString(key, value);
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // object keys can be file paths (file history) or model names
      const safeKey = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k) ? k : filler(encodedLen(k), "k");
      out[safeKey] = redact(v, k);
    }
    return out;
  }
  return value;
}

function visibleLines(buf: Buffer): { head: string[]; tail: string[]; cut: boolean } {
  if (buf.length <= CHUNK * 2)
    return { head: buf.toString("utf8").split("\n").filter(Boolean), tail: [], cut: false };
  // whole lines that start inside the first chunk, and whole lines inside the last chunk
  const text = buf.toString("utf8");
  const lines = text.split("\n").filter(Boolean);
  const head: string[] = [];
  let offset = 0;
  for (const l of lines) {
    if (offset >= CHUNK) break;
    head.push(l);
    offset += Buffer.byteLength(l) + 1;
  }
  const tail: string[] = [];
  let back = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const size = Buffer.byteLength(lines[i]!) + 1;
    if (back + size > CHUNK) break;
    tail.unshift(lines[i]!);
    back += size;
  }
  return { head, tail, cut: true };
}

const source = readFileSync(src);
const { head, tail, cut } = visibleLines(source);
const redactLine = (line: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return filler(Buffer.byteLength(line), "?");
  }
  const out = JSON.stringify(redact(parsed));
  if (Buffer.byteLength(out) !== Buffer.byteLength(JSON.stringify(parsed))) {
    throw new Error(
      `line length changed: ${Buffer.byteLength(JSON.stringify(parsed))} -> ${Buffer.byteLength(out)}`,
    );
  }
  return out;
};

const outLines = head.map(redactLine);
if (cut) {
  // stands in for the unread middle of the file. keeps the fixture over 128KiB so the tail path runs.
  const middle = Math.max(
    1024,
    CHUNK * 2 + 4096 - Buffer.byteLength(head.join("\n")) - Buffer.byteLength(tail.join("\n")),
  );
  outLines.push(
    JSON.stringify({
      type: "attachment",
      attachment: { type: "redacted-middle", data: filler(middle) },
    }),
  );
  outLines.push(...tail.map(redactLine));
}
const output = `${outLines.join("\n")}\n`;

for (const original of replaced) {
  // a value kept under a structural key (a model name) may also appear under another key
  if ([...kept].some((k) => k.includes(original))) continue;
  if (output.includes(original))
    throw new Error(`leak: ${JSON.stringify(original.slice(0, 40))} survived redaction`);
}

const projectDir = path.join(outRoot, claudeProjectSlug(fakeCwd ?? `/fixture/${name}`));
mkdirSync(projectDir, { recursive: true });
const dest = path.join(projectDir, `${fakeId}.jsonl`);
writeFileSync(dest, output);

const sidecar = path.join(path.dirname(src), path.basename(src, ".jsonl"), "custom-title.json");
if (existsSync(sidecar)) {
  const t = JSON.parse(readFileSync(sidecar, "utf8")).customTitle;
  const fake =
    typeof t === "string" ? (titles.get(t) ?? filler(encodedLen(t), "Title 0 ")) : "Title 0";
  mkdirSync(path.join(projectDir, fakeId), { recursive: true });
  writeFileSync(
    path.join(projectDir, fakeId, "custom-title.json"),
    JSON.stringify({ customTitle: fake }),
  );
}

console.log(
  `${dest}\n  ${source.length} -> ${Buffer.byteLength(output)} bytes, ${outLines.length} lines, ${titles.size} distinct titles, cut=${cut}`,
);
