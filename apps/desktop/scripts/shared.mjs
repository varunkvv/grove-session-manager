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
