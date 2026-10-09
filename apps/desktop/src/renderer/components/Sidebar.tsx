import { useEffect } from "react";
import { needsYouCount, startBlocked } from "../logic/views.ts";
import { focusScreen, go, newProject, newSession, switchProject } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Icon, IconButton, ProjectMark, SideItem } from "./ui.tsx";

/**
 * the inbox, which is every project's, and under it the projects with how many of their sessions
 * need the person: a session in project B must not be invisible while the window is on A. the
 * projects keep the order of combos.json, so nothing moves as counts change
 */
export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view.name);
  const inbox = useStore((s) => s.inbox);
  const toast = useStore((s) => s.toast);
  // a project is on screen with its sessions, and with its form
  const shown = view === "sessions" || view === "edit-project" ? project : null;

  // while the window has focus main holds back the notifications about what it already shows
  useEffect(() => {
    const tell = () => void window.grove.setVisibleProject(shown, view === "inbox");
    tell();
    const onShow = () => document.visibilityState === "visible" && tell();
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [shown, view]);

  return (
    <nav
      aria-label="Inbox and projects"
      className="flex w-[220px] shrink-0 flex-col border-r border-line bg-chrome"
      data-testid="sidebar"
    >
      {/* the traffic lights sit in it, and the window is dragged by it */}
      <div className="drag h-11 shrink-0" />
      <div className="px-2">
        <SideItem
          selected={view === "inbox"}
          mark={<Icon name="inbox" size={14} />}
          label="Inbox"
          count={inbox.rows.length}
          testId="nav-inbox"
          onClick={() => {
            go("inbox");
            focusScreen();
          }}
        />
      </div>
      <div className="mt-4 flex h-7 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="text-sm font-medium text-fg-4">Projects</span>
        <IconButton label="New project" onClick={newProject} data-testid="new-project">
          <Icon name="plus" size={12} />
        </IconButton>
      </div>
      {/* many projects scroll here, under an inbox that stays put */}
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3" data-testid="projects">
        {projects.map((p) => (
          <SideItem
            key={p.id}
            id={p.id}
            selected={p.id === shown}
            mark={<ProjectMark id={p.id} />}
            label={p.name}
            count={needsYouCount(inbox, p.id)}
            testId="project-item"
            onClick={() => {
              switchProject(p.id);
              focusScreen();
            }}
            // the top bar's New session, without the trip to it. it never starts what is known to fail
            onDoubleClick={() => {
              const blocked = startBlocked(p);
              if (!blocked) return newSession(p.id);
              toast({
                level: "error",
                title: `Could not start a session in ${p.name}`,
                body: blocked.line,
              });
            }}
          />
        ))}
      </div>
    </nav>
  );
}
