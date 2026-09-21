import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface EnvOptions {
  appRoot?: string;
  claudeConfigDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function getAppRoot(o: EnvOptions = {}): string {
  const env = o.env ?? process.env;
  const raw = o.appRoot || env.GROVE_ROOT || "~/claude-ws";
  return path.resolve(expandHome(raw, o.home));
}

/** cache only. anything in here can be deleted at any time. */
export function getStateDir(appRoot: string): string {
  return path.join(appRoot, ".grove");
}

export function getClaudeConfigDir(o: EnvOptions = {}): string {
  const env = o.env ?? process.env;
  const raw = o.claudeConfigDir || env.CLAUDE_CONFIG_DIR || "~/.claude";
  return path.resolve(expandHome(raw, o.home));
}

export function getProjectsDir(o: EnvOptions = {}): string {
  return path.join(getClaudeConfigDir(o), "projects");
}

function nfc(p: string): string {
  return process.platform === "darwin" ? p.normalize("NFC") : p;
}

/**
 * realpath of the deepest existing ancestor, plus the remainder. never throws.
 * git prints realpaths and Claude slugs realpaths, while stale targets no longer exist,
 * so every path comparison goes through here.
 */
export function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return nfc(rest.length ? path.join(real, ...rest.reverse()) : real);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return nfc(abs);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function samePath(a: string, b: string): boolean {
  return realpathLoose(a) === realpathLoose(b);
}

/** 'same' | 'inside' on a path-component boundary, else null. both sides are realpath'd. */
export function pathRelation(child: string, parent: string): "same" | "inside" | null {
  const c = realpathLoose(child);
  const p = realpathLoose(parent);
  if (c === p) return "same";
  const rel = path.relative(p, c);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return "inside";
}

export function isInside(child: string, parent: string): boolean {
  return pathRelation(child, parent) === "inside";
}
