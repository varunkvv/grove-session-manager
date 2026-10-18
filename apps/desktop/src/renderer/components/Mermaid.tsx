// a mermaid diagram from an agent's markdown. mermaid is its own chunk, loaded the first time a
// chat window shows a mermaid fence. strict: labels are text, nothing in a diagram can be clicked
// or run. the svg it draws goes into an <img>, never into the page, so nothing in it runs either.
// that is also why labels are svg text: an <img> draws no html inside an svg.
import { useEffect, useState, useSyncExternalStore } from "react";

type Mermaid = typeof import("mermaid").default;

let loaded: Promise<Mermaid> | null = null;
/** one diagram at a time: mermaid draws in a scratch element of the page */
let queue: Promise<unknown> = Promise.resolve();
let n = 0;
const drawn = new Map<string, string | null>();

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

/** a token of app.css, as the page resolves it now: light or dark */
function token(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(--color-${name})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

/**
 * grove's own grounds, lines and words, so a diagram looks like the page it is in. no accent: a
 * box in a diagram is not something to press or a turn to take
 */
const themeOf = (dark: boolean) => ({
  darkMode: dark,
  background: token("canvas"),
  primaryColor: token("raised"),
  primaryBorderColor: token("line-strong"),
  primaryTextColor: token("fg"),
  secondaryColor: token("chrome"),
  tertiaryColor: token("canvas"),
  lineColor: token("fg-4"),
  textColor: token("fg-2"),
});

export const isDark = (): boolean => {
  const pinned = document.documentElement.dataset.theme;
  return pinned ? pinned === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

/** the appearance moved: pinned in Settings, or macOS at sunset */
function onLook(changed: () => void): () => void {
  const system = matchMedia("(prefers-color-scheme: dark)");
  system.addEventListener("change", changed);
  const pinned = new MutationObserver(changed);
  pinned.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    system.removeEventListener("change", changed);
    pinned.disconnect();
  };
}

/** an svg as an <img> can show it: a size of its own, from its viewBox */
function asImage(svg: string): string {
  const box = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  const sized = box
    ? svg.replace(/<svg([^>]*?) width="[^"]*"/, `<svg$1 width="${box[1]}" height="${box[2]}"`)
    : svg;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
}

function draw(code: string, dark: boolean): Promise<string | null> {
  const key = `${dark}\0${code}`;
  if (drawn.has(key)) return Promise.resolve(drawn.get(key) ?? null);
  loaded ??= import("mermaid").then((m) => m.default);
  const run = queue.then(async () => {
    const mermaid = await loaded;
    if (!mermaid) return null;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: { ...themeOf(dark), fontFamily: FONT, fontSize: "13px" },
      fontFamily: FONT,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // the page has one shadow, and it is an overlay's
      themeCSS: "* { filter: none !important; }",
    });
    try {
      const { svg } = await mermaid.render(`grove-mermaid-${++n}`, code);
      return asImage(svg);
    } catch {
      return null;
    } finally {
      // a failed render leaves its scratch element behind
      document.getElementById(`dgrove-mermaid-${n}`)?.remove();
    }
  });
  queue = run;
  return run.then((url) => {
    drawn.set(key, url);
    return url;
  });
}

export function MermaidDiagram({ code }: { code: string }) {
  // drawn again in the other appearance's colours when it flips
  const dark = useSyncExternalStore(onLook, isDark);
  const [got, setGot] = useState<{ code: string; dark: boolean; url: string | null }>();
  useEffect(() => {
    let live = true;
    // a fence still being streamed changes every frame: it is drawn once it holds still
    const soon = setTimeout(() => {
      void draw(code, dark).then((url) => live && setGot({ code, dark, url }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(soon);
    };
  }, [code, dark]);
  // the last drawing stays while the next is made, so a diagram being written never blinks
  if (got?.url) {
    return <img className="md-diagram" src={got.url} alt="Diagram" data-testid="diagram" />;
  }
  return (
    <code data-lang="mermaid">
      {code}
      {got && got.code === code && (
        <span className="md-alt block font-sans">Could not draw this diagram.</span>
      )}
    </code>
  );
}
