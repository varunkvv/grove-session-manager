import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { needsYouCount, projectRows } from "../logic/views.ts";
import { focusScreen, go, newProject, switchProject } from "../state/actions.ts";
import { type Section, useStore } from "../state/store.ts";
import { cx, Dot, GroveMark, Icon, Kbd, menuItemClass, Overlay } from "./ui.tsx";

/**
 * which project is on screen, and where another project's needs show: a question in project B must
 * not be invisible while the window is on A.
 */
function ProjectSwitcher() {
  const projects = useStore((s) => s.projects);
  const project = useStore((s) => s.project);
  const inbox = useStore((s) => s.inbox);
  const open = useStore((s) => s.overlay === "switcher");
  const set = useStore((s) => s.set);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** the keyboard's item: a project by index, or `projects.length` for New project… */
  const [at, setAt] = useState(0);

  const current = projects.find((p) => p.id === project);
  const failed = (id: string) => projects.find((p) => p.id === id)?.server.state === "failed";
  const elsewhere = projects.some(
    (p) => p.id !== project && (needsYouCount(inbox, p.id) > 0 || failed(p.id)),
  );

  // main still notifies while the window is focused when the row is in another project
  useEffect(() => {
    const tell = () => void window.grove.setVisibleProject(project);
    tell();
    const onShow = () => document.visibilityState === "visible" && tell();
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [project]);

  useEffect(() => {
    if (open) menu.current?.focus();
  }, [open]);

  const close = () => {
    set({ overlay: null });
    focusScreen();
  };
  const pick = (i: number) => {
    set({ overlay: null });
    const p = projects[i];
    if (p) switchProject(p.id);
    else newProject();
    focusScreen();
  };
  const onKey = (e: KeyboardEvent) => {
    const last = projects.length;
    const next = {
      ArrowDown: Math.min(last, at + 1),
      ArrowUp: Math.max(0, at - 1),
      Home: 0,
      End: last,
    }[e.key];
    if (next !== undefined) setAt(next);
    else if (e.key === "Enter") pick(at);
    else if (e.key === "Escape") close();
    else return;
    e.stopPropagation();
    e.preventDefault();
  };

  const rect = open ? button.current?.getBoundingClientRect() : undefined;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="no-drag fade flex h-7 max-w-[240px] items-center gap-1.5 rounded-md px-2 text-body font-medium text-fg hover:bg-active"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="project-switcher"
        onClick={() => {
          // with no project the screen is already the form
          if (!current) return;
          setAt(projects.indexOf(current));
          set({ overlay: open ? null : "switcher" });
        }}
      >
        <GroveMark size={12} />
        <span className="truncate">{current?.name ?? "New project"}</span>
        {elsewhere && <Dot label="Another project needs you" />}
        <Icon name="chevron" size={8} faint className="rotate-90" />
      </button>
      <Overlay
        open={open}
        onClose={close}
        style={{ top: (rect?.bottom ?? 40) + 4, left: rect?.left ?? 84 }}
        className="w-[208px] p-1"
        testId="project-menu"
      >
        {/* the ring would go round the whole menu: its active item says where the keyboard is */}
        <div role="menu" ref={menu} tabIndex={-1} onKeyDown={onKey} style={{ outline: "none" }}>
          {projects.map((p, i) => {
            const count = needsYouCount(inbox, p.id);
            return (
              <div
                key={p.id}
                role="menuitemradio"
                aria-checked={p.id === project}
                className={menuItemClass}
                data-active={i === at || undefined}
                data-testid="project-item"
                data-id={p.id}
                data-count={count}
                onMouseMove={() => setAt(i)}
                onClick={() => pick(i)}
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {failed(p.id) ? (
                  <span title="Agents cannot reach the record" className="flex text-danger">
                    <Icon name="warning" size={11} />
                  </span>
                ) : (
                  count > 0 && <span className="text-sm tabular-nums text-fg-4">{count}</span>
                )}
                {p.id === project && <Icon name="check" size={10} className="text-fg-3" />}
              </div>
            );
          })}
          <div className="my-1 h-px bg-line" />
          <div
            role="menuitem"
            className={menuItemClass}
            data-active={at === projects.length || undefined}
            data-testid="new-project"
            onMouseMove={() => setAt(projects.length)}
            onClick={() => pick(projects.length)}
          >
            New project…
          </div>
        </div>
      </Overlay>
    </>
  );
}

function NavItem({ section, label, count }: { section: Section; label: string; count?: number }) {
  // a card keeps the section it was opened from, Edit project keeps Cards, New project has none
  const active = useStore((s) => s.section === section && s.view.name !== "new-project");
  return (
    <button
      type="button"
      className={cx(
        "no-drag fade flex h-7 items-center gap-1.5 rounded-md px-2 text-body",
        active ? "bg-active font-medium text-fg" : "text-fg-3 hover:bg-raised hover:text-fg",
      )}
      aria-current={active ? "page" : undefined}
      data-testid={`nav-${section}`}
      onClick={() => {
        go(section);
        focusScreen();
      }}
    >
      {label}
      {count ? (
        <span className="text-sm tabular-nums text-fg-4" data-testid="inbox-count">
          {count}
        </span>
      ) : null}
    </button>
  );
}

export function TopBar() {
  const mac = useStore((s) => s.env?.platform === "darwin");
  const project = useStore((s) => s.project);
  // every row of this project, Asked to Finished: the window is a reading list, the tray an alarm
  const inboxCount = useStore((s) => projectRows(s.inbox, s.project).length);
  return (
    <header
      className={cx(
        "drag flex h-11 shrink-0 items-center gap-0 border-b border-line bg-chrome pr-4",
        // what the traffic lights need: they start at 16 and are 52 wide
        mac ? "pl-[84px]" : "pl-4",
      )}
      data-testid="top-bar"
    >
      <ProjectSwitcher />
      {project && (
        <>
          <span className="mx-2 h-4 w-px shrink-0 bg-line-strong" aria-hidden="true" />
          <nav aria-label="Main" className="flex items-center gap-0.5">
            <NavItem section="inbox" label="Inbox" count={inboxCount} />
            <NavItem section="cards" label="Cards" />
            <NavItem section="conclusions" label="Conclusions" />
          </nav>
        </>
      )}
      <span className="flex-1" />
      <button
        type="button"
        className="no-drag fade flex h-7 items-center rounded-md px-1.5 hover:bg-raised"
        aria-label="Open the command palette"
        title="Go to, switch project or find a session"
        onClick={() => useStore.getState().set({ overlay: "palette" })}
        data-testid="open-palette"
      >
        <Kbd>⌘K</Kbd>
      </button>
    </header>
  );
}
