// production build, also what the e2e suite runs against. `--main-only` skips the renderer, not
// the record bundle: e2e and dev install it.
import { build } from "esbuild";
import {
  appVersion,
  mainOptions,
  preloadOptions,
  recordOptions,
  viteConfigFile,
} from "./shared.mjs";

const mainOnly = process.argv.includes("--main-only");

await Promise.all([
  build(mainOptions()),
  build(preloadOptions()),
  build(recordOptions(appVersion())),
]);

if (!mainOnly) {
  const { build: viteBuild } = await import("vite");
  await viteBuild({ configFile: viteConfigFile, mode: "production" });
}
