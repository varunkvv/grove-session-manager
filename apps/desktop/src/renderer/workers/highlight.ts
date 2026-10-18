// shiki, off the page's thread. a fenced block comes in as text and goes back as coloured runs for
// both appearances. the javascript regex engine needs no wasm, so the CSP stays script-src 'self'.
// each language is its own chunk, loaded the first time a block asks for it.
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";

/** a run of text and its colour, light and dark */
export type Run = [text: string, light: string, dark: string];
export interface HighlightAsk {
  id: number;
  lang: string;
  code: string;
}
export interface HighlightAnswer {
  id: number;
  /** null: a language shiki does not know */
  lines: Run[][] | null;
}

const LIGHT = "github-light";
const DARK = "github-dark";

const ready: Promise<HighlighterCore> = createHighlighterCore({
  themes: [bundledThemes[LIGHT](), bundledThemes[DARK]()],
  langs: [],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});

const loaded = new Map<string, Promise<boolean>>();
function load(h: HighlighterCore, lang: string): Promise<boolean> {
  let p = loaded.get(lang);
  if (!p) {
    const grammar = (bundledLanguages as Record<string, (() => Promise<unknown>) | undefined>)[
      lang
    ];
    p = grammar
      ? h.loadLanguage(grammar() as Parameters<HighlighterCore["loadLanguage"]>[0]).then(
          () => true,
          () => false,
        )
      : Promise.resolve(false);
    loaded.set(lang, p);
  }
  return p;
}

const post = (a: HighlightAnswer) => (self as unknown as Worker).postMessage(a);

self.onmessage = async (e: MessageEvent<HighlightAsk>) => {
  const { id, code } = e.data;
  const lang = e.data.lang.toLowerCase();
  try {
    const h = await ready;
    if (!(await load(h, lang))) return post({ id, lines: null });
    const tokens = h.codeToTokensWithThemes(code, { lang, themes: { light: LIGHT, dark: DARK } });
    const lines = tokens.map((line) => {
      const runs: Run[] = [];
      for (const t of line) {
        const light = t.variants.light?.color ?? "";
        const dark = t.variants.dark?.color ?? "";
        const last = runs.at(-1);
        if (last && last[1] === light && last[2] === dark) last[0] += t.content;
        else runs.push([t.content, light, dark]);
      }
      return runs;
    });
    post({ id, lines });
  } catch {
    post({ id, lines: null });
  }
};
