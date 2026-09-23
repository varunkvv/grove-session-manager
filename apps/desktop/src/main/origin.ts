export const APP_SCHEME = "app";
export const APP_HOST = "renderer";
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/**
 * electron 44 does not pass nativeTheme.themeSource through to the renderer's
 * prefers-color-scheme, so a pinned appearance is carried on the url instead. it is read before
 * the first render, which a push over ipc could not promise. "system" carries nothing, and the
 * page follows the media query on its own.
 */
export function entryUrl(base: string, appearance: "system" | "light" | "dark"): string {
  return appearance === "system" ? base : `${base}?theme=${appearance}`;
}

/**
 * the only pages allowed to talk to main or to be navigated to: our own scheme and host, or the
 * vite dev server when there is one. `URL.origin` is "null" for a custom scheme, so the
 * pieces are compared instead.
 */
export function isTrustedUrl(url: string | undefined | null, devServerUrl?: string): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === `${APP_SCHEME}:`) return u.host === APP_HOST;
  if (!devServerUrl) return false;
  try {
    const dev = new URL(devServerUrl);
    return u.protocol === dev.protocol && u.host === dev.host;
  } catch {
    return false;
  }
}

/**
 * a link out of the app, from text nobody here wrote: an agent's result, a web page it read. only
 * http(s) leaves, and only as the parsed url - never `file:`, a custom scheme, or anything with
 * credentials in it, which is how a link dresses up as somewhere it is not.
 */
export function externalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || !u.hostname) return null;
  return u.href;
}
