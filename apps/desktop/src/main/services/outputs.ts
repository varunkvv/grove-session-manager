import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  type OutputRules,
  type PrStatus,
  parsePrUrl,
  type SessionOutput,
  type SessionRecord,
  setOutputRules,
} from "@grove/core";
import type { OutputView, PrView, SessionRow } from "../../shared/ipc.ts";
import { log } from "../log.ts";

type PrStatusOf = PrStatus & { checkedAt: number; stale?: true };
type Lookup = (url: string) => PrStatusOf | undefined;

/** the person's own rules, read before the index is made. a missing file is the seed alone */
export function loadOutputRules(stateDir: string, read: (file: string) => string = readText): void {
  const file = path.join(stateDir, "output-rules.json");
  let text: string;
  try {
    text = read(file);
  } catch {
    setOutputRules();
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    const own = parsed as Partial<OutputRules>;
    for (const k of ["hosts", "tools", "bash"] as const) {
      if (own[k] !== undefined && !Array.isArray(own[k])) throw new Error(`${k} is not a list`);
    }
    setOutputRules(own);
  } catch (e) {
    log.warn("output-rules.json, using the seed:", e);
    setOutputRules();
  }
}

function readText(file: string): string {
  return readFileSync(file, "utf8");
}

const births = new Map<string, number>();
/** when the transcript file was made. a fork's first line is its parent's, so this breaks the tie */
function fileBirth(file: string): number {
  let b = births.get(file);
  if (b === undefined) {
    try {
      b = statSync(file).birthtimeMs;
    } catch {
      b = 0;
    }
    births.set(file, b);
  }
  return b;
}

/**
 * by record path, the tool_use ids that an older session also has. a grove fork copies its parent's
 * lines, ids included, so the copy is the newer one. a tie in time (the first line is copied
 * too) goes to the older file
 */
export function inheritedIds(
  records: readonly SessionRecord[],
  birth: (path: string) => number = fileBirth,
): Map<string, Set<string>> {
  const by = new Map<string, SessionRecord[]>();
  for (const r of records) {
    for (const o of r.outputs ?? []) {
      for (const id of new Set([o.id, o.lastId])) if (id) by.set(id, [...(by.get(id) ?? []), r]);
    }
  }
  const older = (a: SessionRecord, b: SessionRecord): number =>
    (a.createdAt ?? a.activityMs) - (b.createdAt ?? b.activityMs) ||
    birth(a.path) - birth(b.path) ||
    (a.path < b.path ? -1 : 1);
  const out = new Map<string, Set<string>>();
  for (const [id, owners] of by) {
    if (owners.length < 2) continue;
    const first = owners.reduce((a, b) => (older(b, a) < 0 ? b : a));
    for (const r of owners) {
      if (r === first) continue;
      const set = out.get(r.path) ?? new Set<string>();
      set.add(id);
      out.set(r.path, set);
    }
  }
  return out;
}

function prViewOf(o: SessionOutput, status: PrStatusOf | undefined): PrView | undefined {
  const ref = o.kind === "pr" ? parsePrUrl(o.url) : null;
  if (!ref) return undefined;
  const view: PrView = { url: o.url, number: ref.number, repo: `${ref.owner}/${ref.repo}` };
  if (!status) return view;
  const { title, state, review, rollup, updatedAt, checkedAt, stale } = status;
  return {
    ...view,
    title,
    state,
    ...(review ? { review } : {}),
    ...(rollup ? { rollup } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    checkedAt,
    ...(stale ? { stale } : {}),
  };
}

/**
 * every record's outputs as rows have them: a jira site any record learned filled in, github's
 * word on a PR joined, a fork's copies marked
 */
export function outputViews(
  records: readonly SessionRecord[],
  prStatus?: Lookup,
): Map<string, OutputView[]> {
  const sites = Object.assign({}, ...records.map((r) => r.sites ?? {})) as Record<string, string>;
  const inherited = inheritedIds(records);
  const views = new Map<string, OutputView[]>();
  for (const r of records) {
    if (!r.outputs?.length) continue;
    views.set(
      r.path,
      r.outputs.map((o) => {
        const site = o.need ? sites[o.need] : undefined;
        const url = o.need
          ? site
            ? o.url.replace("{site}", site.replace(/\/+$/, ""))
            : undefined
          : o.url;
        const pr = url ? prViewOf({ ...o, url }, prStatus?.(url)) : undefined;
        return {
          ...(url ? { url } : {}),
          kind: o.kind,
          label: o.label,
          ...(o.key ? { key: o.key } : {}),
          ...(o.title ? { title: o.title } : {}),
          verb: o.verb,
          first: o.first,
          last: o.last,
          touches: o.touches,
          ...(o.agent ? { agent: o.agent } : {}),
          ...(pr ? { pr } : {}),
          // copied from an older session, and not touched since by this one's own calls
          ...(o.id &&
          inherited.get(r.path)?.has(o.id) &&
          inherited.get(r.path)?.has(o.lastId ?? o.id)
            ? { inherited: true as const }
            : {}),
        };
      }),
    );
  }
  return views;
}

/** the github.com PRs of rows that are live or were active lately: what PrService asks github about */
export function prWants(
  rows: readonly SessionRow[],
  now: number,
  recentMs: number,
  busy: (r: SessionRow) => boolean,
): Array<{ url: string; working: boolean }> {
  return rows
    .filter((r) => r.outputs?.length && (r.live || now - r.activityMs < recentMs))
    .flatMap((r) =>
      (r.outputs ?? []).flatMap((o) =>
        o.pr && parsePrUrl(o.pr.url)?.host === "github.com"
          ? [{ url: o.pr.url, working: busy(r) }]
          : [],
      ),
    );
}
