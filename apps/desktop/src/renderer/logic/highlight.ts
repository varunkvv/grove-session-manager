// the page's side of the highlighter: one worker, started the first time a chat window shows code,
// and the answers kept so a block drawn again is coloured at once.
import type { HighlightAnswer, Run } from "../workers/highlight.ts";

export type { Run };

/** past this a block is drawn as it is: a whole file pasted into a fence */
const MAX = 200_000;
// ponytail: the answers kept are counted, not weighed. 300 of up to 200KB each is a ceiling of
// tens of MB in a window open for days. a byte budget if that ever shows
const KEEP = 300;

let worker: Worker | null = null;
let next = 0;
const waiting = new Map<number, (lines: Run[][] | null) => void>();
const done = new Map<string, Run[][] | null>();

const keyOf = (lang: string, code: string, palette: string) => `${palette}\0${lang}\0${code}`;

/** what is known already: the runs, null for a language with none, undefined when not asked yet */
export function highlighted(
  lang: string,
  code: string,
  palette: string,
): Run[][] | null | undefined {
  if (code.length > MAX) return null;
  return done.get(keyOf(lang, code, palette));
}

/** in the palette's own code colours */
export function highlight(lang: string, code: string, palette: string): Promise<Run[][] | null> {
  const known = highlighted(lang, code, palette);
  if (known !== undefined) return Promise.resolve(known);
  if (!worker) {
    worker = new Worker(new URL("../workers/highlight.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<HighlightAnswer>) => {
      waiting.get(e.data.id)?.(e.data.lines);
      waiting.delete(e.data.id);
    };
  }
  const id = ++next;
  worker.postMessage({ id, lang, code, palette });
  return new Promise((resolve) => {
    waiting.set(id, (lines) => {
      done.set(keyOf(lang, code, palette), lines);
      // the oldest answer goes first
      if (done.size > KEEP) done.delete(done.keys().next().value as string);
      resolve(lines);
    });
  });
}
