import type { ChatTaskView } from "../../shared/ipc.ts";
import { Clock } from "./Live.tsx";
import { Button, Icon, IconButton, Mono, TaskMark } from "./ui.tsx";

const kindWord = (t: ChatTaskView) =>
  t.kind === "command" ? (t.monitor ? "Monitor" : "Command") : t.recurring ? "Repeats" : "Wake-up";

/**
 * the chat's tasks pane: what its claude left running, from its own stream, each the moment it
 * starts. a command or a Monitor runs for as long as its clock says, and stops from here. a
 * wake-up says when it fires: only claude can take one back
 */
export function TasksPane({
  tasks,
  onStop,
  onClose,
}: {
  tasks: readonly ChatTaskView[];
  onStop: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <section
      className="flex min-h-0 w-80 shrink-0 flex-col border-l border-line bg-chrome"
      data-testid="tasks-pane"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="flex-1 font-medium text-fg">Background tasks</h2>
        <IconButton label="Close" onClick={onClose} data-testid="tasks-pane-close">
          <Icon name="x" size={12} />
        </IconButton>
      </div>
      <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {tasks.map((t) => (
          <li key={t.id} data-testid="tasks-pane-row" data-kind={t.kind}>
            <div className="flex items-center gap-2">
              <TaskMark />
              <span className="min-w-0 flex-1 truncate text-fg-2" title={t.description}>
                {t.description}
              </span>
              {t.kind === "command" && (
                <Button
                  size="sm"
                  variant="quiet"
                  data-testid="tasks-pane-stop"
                  title={`Stop ${t.monitor ? "this Monitor" : "this command"}`}
                  onClick={() => onStop(t.id)}
                >
                  Stop
                </Button>
              )}
            </div>
            <div className="flex items-baseline gap-2 pl-4 text-sm text-fg-4">
              <span>{kindWord(t)}</span>
              {t.kind === "command" ? (
                <span className="tabular-nums">
                  <Clock since={t.since} />
                </span>
              ) : (
                t.status && <span>{t.status}</span>
              )}
            </div>
            {t.command && (
              <Mono className="mt-0.5 block truncate pl-4 text-fg-3" title={t.command}>
                {t.command}
              </Mono>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
