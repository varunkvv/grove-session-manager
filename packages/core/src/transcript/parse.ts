import { isObject } from "../fsx.ts";
import type { ParsedMeta, PrLink } from "../types.ts";
import { extractCommand, extractUserText } from "./prompt.ts";
import { PROMPT_MAX, squash, TITLE_MAX } from "./title.ts";

/** bump when parsing changes what ends up in the cache. it is part of the cache filename. */
export const PARSER_VERSION = 1;

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/**
 * Claude Code reads .git/HEAD itself. a detached checkout gives "HEAD" and a reftable repo
 * gives ".invalid" (the stub ref git writes there). neither is a branch worth showing.
 */
function branch(v: unknown): string | undefined {
  const b = str(v);
  return b === "HEAD" || b === ".invalid" ? undefined : b;
}

function time(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

/** every complete line that parses as a JSON object. garbage lines are skipped, never fatal. */
export function parseLines(chunk: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of chunk.split("\n")) {
    if (line.length < 2 || line.charCodeAt(0) !== 0x7b) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObject(v)) out.push(v);
    } catch {
      // partial line at a chunk edge, or junk. the rest of the file still counts.
    }
  }
  return out;
}

interface TitleFields {
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  summary?: string;
  lastPrompt?: string;
  tag?: string;
  pr?: PrLink;
  relocatedCwd?: string;
  gitBranch?: string;
  lastActivityMs?: number;
}

/** metadata records are appended again and again through the file. the last one wins. */
function liftRecords(entries: Record<string, unknown>[]): TitleFields {
  const f: TitleFields = {};
  for (const e of entries) {
    switch (e.type) {
      case "custom-title":
        f.customTitle = str(e.customTitle) ?? f.customTitle;
        break;
      case "agent-name":
        f.agentName = str(e.agentName) ?? f.agentName;
        break;
      case "ai-title":
        f.aiTitle = str(e.aiTitle) ?? f.aiTitle;
        break;
      case "summary":
        f.summary = str(e.summary) ?? f.summary;
        break;
      case "last-prompt":
        // CLI sessions open with lastPrompt: null as a reset marker. null is not a title.
        f.lastPrompt = str(e.lastPrompt) ?? f.lastPrompt;
        break;
      case "tag":
        f.tag = str(e.tag) ?? f.tag;
        break;
      case "relocated":
        f.relocatedCwd = str(e.relocatedCwd) ?? f.relocatedCwd;
        break;
      case "pr-link":
        if (typeof e.prNumber === "number") {
          f.pr = { number: e.prNumber, url: str(e.prUrl), repo: str(e.prRepository) };
        }
        break;
      case "user":
      case "assistant": {
        const ms = time(e.timestamp);
        if (ms !== undefined && ms > (f.lastActivityMs ?? 0)) f.lastActivityMs = ms;
        break;
      }
    }
    f.gitBranch = branch(e.gitBranch) ?? f.gitBranch;
  }
  return f;
}

/**
 * head + tail chunks -> metadata. `tail` is null when the head is the whole file.
 * every field is optional and nothing here throws: if the shape moves we still list the file.
 */
export function parseTranscript(
  head: string,
  tail: string | null,
  sidecarTitle?: string,
): ParsedMeta {
  const headEntries = parseLines(head);
  const tailEntries = tail === null ? headEntries : parseLines(tail);
  const meta: ParsedMeta = {
    recognized: headEntries.length + (tail === null ? 0 : tailEntries.length),
  };

  // first value wins in the head: cwd drifts wildly later in a session
  let headBranch: string | undefined;
  for (const e of headEntries) {
    meta.sessionId ??= str(e.sessionId);
    meta.cwd ??= str(e.cwd);
    meta.version ??= str(e.version);
    meta.entrypoint ??= str(e.entrypoint);
    meta.createdAt ??= time(e.timestamp);
    headBranch ??= branch(e.gitBranch);
    if (meta.firstPrompt === undefined) {
      const text = extractUserText(e);
      if (text) meta.firstPrompt = squash(text, PROMPT_MAX);
    }
    if (meta.firstCommand === undefined) {
      const cmd = extractCommand(e);
      if (cmd) meta.firstCommand = squash(cmd, TITLE_MAX);
    }
  }

  // a cloud-teleport marker with no conversation behind it. only flagged on a positive match,
  // so a format change can never hide real sessions.
  const all = tail === null ? headEntries : [...headEntries, ...tailEntries];
  if (all.length > 0 && all.every((e) => e.type === "teleported-from")) meta.stub = true;

  const h = liftRecords(headEntries);
  const t = tail === null ? h : liftRecords(tailEntries);

  meta.customTitle = t.customTitle ?? str(sidecarTitle) ?? h.customTitle;
  meta.agentName = t.agentName ?? h.agentName;
  meta.aiTitle = t.aiTitle ?? h.aiTitle;
  meta.summary = t.summary ?? h.summary;
  meta.tag = t.tag ?? h.tag;
  meta.pr = t.pr ?? h.pr;
  meta.relocatedCwd = t.relocatedCwd ?? h.relocatedCwd;
  meta.gitBranch = t.gitBranch ?? headBranch;
  meta.lastActivityMs = t.lastActivityMs ?? h.lastActivityMs;
  const lastPrompt = t.lastPrompt ?? h.lastPrompt;
  if (lastPrompt) meta.lastPrompt = squash(lastPrompt, PROMPT_MAX);

  for (const key of Object.keys(meta) as (keyof ParsedMeta)[]) {
    if (meta[key] === undefined) delete meta[key];
  }
  return meta;
}
