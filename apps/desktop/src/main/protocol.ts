import { readFile } from "node:fs/promises";
import path from "node:path";
import * as electron from "electron";
import { CSP, contentTypeFor, resolveAssetPath } from "./assets.ts";
import { APP_HOST, APP_SCHEME } from "./origin.ts";

/** before `ready`. standard + secure gives the page a real origin, so 'self' in the CSP means something. */
export function registerAppScheme(): void {
  electron.protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

// a --main-only build has no renderer. an empty page still runs the preload, which is all the
// smoke test and main-process work need.
const NO_RENDERER =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Grove</title></head>' +
  "<body></body></html>";

function respond(status: number, body: BodyInit | null, type: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": type,
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    },
  });
}

/** after `ready`. serves out/renderer and nothing else. */
export function serveRenderer(rendererDir: string): void {
  electron.protocol.handle(APP_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return respond(400, "bad request", "text/plain");
    }
    if (url.host !== APP_HOST) return respond(404, "not found", "text/plain");
    if (request.method !== "GET" && request.method !== "HEAD") {
      return respond(405, "method not allowed", "text/plain");
    }
    const file = resolveAssetPath(rendererDir, url.pathname);
    if (!file) return respond(403, "forbidden", "text/plain");
    try {
      const body = await readFile(file);
      return respond(200, new Uint8Array(body), contentTypeFor(file));
    } catch {
      if (file === path.join(path.resolve(rendererDir), "index.html")) {
        return respond(200, NO_RENDERER, "text/html; charset=utf-8");
      }
      return respond(404, "not found", "text/plain");
    }
  });
}
