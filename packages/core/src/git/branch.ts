const FORBIDDEN = " ~^:?*[\\";

/**
 * git's check-ref-format rules for a branch name, without spawning git: the renderer uses this
 * while the person types. returns what is wrong, or null.
 *
 * stricter than `git check-ref-format --branch` in one place: that accepts "@", which then
 * resolves to HEAD everywhere a revision is expected.
 */
export function validateBranchName(name: string): string | null {
  if (!name) return "a branch needs a name";
  if (name === "@") return 'a branch cannot be named "@"';
  if (name === "HEAD") return 'a branch cannot be named "HEAD"';
  if (name.startsWith("-")) return 'a branch name cannot start with "-"';
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return "a branch name cannot contain control characters";
    if (ch === " ") return "a branch name cannot contain spaces";
    if (FORBIDDEN.includes(ch)) return `a branch name cannot contain "${ch}"`;
  }
  if (name.includes("..")) return 'a branch name cannot contain ".."';
  if (name.includes("@{")) return 'a branch name cannot contain "@{"';
  if (name.startsWith("/") || name.endsWith("/")) {
    return 'a branch name cannot start or end with "/"';
  }
  if (name.includes("//")) return 'a branch name cannot contain "//"';
  if (name.endsWith(".")) return 'a branch name cannot end with "."';
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return 'no part of a branch name can start with "."';
    if (part.endsWith(".lock")) return 'no part of a branch name can end with ".lock"';
  }
  return null;
}
