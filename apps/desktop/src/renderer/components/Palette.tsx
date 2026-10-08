import { tokenize } from "@grove/core/pure";
import { type KeyboardEvent, useEffect, useState } from "react";
import type { SessionHit } from "../../shared/ipc.ts";
import { type PaletteItem, paletteItems } from "../logic/palette.ts";
import { focusScreen, go, openWith, report, startAgent, switchProject } from "../state/actions.ts";
import { currentProject, useStore } from "../state/store.ts";
import { cx, Highlighted, Icon, Kbd, menuItemClass, Overlay, Time } from "./ui.tsx";

/** its own prefix: aria-activedescendant must never name a list row behind the overlay */
const domId = (id: string) => `palette-${id}`;

/** mounted only while it is open, so every open starts empty with the first item active */
function Open() {
  // the inbox is every project's: nothing there is `This project`
  const project = useStore((s) => (s.view.name === "inbox" ? null : (currentProject(s) ?? null)));
  const projects = useStore((s) => s.projects);
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  const [query, setQuery] = useState("");
  /** the keyboard's item by id. null, or one that left the list, is the first item */
  const [at, setAt] = useState<string | null>(null);
  const [sessions, setSessions] = useState<{ query: string; hits: SessionHit[] }>();

  const words = tokenize(query);
  const typed = words.length > 0;
  const { sections, none } = paletteItems({ project, projects, editor, sessions }, query);
  const items = sections.flatMap((s) => s.items);
  const active = items.find((i) => i.id === at) ?? items[0];

  // sessions are main's: asked 80ms after the last keystroke. an answer for an older query is dropped
  useEffect(() => {
    if (!typed) return;
    let stale = false;
    const timer = setTimeout(async () => {
      // a search that failed is an answer with nothing in it, or `No matches.` would never show
      const hits = await window.grove.findSessions(query).catch(() => []);
      if (!stale) setSessions({ query, hits });
    }, 80);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, typed]);

  const close = () => {
    useStore.getState().set({ overlay: null });
    focusScreen();
  };

  const run = (item: PaletteItem) => {
    const { set, toast } = useStore.getState();
    // `project:{id}`, `session:{key}`
    const cut = item.id.indexOf(":");
    const name = cut < 0 ? item.id : item.id.slice(0, cut);
    const arg = item.id.slice(cut + 1);
    const p = project;
    switch (name) {
      case "go-inbox":
        go("inbox");
        break;
      case "project":
        switchProject(arg);
        break;
      case "session":
        if (item.hit) openWith(item.hit.key, item.hit.open, item.hit.title);
        break;
      // a dialog takes the keyboard itself
      case "settings":
        return set({ overlay: null, dialog: { kind: "settings" } });
    }
    // the rows of `This project`
    if (p) {
      switch (name) {
        case "start-editor":
          void startAgent({ project: p.id, where: "editor" });
          break;
        case "start-background":
          void startAgent({ project: p.id, where: "background" });
          break;
        case "long-work": {
          const next = p.longWork === "background" ? "foreground" : "background";
          void window.grove.setLongWork(p.id, next).then((res) => {
            if (!report("Could not change that", res)) return;
            const where = next === "background" ? "background" : "conversation";
            toast({ level: "info", title: `Long work runs in the ${where} in ${p.name}` });
          });
          break;
        }
        case "repair":
          // main says what it did to each working copy
          void window.grove
            .repairProject(p.id)
            .then((res) => report("Could not repair the working copies", res));
          break;
        case "delete-project":
          return set({ overlay: null, dialog: { kind: "delete", project: p.id } });
      }
    }
    close();
  };

  const onKey = (e: KeyboardEvent) => {
    const i = active ? items.indexOf(active) : -1;
    const next = { ArrowDown: Math.min(items.length - 1, i + 1), ArrowUp: Math.max(0, i - 1) }[
      e.key
    ];
    if (next !== undefined) {
      const to = items[next];
      if (to) {
        setAt(to.id);
        document.getElementById(domId(to.id))?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter") {
      // an Enter that ends an IME composition picks a candidate, not an item
      if (active && !e.nativeEvent.isComposing) run(active);
    } else if (e.key === "Escape") close();
    else if (e.key !== "Tab") return;
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <Overlay
      open
      onClose={close}
      testId="palette"
      className="w-[560px] overflow-hidden"
      style={{ top: 72, left: "50%", transform: "translateX(-50%)" }}
    >
      <input
        data-palette-input
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-activedescendant={active && domId(active.id)}
        aria-label="Go to, switch project or find a session"
        autoFocus
        spellCheck={false}
        className="h-11 w-full border-b border-line bg-transparent px-4 text-body text-fg placeholder:text-fg-4"
        placeholder="Go to, switch project or find a session"
        data-testid="palette-input"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          // typing puts the keyboard back on the best match
          setAt(null);
        }}
        onKeyDown={onKey}
      />
      <div
        id="palette-list"
        role="listbox"
        // the scroll padding keeps a section's label above its first row, and the last row off the edge
        className="max-h-[420px] scroll-pt-9 scroll-pb-1.5 overflow-y-auto p-1.5"
        data-testid="palette-list"
        // a click on a label or between rows must not take the keyboard out of the field
        onMouseDown={(e) => e.preventDefault()}
      >
        {sections.map((s) => (
          <div role="group" aria-label={s.label} key={s.label} data-testid="palette-section">
            <div className="px-2 pt-2 pb-1 text-meta text-fg-4">{s.label}</div>
            {s.items.map((i) => (
              <div
                key={i.id}
                id={domId(i.id)}
                role="option"
                aria-selected={i === active}
                data-active={i === active || undefined}
                // a snippet is a second line, under everything: the row grows
                className={cx(menuItemClass, i.hit?.snippet && "h-auto! flex-wrap gap-y-0 py-1.5")}
                data-testid="palette-item"
                data-id={i.id}
                onMouseMove={() => setAt(i.id)}
                onClick={() => run(i)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {i.hit ? <Highlighted text={i.label} tokens={words} /> : i.label}
                </span>
                {i.kbd && <Kbd>{i.kbd}</Kbd>}
                {i.current && <Icon name="check" size={10} className="text-fg-3" />}
                {i.hit && (
                  <>
                    <span className="max-w-[160px] shrink-0 truncate text-sm text-fg-3">
                      {i.hit.where}
                    </span>
                    <Time at={i.hit.activityMs} />
                  </>
                )}
                {i.hit?.snippet && (
                  // the words were found in what was said, not in the title: this line is why it is here
                  <span className="w-full truncate text-sm text-fg-3">
                    <Highlighted text={i.hit.snippet} tokens={words} />
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
        {none && (
          <p className="px-2 py-3 text-sm text-fg-4" data-testid="palette-empty">
            No matches.
          </p>
        )}
      </div>
    </Overlay>
  );
}

/** cmd-K: go to, switch project, what the screens have no button for, and every session */
export function Palette() {
  const open = useStore((s) => s.overlay === "palette");
  return open ? <Open /> : null;
}
