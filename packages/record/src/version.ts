/** the package version. grove compares these to decide whether the bundle on disk is older than its own. */
export const BUNDLE_VERSION = "0.2.0";

/** written as `v:` in every record. a reader that meets a higher number reads what it can and says so. */
export const FORMAT_VERSION = 1;

/** the MCP server name, so tools read mcp__grove__<tool>. */
export const SERVER_NAME = "grove";

/** a.b.c compare. -1, 0, 1. anything unparseable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * the GROVE_RECORD_SESSION / _PID / _AGENT / _ACTOR / _REGISTRY overrides exist for tests only. the
 * shipped bundle is built with --define:process.env.GROVE_RECORD_TEST='"0"', so esbuild compiles them
 * out and no agent can switch them on from a shell. read here, at call time, never cached.
 */
export function testOverrides(): boolean {
  return process.env.GROVE_RECORD_TEST === "1";
}
