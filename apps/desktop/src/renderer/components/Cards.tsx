import type { CardDisplayStatus } from "@grove/core/pure";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { CardHead, ProjectView } from "../../shared/ipc.ts";
import { nextActiveKey } from "../logic/rows.ts";
import {
  cardOrder,
  cardTitle,
  doneOf,
  groupCards,
  pendingFor,
  startBlocked,
} from "../logic/views.ts";
import { whoView } from "../logic/who.ts";
import { editProject, focusScreen, openCard, optionId, startAgent } from "../state/actions.ts";
import { currentProject, useStore } from "../state/store.ts";
import { Avatar, Button, Dot, ProblemMark, RuntimeChip, Spinner, StatusIcon, Time } from "./ui.tsx";

const NONE: CardHead[] = [];

/** the statuses whose row says who holds the card. a done or canceled one shows nothing on the right */
const LIVE: ReadonlySet<CardDisplayStatus> = new Set(["waiting", "stopped", "in_progress"]);

function CardRow({ card, active, pending }: { card: CardHead; active: boolean; pending: number }) {
  const title = cardTitle(card);
  return (
    <div
      id={optionId(card.id)}
      role="option"
      aria-selected={active}
      data-testid="card-row"
      data-id={card.id}
      data-status={card.status}
      data-active={active || undefined}
      className="fade flex h-9 items-center gap-3 border-b border-line px-3 last:border-b-0 hover:bg-raised data-[active]:bg-raised"
      onClick={() => openCard(card.id)}
      // the keyboard carries on from where the mouse was
      onMouseEnter={() => {
        const s = useStore.getState();
        if (s.active.cards !== card.id) s.set({ active: { ...s.active, cards: card.id } });
      }}
    >
      <StatusIcon status={card.status} />
      <span className="min-w-[72px] shrink-0 whitespace-nowrap tabular-nums text-fg-4">
        {card.id}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-fg" title={title}>
          {title}
        </span>
        <ProblemMark count={card.problems} />
      </span>
      {card.agent && LIVE.has(card.status) && (
        <span className="flex shrink-0 items-center gap-3">
          <span className="flex w-[120px] min-w-0 items-center gap-1.5">
            <Avatar who={whoView(card.agent.ref)!} />
            <span className="truncate text-fg-2">{card.agent.ref.name}</span>
          </span>
          <span className="w-[80px]">
            <RuntimeChip runtime={card.agent.runtime} />
          </span>
          <span className="flex w-[32px] items-center justify-end gap-1" data-testid="card-pending">
            {pending > 0 && (
              <>
                <Dot label="Not reviewed" />
                <span className="text-sm tabular-nums text-fg-3">{pending}</span>
              </>
            )}
          </span>
        </span>
      )}
    </div>
  );
}

/** the empty project. it never offers a start that is known to fail */
function StartState({ project }: { project: ProjectView }) {
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  // a start on a card waits on that card's page
  const starts = project.starting.filter((s) => !s.cardId);
  const blocked = startBlocked(project, true);
  const start = (where: "editor" | "background") => void startAgent({ project: project.id, where });

  let line: string;
  let buttons: ReactNode = null;
  if (blocked) {
    line = blocked.line;
    if (blocked.case === "goal") {
      buttons = (
        <Button variant="primary" size="lg" onClick={editProject} data-testid="start-edit">
          Edit project
        </Button>
      );
    }
  } else if (starts.length > 0) {
    line = `Cards appear here as ${starts.length > 1 ? "they create" : "it creates"} them.`;
    // a second editor start in the same folder loses one of the two prompts
    buttons = (
      <Button
        variant="quiet"
        size="sm"
        onClick={() => start("background")}
        data-testid="start-background"
      >
        Start another in the background
      </Button>
    );
  } else {
    line = "Agents create cards as they work. Start one on the goal.";
    buttons = (
      <>
        <Button
          variant="primary"
          size="lg"
          onClick={() => start("editor")}
          data-testid="start-editor"
        >
          Start an agent in {editor}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          onClick={() => start("background")}
          data-testid="start-background"
        >
          Start in the background
        </Button>
      </>
    );
  }

  return (
    <div
      className="pt-24 text-center"
      data-testid="start-state"
      data-case={blocked?.case ?? (starts.length > 0 ? "waiting" : "ready")}
    >
      <p className="text-body text-fg">No cards yet.</p>
      <p className="mt-1 text-body text-fg-4">{line}</p>
      {starts.length > 0 && (
        <ul className="mx-auto mt-4 w-fit space-y-1" data-testid="starts">
          {starts.map((s) => (
            <li
              key={s.id}
              className="flex h-8 items-center gap-2 text-body"
              data-testid="start-row"
              data-where={s.where}
            >
              <Spinner size={12} />
              <RuntimeChip runtime={s.where === "editor" ? "vscode" : "background"} />
              <span className="text-fg-2">Waiting for it to claim a card</span>
              <Time at={s.at} />
            </li>
          ))}
        </ul>
      )}
      {buttons && <div className="mt-5 flex justify-center gap-2">{buttons}</div>}
    </div>
  );
}

