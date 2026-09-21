// vite dev server for the renderer + esbuild watch for main and preload. electron restarts on
// every rebuild, and quitting either side stops the other.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { context } from "esbuild";
import { createServer } from "vite";
import { desktopDir, mainOptions, preloadOptions, viteConfigFile } from "./shared.mjs";

const electronBin = createRequire(import.meta.url)("electron");
const entry = path.join(desktopDir, "out/main/index.cjs");

const server = await createServer({ configFile: viteConfigFile });
await server.listen();
const devUrl = server.resolvedUrls?.local[0] ?? `http://localhost:${server.config.server.port}/`;
console.log(`[dev] renderer at ${devUrl}`);

let child = null;
// an instance that was told to exit. the next one starts when it is gone, because it still
// holds the single-instance lock until then.
let dying = null;
let stopping = false;
let restartTimer = null;
const built = { main: false, preload: false };

function childEnv() {
  const env = { ...process.env, GROVE_DEV_SERVER_URL: devUrl };
  // set when this script is started from an editor's extension host. electron would run as plain node.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function start() {
  const mine = spawn(electronBin, [entry], { stdio: "inherit", env: childEnv() });
  child = mine;
  mine.once("exit", (code) => {
    if (child !== mine) return;
    child = null;
    // the person quit the app
    if (!stopping) void shutdown(code ?? 0);
  });
}

function restart() {
  if (stopping || !built.main || !built.preload || dying) return;
  if (!child) return start();
  dying = child;
  child = null;
  dying.once("exit", () => {
    dying = null;
    if (!stopping) start();
  });
  dying.kill("SIGTERM");
}

function respawnOnEnd(name) {
  return {
    name: `respawn-${name}`,
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        built[name] = true;
        // main and preload usually finish together. one restart for both.
        clearTimeout(restartTimer);
        restartTimer = setTimeout(restart, 120);
      });
    },
  };
}

const contexts = await Promise.all([
  context({ ...mainOptions(), plugins: [respawnOnEnd("main")] }),
  context({ ...preloadOptions(), plugins: [respawnOnEnd("preload")] }),
]);
await Promise.all(contexts.map((c) => c.watch()));

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  child?.kill("SIGTERM");
  dying?.kill("SIGKILL");
  await Promise.allSettled([...contexts.map((c) => c.dispose()), server.close()]);
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void shutdown(0));
