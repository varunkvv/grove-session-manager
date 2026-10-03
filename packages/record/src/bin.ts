// entry of the bundle: record <command>. see cli.ts.
import fs from "node:fs";
import { main } from "./cli.ts";

const code = main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  entry: fs.realpathSync(process.argv[1]!),
  // never wait on a terminal: `record state --hook` typed by hand has no stdin to read
  stdin: () => (process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8")),
  out: (s) => fs.writeSync(1, s),
  err: (s) => fs.writeSync(2, s),
});
if (code >= 0) process.exitCode = code;
