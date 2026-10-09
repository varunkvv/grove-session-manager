import { useEffect, useState } from "react";
import type { ProjectView } from "../../shared/ipc.ts";
import { needsYouCount, startBlocked } from "../logic/views.ts";
import {
  focusScreen,
  go,
  goUsage,
  newProject,
  newSession,
  switchProject,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Icon, IconButton, ProjectMark, SideGroup, SideItem } from "./ui.tsx";

/**
 * All sessions, which is every project's, and under it the projects. each says how many of its
 * sessions need the person: a session in project B must not be invisible while the window is on A.
 * the projects keep the order of combos.json, so nothing moves as counts change. the archived ones
 * are under them, folded away
 */
export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view.name);
  const inbox = useStore((s) => s.inbox);
  const toast = useStore((s) => s.toast);
  // a project is on screen with its sessions, and with its form
  const shown = view === "sessions" || view === "edit-project" ? project : null;
  const archived = projects.filter((p) => p.archived);
  const [opened, setOpened] = useState(false);
  // open by itself while the project on screen is one of them: its row is what says where he is
  const open = opened || archived.some((p) => p.id === shown);

  const item = (p: ProjectView) => (
    <SideItem
      key={p.id}
      id={p.id}
      selected={p.id === shown}
      mark={<ProjectMark id={p.id} />}
      label={p.name}
      count={needsYouCount(inbox, p.id)}
      testId="project-item"
      quiet={p.archived}
      onClick={() => {
        switchProject(p.id);
        focusScreen();
      }}
      // the top bar's New session, without the trip to it. it never starts what is known to fail.
      // an archived project has no New session there, and none here
      onDoubleClick={
        p.archived
          ? undefined
          : () => {
              const blocked = startBlocked(p);
              if (!blocked) return newSession(p.id);
              toast({
                level: "error",
                title: `Could not start a session in ${p.name}`,
                body: blocked.line,
              });
            }
      }
    />
  );

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
      aria-label="All sessions and projects"
      className="flex w-[220px] shrink-0 flex-col border-r border-line bg-chrome"
      data-testid="sidebar"
    >
      {/* the traffic lights sit in it, and the window is dragged by it */}
      <div className="drag h-11 shrink-0" />
      <div className="space-y-px px-2">
        <SideItem
          selected={view === "inbox"}
          mark={<Icon name="inbox" size={14} />}
          label="All sessions"
          // only the ones that need him, like the tray and the dock
          count={inbox.rows.length}
          testId="nav-inbox"
          onClick={() => {
            go("inbox");
            focusScreen();
          }}
        />
        {/* not a project and not a list: no count, and nothing to start with a double-click */}
        <SideItem
          selected={view === "usage"}
          mark={<Icon name="chart" size={14} />}
          label="Usage"
          testId="nav-usage"
          onClick={goUsage}
        />
      </div>
      <div className="mt-4 flex h-7 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="text-sm font-medium text-fg-4">Projects</span>
        <IconButton label="New project" onClick={newProject} data-testid="new-project">
          <Icon name="plus" size={12} />
        </IconButton>
      </div>
      {/* many projects scroll here, under an All sessions that stays put */}
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3" data-testid="projects">
        {projects.filter((p) => !p.archived).map(item)}
        {archived.length > 0 && (
          <div className="space-y-px pt-3" data-testid="archived">
            <SideGroup
              label="Archived"
              n={archived.length}
              count={archived.reduce((n, p) => n + needsYouCount(inbox, p.id), 0)}
              open={open}
              onToggle={() => setOpened(!open)}
              testId="archived-toggle"
            />
            {open && archived.map(item)}
          </div>
        )}
      </div>
    </nav>
  );
}
