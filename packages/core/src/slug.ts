const MAX_SLUG = 200;

function hash31(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * the project dir name Claude Code derives from a working directory. byte-identical to the
 * CLI and the VS Code extension (2.1.278). feed it a realpath'd, NFC-normalised path.
 * lossy - never try to go the other way.
 */
export function claudeProjectSlug(cwd: string): string {
  const s = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= MAX_SLUG) return s;
  return `${s.slice(0, MAX_SLUG)}-${Math.abs(hash31(cwd)).toString(36)}`;
}

/**
 * directory name for a combo. restricted to [a-z0-9-] because Claude's slug maps every other
 * character to '-', so 'prod.debug' and 'prod-debug' would share one project dir.
 */
export function comboDirSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}
