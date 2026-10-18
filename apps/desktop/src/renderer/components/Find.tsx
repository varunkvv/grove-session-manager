// grove chat's ⌘F: find words in the conversation on screen. the matches are painted with the css
// highlight api, so nothing in the page is rewritten and the answer's own markup is left alone.
import { type RefObject, useEffect, useRef, useState } from "react";
import { Icon, IconButton } from "./ui.tsx";

/** every place the words are, as ranges over the text under `root`, case left aside */
export function findRanges(root: Node, query: string): Range[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? "").toLowerCase();
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + q.length);
      out.push(r);
    }
  }
  return out;
}

/**
 * the find bar under the header: what to find, which match of how many, up and down, Esc. it
 * looks again when the conversation moves (`rev`), so a match in a new answer is found too
 */
export function FindBar({
  root,
  rev,
  asked,
  onClose,
}: {
  root: RefObject<HTMLElement | null>;
  /** the conversation moved: look again */
  rev: unknown;
  /** bumped by each ⌘F: the keyboard goes back to the field, its words selected */
  asked: number;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [ranges, setRanges] = useState<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);
  // ⌘F again while open: back to the field, its words selected
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked is when, not what
  useEffect(() => {
    input.current?.select();
  }, [asked]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev is when, not what
  useEffect(() => {
    setRanges(root.current ? findRanges(root.current, query) : []);
  }, [query, rev, root]);
  const n = ranges.length;
  const current = n ? ranges[Math.min(at, n - 1)] : undefined;
  useEffect(() => {
    const hl = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!hl || !H) return;
    hl.set("find", new H(...ranges));
    if (current) {
      hl.set("find-current", new H(current));
      current.startContainer.parentElement?.scrollIntoView({ block: "center" });
    } else hl.delete("find-current");
    return () => {
      hl.delete("find");
      hl.delete("find-current");
    };
  }, [ranges, current]);
  const step = (d: 1 | -1) => n && setAt((Math.min(at, n - 1) + d + n) % n);
  return (
    <div
      className="no-drag absolute top-14 right-3 z-30 flex h-9 items-center gap-1 rounded-lg border border-line-strong bg-overlay pr-1 pl-3 overlay-shadow"
      data-testid="find"
    >
      <input
        ref={input}
        autoFocus
        data-palette-input
        aria-label="Find in the conversation"
        placeholder="Find"
        data-testid="find-input"
        className="h-full w-44 bg-transparent text-body text-fg placeholder:text-fg-4"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="w-14 text-right text-sm tabular-nums text-fg-4" data-testid="find-count">
        {query ? (n ? `${Math.min(at, n - 1) + 1} of ${n}` : "None") : ""}
      </span>
      <IconButton label="Previous (⇧↩)" onClick={() => step(-1)} data-testid="find-prev">
        <Icon name="chevron" size={10} className="-rotate-90" />
      </IconButton>
      <IconButton label="Next (↩)" onClick={() => step(1)} data-testid="find-next">
        <Icon name="chevron" size={10} className="rotate-90" />
      </IconButton>
      <IconButton label="Close (esc)" onClick={onClose} data-testid="find-close">
        <Icon name="x" size={11} />
      </IconButton>
    </div>
  );
}
