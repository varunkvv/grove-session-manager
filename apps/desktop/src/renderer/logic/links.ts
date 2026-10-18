/** only http(s) links go anywhere, and they go to the browser through main */
export function webLink(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * a file an agent's markdown points at, as a path: `/abs`, `file:///abs`, or relative to `base`,
 * the folder the text is from. null for anything with another scheme, a web link among them
 */
export function localPath(href: string | undefined, base: string): string | null {
  if (!href || (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href))) return null;
  try {
    const dir = base.split("/").map(encodeURIComponent).join("/");
    const u = new URL(href, `file://${dir}/`);
    return u.protocol === "file:" && !u.host ? decodeURIComponent(u.pathname) : null;
  } catch {
    return null;
  }
}

/** the folder a file is in */
export const dirOf = (file: string): string => file.slice(0, file.lastIndexOf("/")) || "/";
