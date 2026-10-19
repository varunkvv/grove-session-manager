// shiki, off the page's thread. a fenced block comes in as text and goes back as coloured runs for
// both appearances, in the palette's own pair of themes. the javascript regex engine needs no wasm, so the CSP stays script-src 'self'.
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
  palette: string;
}
export interface HighlightAnswer {
  id: number;
  /** null: a language shiki does not know */
  lines: Run[][] | null;
}

/** each palette's light and dark theme. grove's are github's */
const THEMES = {
  grove: ["github-light", "github-dark"],
  "rose-pine": ["rose-pine-dawn", "rose-pine"],
  solarized: ["solarized-light", "solarized-dark"],
} as const;

const ready: Promise<HighlighterCore> = createHighlighterCore({
  themes: THEMES.grove.map((t) => bundledThemes[t]()),
  langs: [],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});

/** another palette's pair is its own chunk, loaded the first time a block asks for it */
const pairs = new Map<string, Promise<void>>([["grove", Promise.resolve()]]);
function pair(h: HighlighterCore, palette: keyof typeof THEMES): Promise<void> {
  let p = pairs.get(palette);
  if (!p) {
    p = h.loadTheme(...THEMES[palette].map((t) => bundledThemes[t]()));
    pairs.set(palette, p);
  }
  return p;
}

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
  const palette = e.data.palette in THEMES ? (e.data.palette as keyof typeof THEMES) : "grove";
  const [light, dark] = THEMES[palette];
  try {
    const h = await ready;
    if (!(await load(h, lang))) return post({ id, lines: null });
    await pair(h, palette);
    const tokens = h.codeToTokensWithThemes(code, { lang, themes: { light, dark } });
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
