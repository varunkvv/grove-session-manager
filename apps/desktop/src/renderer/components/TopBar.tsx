import { startBlocked } from "../logic/views.ts";
import { editProject, newSession, openProject } from "../state/actions.ts";
import { currentProject, useStore } from "../state/store.ts";
import { Button, Icon, Kbd, ProjectMark } from "./ui.tsx";

/**
 * what the screen beside the sidebar is, and what can be done with all of it: a search of its
 * sessions, and for a project its window in the editor and a new session in it
 */
export function TopBar() {
  const view = useStore((s) => s.view.name);
  // the home screen is every project's, and a form says its own
  const project = useStore((s) => (s.view.name === "sessions" ? currentProject(s) : undefined));
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  const filter = useStore((s) => s.filter);
  const set = useStore((s) => s.set);
  // it never offers a start that is known to fail
  const blocked = project && startBlocked(project);
  return (
    <header
      className="@container drag flex h-11 shrink-0 items-center gap-2 border-b border-line bg-chrome px-4"
      data-testid="top-bar"
    >
      {view === "inbox" && <h1 className="shrink-0 font-medium">All sessions</h1>}
      {project && (
        <>
          <ProjectMark id={project.id} />
          <h1
            className="min-w-[48px] shrink truncate font-medium"
            // what the project is for, when its form says
            title={project.goal ? `${project.name}: ${project.goal}` : project.name}
            data-testid="project-name"
          >
            {project.name}
          </h1>
        </>
      )}
      {(view === "inbox" || project) && (
        // the sessions of the list under it: every one on the home screen, a project's on its own
        <input
          id="search"
          aria-label={project ? `Search the sessions in ${project.name}` : "Search every session"}
          spellCheck={false}
          // a field like the forms', a row lower. it takes the room that is left, up to 220, so
          // the project's name is only cut once the field is at its smallest: in the narrowest
          // window that is a name past 16 letters. its placeholder is one word, to be whole there
          className="no-drag ml-2 h-7 max-w-[220px] min-w-[64px] flex-1 rounded-md border border-line-strong bg-canvas px-2.5 text-body text-fg placeholder:text-fg-4"
          placeholder="Search"
          data-testid="session-filter"
          value={filter}
          onChange={(e) => set({ filter: e.target.value })}
        />
      )}
      {/* an auto margin, not a growing spacer: it gets what the search leaves, never half of it */}
      <span className="ml-auto" />
      {project && (
        <>
          {/* a new conversation in the editor, where the ask is typed. a background one is in cmd-K */}
          <Button
            variant="quiet"
            size="sm"
            disabled={!!blocked}
            title={blocked?.line ?? `A new conversation in ${project.name}, in ${editor}`}
            onClick={() => newSession(project.id)}
            data-testid="new-session"
          >
            <Icon name="plus" size={10} />
            New session
          </Button>
          {/* the project's window in the editor. cmd-O does the same */}
          <Button
            size="sm"
            title={`Open ${project.name} in ${editor}`}
            onClick={() => void openProject(project.id)}
            data-testid="open-project"
          >
            Open in {editor}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            title={`Edit ${project.name}`}
            onClick={editProject}
            data-testid="edit-project"
          >
            Edit
          </Button>
        </>
      )}
      <button
        type="button"
        className="no-drag fade flex h-7 shrink-0 items-center rounded-md px-1.5 hover:bg-raised"
        aria-label="Open the command palette"
        title="Go to a project or find a session"
        onClick={() => set({ overlay: "palette" })}
        data-testid="open-palette"
      >
        <Kbd>⌘K</Kbd>
      </button>
    </header>
  );
}
