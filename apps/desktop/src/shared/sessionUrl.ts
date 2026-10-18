// a session's file as a grove chat window loads it. main serves these only from under the
// session's folders (main/sessionFiles.ts). no node or electron here: the page builds them.

/** images, drawn through <img>: an svg's scripts never run there */
export const FILE_SCHEME = "grove-file";
/** html pages, only ever in a sandboxed iframe with no way back to grove */
export const HTML_SCHEME = "grove-html";

/** `<scheme>://<session id>/<path>`. `v` is a reload: the same file, written again */
export function sessionUrl(scheme: string, sessionId: string, file: string, v = 0): string {
  const at = file.split("/").map(encodeURIComponent).join("/");
  return `${scheme}://${sessionId}${at}${v ? `?v=${v}` : ""}`;
}
