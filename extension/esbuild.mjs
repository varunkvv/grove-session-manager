import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const production = process.argv.includes("--production");

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  // the engines floor (VS Code 1.94 ships node 20). downlevelling costs nothing.
  target: "node20",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});

// the desktop app ships the vsix and reads this to tell "missing" from "outdated"
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("dist", { recursive: true });
writeFileSync(
  "dist/manifest.json",
  `${JSON.stringify({ id: `${pkg.publisher}.${pkg.name}`, version: pkg.version, file: "grove-companion.vsix" }, null, 2)}\n`,
);