/** local reads are fast, so most of the time nothing flashes */
function Loading() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 300);
    return () => clearTimeout(t);
  }, []);
  if (!late) return null;
  return (
    <div className="flex justify-center pt-24" data-testid="loading">
      <Spinner />
    </div>
  );
}

/** the cards screen: the project's cards by status, or the start state when it has none */
export function Cards() {
  const project = useStore(currentProject);
  const record = useStore((s) => (s.project ? s.records[s.project] : undefined));
  const inbox = useStore((s) => s.inbox);
  const active = useStore((s) => (s.keys ? s.active.cards : null));

  const cards = record?.cards ?? NONE;
  const ids = useMemo(() => cardOrder(cards), [cards]);
  const had = useRef<string[]>([]);

  useEffect(focusScreen, []);

  // a row that leaves hands the keyboard to whatever took its index. on a fresh list, the first
  useEffect(() => {
    const s = useStore.getState();
    const next = nextActiveKey(had.current, ids, s.active.cards, false);
    had.current = ids;
    if (next !== s.active.cards) s.set({ active: { ...s.active, cards: next } });
  }, [ids]);

  if (!project) return null;
  const { done, total } = doneOf(cards);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-4 pt-8 pb-16">
        <div className="mb-6 flex items-start gap-4 px-3" data-testid="cards-header">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-title font-semibold">{project.name}</h1>
            {project.goal && (
              <p
                className="mt-1 truncate text-body text-fg-4"
                title={project.goal}
                data-testid="goal"
              >
                {project.goal}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button variant="quiet" size="sm" onClick={editProject} data-testid="edit-project">
              Edit project
            </Button>
            {total > 0 && (
              <span className="text-sm tabular-nums text-fg-4" data-testid="done-count">
                {done} of {total} done
              </span>
            )}
          </div>
        </div>
        {record?.readAt === undefined ? (
          <Loading />
        ) : cards.length === 0 ? (
          <StartState project={project} />
        ) : (
          <div
            role="listbox"
            aria-label="Cards"
            tabIndex={0}
            data-list
            aria-activedescendant={active ? optionId(active) : undefined}
            className="space-y-5"
          >
            {groupCards(cards).map((g) => (
              <div
                key={g.key}
                role="group"
                aria-labelledby={`group-${g.key}`}
                data-testid="card-group"
                data-group={g.key}
              >
                <div
                  id={`group-${g.key}`}
                  className="flex h-8 items-center gap-2 rounded-md bg-raised px-3 text-sm font-medium text-fg-2"
                >
                  <StatusIcon status={g.key} size={12} />
                  {g.label}
                  <span className="font-normal tabular-nums text-fg-4">{g.cards.length}</span>
                </div>
                {g.cards.map((c) => (
                  <CardRow
                    key={c.id}
                    card={c}
                    active={c.id === active}
                    pending={pendingFor(inbox, project.id, c.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
