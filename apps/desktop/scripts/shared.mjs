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
    // jsonc-parser's "main" is a umd build whose inner requires esbuild cannot follow
    mainFields: ["module", "main"],
    sourcemap: true,
    logLevel: "info",
  };
}

/**
 * the agent sdk is an es module that calls createRequire(import.meta.url) when it loads. a cjs
 * bundle has no import.meta, so main says where it is. main only: a sandboxed preload cannot
 * require node:url
 */
export const mainOptions = () => ({
  ...nodeBundle("src/main/index.ts", "main/index.cjs"),
  define: { "import.meta.url": "__grove_import_meta_url" },
  banner: {
    js: 'var __grove_import_meta_url = require("node:url").pathToFileURL(__filename).href;',
  },
});
export const preloadOptions = () => nodeBundle("src/preload/index.ts", "preload/index.cjs");
/**
 * the agent zed runs, under whatever `node` zed finds rather than electron, so it needs nothing
 * from the app and runs on an older node. `.cjs`: Resources/ has no package.json to say otherwise
 */
export const acpProxyOptions = () => ({
  ...nodeBundle("src/acp-proxy/main.ts", "acp-proxy/grove-acp.cjs"),
  target: "node20",
  external: [],
});
