import { readFileSync } from "node:fs";
import path from "node:path";

export const desktopDir = path.resolve(import.meta.dirname, "..");
export const outDir = path.join(desktopDir, "out");
export const viteConfigFile = path.join(desktopDir, "vite.config.ts");

/**
 * main and preload are each ONE cjs file. @grove/core is TypeScript source and gets
 * bundled in. electron is the only thing left to require at runtime, which is also all a
 * sandboxed preload is allowed to require.
 */
function nodeBundle(entry, outfile) {
  return {
    entryPoints: [path.join(desktopDir, entry)],
    outfile: path.join(outDir, outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  };
}

export const mainOptions = () => nodeBundle("src/main/index.ts", "main/index.cjs");
export const preloadOptions = () => nodeBundle("src/preload/index.ts", "preload/index.cjs");

/** the bundle's banner version. CI sets GROVE_APP_VERSION on a release, the same number it packages with */
export const appVersion = () =>
  process.env.GROVE_APP_VERSION ||
  JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8")).version;

/**
 * the record's CLI and MCP server as one cjs file. the app copies it to <appRoot>/.grove/bin/ and
 * sessions run it through the launcher, on Grove's own binary as node or on a node from PATH.
 */
export const recordOptions = (version) => ({
  entryPoints: [path.join(desktopDir, "../../packages/record/src/bin.ts")],
  outfile: path.join(outDir, "record", "record.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  // the launcher's node fallback runs it on node 22 or newer
  target: "node22",
  // installRecordRuntime reads the version from this line
  banner: { js: `// grove-record app=${version}` },
  // the GROVE_RECORD_* identity overrides are for tests. compiled out of the shipped bundle
  define: { "process.env.GROVE_RECORD_TEST": '"0"' },
  // copied out of the app and run by sessions. a map would carry the build machine's paths
  sourcemap: false,
  logLevel: "info",
});
