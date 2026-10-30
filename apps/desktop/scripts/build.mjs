// production build, also what the e2e suite runs against. `--main-only` skips the renderer.
import { build } from "esbuild";
import { acpProxyOptions, mainOptions, preloadOptions, viteConfigFile } from "./shared.mjs";

const mainOnly = process.argv.includes("--main-only");

await Promise.all([build(mainOptions()), build(preloadOptions()), build(acpProxyOptions())]);

if (!mainOnly) {
  const { build: viteBuild } = await import("vite");
  await viteBuild({ configFile: viteConfigFile, mode: "production" });
}
