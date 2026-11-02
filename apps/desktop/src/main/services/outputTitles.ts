// a title and a line of description for an output that came without one (a claude artifact with
// no title in its call, a slack message, a doc's edit): haiku writes them from the words the call
// was given, through the person's own `claude -p`, at low effort. written once per url and kept.
// nothing reaches a transcript, and nothing is sent unless titles are on.
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isObject, writeFileAtomic } from "@grove/core";
import { log } from "../log.ts";
import { type RunClaude, runClaude } from "./background.ts";
import { recapArgs } from "./recaps.ts";

/** in grove's state dir. safe to delete: the titles are written again, once, the next time they are wanted */
export const OUTPUT_TITLES_FILE = "output-titles.v1.json";
/** the most written, the rest asked for again when they come into sight */
const KEEP = 3000;
/** outputs per call: one call names a few, so a busy session costs one or two calls */
const BATCH = 8;
const TIMEOUT_MS = 60_000;
/** the words a call was given, cut short for the prompt */
const HINT_MAX = 300;

export interface Named {
  title: string;
  description?: string;
  at: number;
}

/** an output that wants a title: its url, and what the call was for */
export interface Ask {
  url: string;
  kind: string;
  label: string;
  hint?: string;
}

export interface OutputTitlesOptions {
  stateDir: string;
  claudeBin: () => Promise<string>;
  env: () => Promise<NodeJS.ProcessEnv>;
  /** the setting that allows haiku to write for the person. read fresh */
  enabled: () => boolean;
  /** a title arrived: the rows that show it are built again */
  onChange: () => void;
  run?: RunClaude;
  now?: () => number;
}

/** what the prompt asks, in the words grove wants back: one json array, nothing around it */
export function titlePrompt(batch: readonly Ask[]): string {
  const items = batch.map((a, i) =>
    [
      `${i + 1}. kind: ${a.label} (${a.kind})`,
      a.hint ? `   words: ${a.hint.replace(/\s+/g, " ").slice(0, HINT_MAX)}` : "   words: none",
    ].join("\n"),
  );
  return [
    "write a short title for each item below: at most six words, lowercase, no period.",
    "and a description: one line on what it is for, or an empty string when the words say nothing more.",
    "the items are things an assistant made for a person. reply with only a json array, nothing else:",
    '[{"n": 1, "title": "...", "description": "..."}]',
    "",
    ...items,
  ].join("\n");
}

/** the array in a reply, by its first `[` and last `]`. null when there is none */
export function parseTitles(
  out: string,
  batch: readonly Ask[],
): Array<{ url: string; title: string; description?: string }> {
  const a = out.indexOf("[");
  const b = out.lastIndexOf("]");
  if (a < 0 || b <= a) return [];
  let v: unknown;
  try {
    v = JSON.parse(out.slice(a, b + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const got: Array<{ url: string; title: string; description?: string }> = [];
  for (const x of v) {
    if (!isObject(x) || typeof x.n !== "number") continue;
    const ask = batch[x.n - 1];
    const title = typeof x.title === "string" ? x.title.trim().slice(0, 80) : "";
    if (!ask || !title) continue;
    const description =
      typeof x.description === "string" && x.description.trim()
        ? x.description.trim().slice(0, 200)
        : undefined;
    got.push({ url: ask.url, title, ...(description ? { description } : {}) });
  }
  return got;
}

export class OutputTitles {
  private readonly o: OutputTitlesOptions;
  private readonly file: string;
  private readonly run: RunClaude;
  private readonly now: () => number;
  private named = new Map<string, Named>();
  /** asked for this run: a url whose call failed is not asked again until the next launch */
  private asked = new Set<string>();
  private queue: Ask[] = [];
  private draining = false;

  constructor(o: OutputTitlesOptions) {
    this.o = o;
    this.file = path.join(o.stateDir, OUTPUT_TITLES_FILE);
    this.run = o.run ?? runClaude;
    this.now = o.now ?? Date.now;
  }

  async load(): Promise<void> {
    try {
      const v = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      if (!isObject(v)) return;
      for (const [url, n] of Object.entries(v)) {
        if (isObject(n) && typeof n.title === "string") {
          this.named.set(url, {
            title: n.title,
            ...(typeof n.description === "string" ? { description: n.description } : {}),
            at: typeof n.at === "number" ? n.at : 0,
          });
        }
      }
    } catch {
      // no file yet, or a torn one: the titles are asked for again
    }
  }

  get(url: string): { title: string; description?: string } | undefined {
    return this.named.get(url);
  }

  /** outputs that came without a title and have none written yet: asked for, a few at a time */
  want(asks: readonly Ask[]): void {
    if (!this.o.enabled()) return;
    for (const a of asks) {
      if (this.named.has(a.url) || this.asked.has(a.url)) continue;
      this.asked.add(a.url);
      this.queue.push(a);
    }
    if (!this.draining && this.queue.length) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length && this.o.enabled()) {
        const batch = this.queue.splice(0, BATCH);
        await this.ask(batch);
      }
    } finally {
      this.draining = false;
    }
  }

  private async ask(batch: Ask[]): Promise<void> {
    // never a repo: a temp dir loads nobody's CLAUDE.md, and no tool is offered
    const cwd = path.join(tmpdir(), "grove-titles");
    await mkdir(cwd, { recursive: true });
    const out = await this.run(await this.o.claudeBin(), recapArgs(), {
      cwd,
      env: await this.o.env(),
      timeoutMs: TIMEOUT_MS,
      input: titlePrompt(batch),
    });
    if (out.code !== 0) {
      log.warn(
        "output titles:",
        `exit ${out.code}`,
        (out.stderr || out.stdout).trim().split("\n")[0] ?? "",
      );
      return;
    }
    const got = parseTitles(out.stdout, batch);
    if (!got.length) {
      log.warn("output titles: not the json array");
      return;
    }
    const at = this.now();
    for (const g of got)
      this.named.set(g.url, {
        title: g.title,
        ...(g.description ? { description: g.description } : {}),
        at,
      });
    await this.save();
    this.o.onChange();
  }

  private async save(): Promise<void> {
    const newest = [...this.named].sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
    this.named = new Map(newest);
    await writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.named)));
  }
}
