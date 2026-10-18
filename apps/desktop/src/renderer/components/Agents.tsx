// grove chat's subagents: a list in the drawer beside the conversation, and one agent's own
// transcript in the viewer half, drawn with the same turn as the session's own. the agent tree's
// words and look (context/agent-tree.md): Running / Done 4m / Failed / Stopped.
import { formatDuration, type TurnView } from "@grove/core/pure";
import { useEffect, useState } from "react";
import type { ChatAgent } from "../../shared/ipc.ts";
import { QUIET, Turn } from "./SessionPanel.tsx";
import { AgentState, Button, Icon, IconButton, Spinner } from "./ui.tsx";

const api = () => window.grove;

/** how long it has run, or ran */
const tookOf = (a: ChatAgent, now: number) => formatDuration((a.ended ?? now) - a.since);

function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** every agent of the session, running ones first */
export function AgentList({
  agents,
  onOpen,
  onStop,
  onClose,
}: {
  agents: readonly ChatAgent[] | undefined;
  onOpen: (id: string) => void;
  onStop: (id: string) => void;
  onClose: () => void;
}) {
  const now = useNow(!!agents?.some((a) => a.state === "running"));
  return (
    <section
      className="flex min-h-0 w-72 shrink-0 flex-col border-l border-line bg-chrome"
      data-testid="agents"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="flex-1 font-medium text-fg">Agents</h2>
        <IconButton label="Close" onClick={onClose} data-testid="agents-close">
          <Icon name="x" size={12} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {agents === undefined && <Spinner />}
        {agents?.length === 0 && <p className="px-2 py-1 text-sm text-fg-4">No agents yet.</p>}
        {agents?.map((a) => (
          <div key={a.id} className="group relative">
            <button
              type="button"
              data-testid="agent-row"
              data-id={a.id}
              onClick={() => onOpen(a.id)}
              className="fade flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-raised"
            >
              <span className="truncate pr-12 text-fg" title={a.description}>
                {a.description}
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                <AgentState state={a.state} took={tookOf(a, now)} />
                {a.step && (
                  <span className="min-w-0 truncate text-sm text-fg-4" title={a.step}>
                    · {a.step}
                  </span>
                )}
              </span>
            </button>
            {a.state === "running" && (
              <Button
                size="sm"
                variant="quiet"
                className="absolute top-1 right-1"
                data-testid="agent-stop"
                title="Stop this agent. The session goes on"
                onClick={() => onStop(a.id)}
              >
                Stop
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** one agent's own transcript: what it was asked, its steps (open), what it came back with */
export function AgentViewer({
  agent,
  onList,
  onClose,
  onStop,
}: {
  agent: ChatAgent;
  onList: () => void;
  onClose: () => void;
  onStop: () => void;
}) {
  /** null: its transcript is not there (yet) */
  const [turn, setTurn] = useState<TurnView | null>();
  const running = agent.state === "running";
  const now = useNow(running);
  // read again every couple of seconds while it runs: its transcript moves, the session's does not
  useEffect(() => {
    let live = true;
    const read = () =>
      void api()
        .chatAgent(agent.id)
        .then((t) => live && setTurn(t));
    read();
    const t = running ? setInterval(read, 2000) : undefined;
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [agent.id, running]);
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-line"
      data-testid="agent-viewer"
      data-id={agent.id}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-3">
        <IconButton label="All agents" onClick={onList} data-testid="agent-list">
          <Icon name="chevron" size={12} className="rotate-180" />
        </IconButton>
        <span className="min-w-0 flex-1 truncate font-medium text-fg" title={agent.description}>
          {agent.description}
        </span>
        <AgentState state={agent.state} took={tookOf(agent, now)} />
        {running && (
          <Button size="sm" variant="quiet" data-testid="agent-viewer-stop" onClick={onStop}>
            Stop
          </Button>
        )}
        <IconButton label="Close" onClick={onClose} data-testid="agent-viewer-close">
          <Icon name="x" size={12} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {turn === undefined && <Spinner />}
        {turn === null && <p className={QUIET}>Its transcript is not there yet.</p>}
        {turn && <Turn turn={turn} last working={running} detail stepsOpen who="Asked" />}
      </div>
    </section>
  );
}
