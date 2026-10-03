// node scripts/fuses.mjs <Electron Framework binary> prints its fuses. the launcher runs Grove as
// node, so a build with RunAsNode off breaks every session's record server
import { readFileSync } from "node:fs";
export const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
export const FUSE_NAMES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
];
// the wire is ASCII: "0" off, "1" on, "r" removed
const STATE = { 48: "DISABLE", 49: "ENABLE", 114: "REMOVED", 144: "INHERIT" };
export function readFuses(buf) {
  const out = [];
  const s = Buffer.from(FUSE_SENTINEL, "latin1");
  let i = buf.indexOf(s);
  while (i !== -1) {
    const version = buf[i + s.length];
    const len = buf[i + s.length + 1];
    const wire = buf.subarray(i + s.length + 2, i + s.length + 2 + len);
    const fuses = {};
    wire.forEach((c, k) => {
      fuses[FUSE_NAMES[k] ?? String(k)] = STATE[c] ?? `0x${c.toString(16)}`;
    });
    out.push({ offset: i, version, fuses });
    i = buf.indexOf(s, i + 1);
  }
  return out;
}
// as a script only. vitest imports it with its own argv
if (process.argv[1] === import.meta.filename && process.argv[2]) {
  const t0 = performance.now();
  const r = readFuses(readFileSync(process.argv[2]));
  console.log(JSON.stringify(r), `${(performance.now() - t0).toFixed(0)}ms`);
}
