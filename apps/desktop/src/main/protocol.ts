import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import * as electron from "electron";
import { FILE_SCHEME, HTML_SCHEME } from "../shared/sessionUrl.ts";
import { CSP, contentTypeFor, resolveAssetPath } from "./assets.ts";
import { APP_HOST, APP_SCHEME } from "./origin.ts";
import { byteRange, sessionFileOf, within } from "./sessionFiles.ts";

/**
 * before `ready`, and only once. standard + secure gives the page a real origin, so 'self' in the
 * CSP means something. the session schemes are grove chat's: images and videos, and html in the
 * sandbox. `stream` lets a video play from them, a piece at a time
 */
export function registerAppScheme(): void {
  electron.protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, stream: true } },
    { scheme: HTML_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ]);
}

// a --main-only build has no renderer. an empty page still runs the preload, which is all the
// smoke test and main-process work need.
const NO_RENDERER =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Grove</title></head>' +
  "<body></body></html>";

function respond(
  status: number,
  body: BodyInit | null,
  type: string,
  csp = CSP,
  more: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": type,
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
      ...more,
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

const MEDIA = new Set([
  ...[".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
  ...[".mp4", ".mov", ".m4v", ".webm"],
]);

/** an image is only ever an <img>, a video a <video>. this is for one opened any other way */
const MEDIA_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/**
 * a page an agent wrote, in a sandboxed iframe with an opaque origin and no preload. it may pull in
 * what a mockup does from the web (scripts, styles, fonts, images) and its own files beside it. it
 * talks to nothing: no fetch, no forms
 */
export const HTML_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' https: ${HTML_SCHEME}:`,
  `style-src 'unsafe-inline' https: ${HTML_SCHEME}:`,
  `img-src https: data: blob: ${HTML_SCHEME}:`,
  `font-src https: data: ${HTML_SCHEME}:`,
  `media-src https: data: ${HTML_SCHEME}:`,
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * after `ready`. a chat window's images, videos and html pages: `<scheme>://<session id>/<path>`,
 * served only from under the folders `rootsOf` gives that session, which is none unless its window
 * is open. read as it is sent, and in the pieces a `range` asks for: a video seeks with those
 */
export function serveSessionFiles(rootsOf: (sessionId: string) => Promise<string[] | null>): void {
  const serve = (scheme: string, csp: string, only?: ReadonlySet<string>) =>
    electron.protocol.handle(scheme, async (request) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return respond(405, "method not allowed", "text/plain", csp);
      }
      const at = sessionFileOf(request.url);
      if (!at) return respond(400, "bad request", "text/plain", csp);
      if (only && !only.has(path.extname(at.file).toLowerCase())) {
        return respond(403, "forbidden", "text/plain", csp);
      }
      const roots = await rootsOf(at.sessionId);
      const file = roots && (await within(roots, at.file));
      if (!file) return respond(404, "not found", "text/plain", csp);
      const size = await stat(file).then(
        (s) => (s.isFile() ? s.size : null),
        () => null,
      );
      if (size === null) return respond(404, "not found", "text/plain", csp);
      const range = byteRange(request.headers.get("range"), size);
      if (range === null) {
        return respond(416, null, "text/plain", csp, { "content-range": `bytes */${size}` });
      }
      const { start, end } = range ?? { start: 0, end: size - 1 };
      // an empty file has no bytes to stream: start 0, end -1
      const body =
        request.method === "HEAD" || end < start
          ? null
          : (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream);
      return respond(range ? 206 : 200, body, contentTypeFor(file), csp, {
        "accept-ranges": "bytes",
        "content-length": String(end - start + 1),
        ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      });
    });
  serve(FILE_SCHEME, MEDIA_CSP, MEDIA);
  serve(HTML_SCHEME, HTML_CSP);
}
