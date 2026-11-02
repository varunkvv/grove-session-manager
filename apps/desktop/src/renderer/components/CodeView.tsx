// a text file, read only: line numbers, colour for its language, ⌘F to find. codemirror, not
// monaco: the same for reading at a twentieth of the size, and no editing or workers to open the CSP for
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

const c = (name: string) => `var(--color-${name})`;

const colours = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: c("accent") },
  { tag: [t.string, t.special(t.string), t.regexp], color: c("hue-green") },
  { tag: [t.number, t.bool, t.null, t.atom], color: c("hue-orange") },
  { tag: [t.comment, t.lineComment, t.blockComment], color: c("faint"), fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace], color: c("hue-red") },
  { tag: [t.heading], color: c("accent"), fontWeight: "600" },
  { tag: [t.link, t.url], color: c("accent"), textDecoration: "underline" },
  { tag: [t.invalid], color: c("danger") },
]);

/** a line asked for, by its start: the line is lit, and its class fades out (app.css) */
const flashLine = StateEffect.define<number>();
const flash = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashLine)) {
        deco = Decoration.set([Decoration.line({ class: "cm-flash" }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: c("fg"),
    fontSize: "calc(12px * var(--reading-scale))",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55", overflow: "auto" },
  ".cm-content": { caretColor: "transparent", padding: "0" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: c("faint"),
    border: "none",
    userSelect: "none",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: c("accent-soft"),
  },
  ".cm-selectionMatch": { backgroundColor: c("accent-soft") },
  ".cm-searchMatch": {
    backgroundColor: c("accent-soft"),
    outline: `1px solid ${c("accent-line")}`,
  },
  ".cm-searchMatch-selected": { backgroundColor: c("accent-line") },
  ".cm-panels": { backgroundColor: c("raised"), color: c("fg"), borderColor: c("line") },
  ".cm-panels input, .cm-panels button": { font: "inherit", color: "inherit" },
  ".cm-panels input": {
    backgroundColor: c("canvas"),
    border: `1px solid ${c("line-strong")}`,
    borderRadius: "4px",
    padding: "1px 6px",
  },
  ".cm-panels button": {
    backgroundColor: c("active"),
    border: "none",
    borderRadius: "4px",
    padding: "1px 8px",
    marginLeft: "4px",
  },
});

/** the file's text, read only. the editor stays while the text changes under it */
export function CodeView({ file, text, line }: { file: string; text: string; line?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const first = useRef(text);
  const lang = useRef(new Compartment());

  // one editor per file: another file is a new editor, so its find and scroll start over
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: first.current,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of(searchKeymap),
          syntaxHighlighting(colours),
          lang.current.of([]),
          flash,
          theme,
        ],
      }),
    });
    view.current = v;
    let live = true;
    const found = LanguageDescription.matchFilename(
      languages,
      file.slice(file.lastIndexOf("/") + 1),
    );
    void found?.load().then((support) => {
      if (live) v.dispatch({ effects: lang.current.reconfigure(support) });
    });
    return () => {
      live = false;
      v.destroy();
      view.current = null;
    };
  }, [file]);

  // the file was rewritten: the same editor, the new text. its place is kept where it can be
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === text) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }, [text]);

  // a line asked for: centred, and lit by a class that fades (see app.css). a file shorter than it: nothing.
  // TextFile mounts this per file (it shows a spinner between files), so the line is when, not what
  useEffect(() => {
    const v = view.current;
    if (!v || !line || line > v.state.doc.lines) return;
    const at = v.state.doc.line(line);
    v.dispatch({
      effects: [EditorView.scrollIntoView(at.from, { y: "center" }), flashLine.of(at.from)],
    });
  }, [line]);

  return <div ref={host} className="min-h-0 flex-1 selectable" data-testid="viewer-text" />;
}
