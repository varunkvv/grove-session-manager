import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TextSink } from "./usage.ts";

/** a very long session keeps its first few MB searchable. past that the text is not kept. */
const MAX_CHARS = 4_000_000;

interface Doc {
  text: string;
  lower: string;
}

/**
 * the searchable text of every session, one file per transcript under the cache dir, plus the
 * same in memory once something asks. files only grow, like the transcripts they come from.
 */
export class TextStore {
  private readonly dir: string | null;
  private readonly docs = new Map<string, Doc>();
  private readonly loaded = new Set<string>();

  constructor(dir: string | null) {
    this.dir = dir;
  }

  private fileFor(transcript: string): string | null {
    if (!this.dir) return null;
    const h = createHash("sha1").update(transcript).digest("hex").slice(0, 20);
    return path.join(this.dir, `${h}.txt`);
  }

  /** reads the stored text into memory, once. returns its length in chars. */
  async ensure(transcript: string): Promise<number> {
    if (!this.loaded.has(transcript)) {
      this.loaded.add(transcript);
      const file = this.fileFor(transcript);
      if (file) {
        try {
          const text = await readFile(file, "utf8");
          this.docs.set(transcript, { text, lower: text.toLowerCase() });
        } catch {
          // never scanned, or the cache was cleared
        }
      }
    }
    return this.docs.get(transcript)?.text.length ?? 0;
  }

  get(transcript: string): Doc | undefined {
    return this.docs.get(transcript);
  }

  /** collects one scan's text, and lands it when the scan is done */
  sink(transcript: string): TextSink & { commit(): Promise<number> } {
    let reset = false;
    const parts: string[] = [];
    return {
      reset: () => {
        reset = true;
        parts.length = 0;
      },
      push: (t) => {
        parts.push(t);
      },
      commit: async () => {
        const before = reset ? "" : (this.docs.get(transcript)?.text ?? "");
        const room = Math.max(0, MAX_CHARS - before.length);
        const added = parts.length ? `${parts.join("\n")}\n`.slice(0, room) : "";
        const text = before + added;
        this.docs.set(transcript, { text, lower: text.toLowerCase() });
        this.loaded.add(transcript);
        const file = this.fileFor(transcript);
        if (file && (reset || added)) {
          await mkdir(path.dirname(file), { recursive: true });
          if (reset) await writeFile(file, text);
          else await appendFile(file, added);
        }
        return text.length;
      },
    };
  }

  async remove(transcript: string): Promise<void> {
    this.docs.delete(transcript);
    this.loaded.delete(transcript);
    const file = this.fileFor(transcript);
    if (file) await unlink(file).catch(() => {});
  }

  /** text files for transcripts that no longer exist */
  async sweep(keep: Iterable<string>): Promise<void> {
    if (!this.dir) return;
    const wanted = new Set([...keep].map((t) => path.basename(this.fileFor(t) ?? "")));
    try {
      for (const name of await readdir(this.dir)) {
        if (name.endsWith(".txt") && !wanted.has(name)) {
          await unlink(path.join(this.dir, name)).catch(() => {});
        }
      }
    } catch {
      // no text dir yet
    }
  }
}

/** at most this much comes before the match: a row cuts at its end, and the match must show */
const LEAD = 24;

/**
 * the part of a long text around the first token found, for the second line of a row. it starts
 * where the match's own line does when that is near, else a few words before it.
 */
export function textSnippet(doc: Doc, tokens: readonly string[], radius = 60): string | undefined {
  // a few characters change length when lowercased. then offsets do not line up, so cut the lowercase.
  const source = doc.lower.length === doc.text.length ? doc.text : doc.lower;
  for (const t of tokens) {
    const i = doc.lower.indexOf(t);
    if (i < 0) continue;
    const line = doc.lower.lastIndexOf("\n", i - 1) + 1;
    let start = i - line <= radius ? line : i - LEAD;
    if (start > line) {
      const space = source.indexOf(" ", start);
      if (space >= 0 && space < i) start = space + 1;
    }
    const end = Math.min(source.length, i + t.length + radius);
    const body = source.slice(start, end).replace(/\s+/g, " ").trim();
    return `${start > 0 ? "…" : ""}${body}${end < source.length ? "…" : ""}`;
  }
  return undefined;
}
