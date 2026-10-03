import { formatRelativeTime } from "@grove/core/pure";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import type { CardView, PendingStart, SubagentView } from "../../shared/ipc.ts";
import {
  artifactName,
  cardPrimary,
  cardRole,
  linkWord,
  problemsFor,
  startBlocked,
  stateLine,
  threadItems,
} from "../logic/views.ts";
import { whoView } from "../logic/who.ts";
import {
  back,
  focusScreen,
  openArtifact,
  openConclusion,
  openWith,
  startAgent,
} from "../state/actions.ts";
import { currentProject, useStore } from "../state/store.ts";
import { Markdown } from "./Markdown.tsx";
import {
  Avatar,
  Button,
  CardChip,
  cx,
  Dot,
  FileChip,
  Icon,
  Kbd,
  Mono,
  ProblemMark,
  RuntimeChip,
  Spinner,
  STATUS_LABEL,
  StatusIcon,
  Time,
} from "./ui.tsx";

const HEADING = "text-sm font-medium text-fg-4";
const SIDE_ROW =
  "fade flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-sm hover:bg-raised";
// Button takes no pointer when disabled, and a title only shows under one
const HINTED = "disabled:pointer-events-auto!";
// a chip is as tall as a line of prose. ui.tsx hangs it 4px under the baseline, which is right for
// a box with no baseline of its own. a chip has one (its text), so it sat low and pushed the lines
// apart. on the line's bottom edge it fills the line exactly
const CHIPS_IN_LINE = "[&_[data-testid$='-chip']]:align-bottom";

function Subagents({ list }: { list: SubagentView[] }) {
  const [open, setOpen] = useState(false);
  if (list.length === 0) return null;
  const sorted = [...list].sort(
    (a, b) =>
      Number(b.state === "running") - Number(a.state === "running") ||
      b.lastActivityAt - a.lastActivityAt,
  );
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        data-testid="subagents-toggle"
        onClick={() => setOpen(!open)}
        className="fade -mx-1.5 mt-3 flex h-7 items-center gap-1 rounded-md px-1.5 text-sm text-fg-2 hover:bg-raised"
      >
        <span className="flex w-3 justify-center">
          <Icon name="chevron" size={8} faint className={open ? "rotate-90" : ""} />
        </span>
        {list.length === 1 ? "1 subagent" : `${list.length} subagents`}
      </button>
      {open && (
        <ul className="ml-[5px] border-l border-line-strong">
          {sorted.map((s) => (
            <li
              key={s.id}
              className="flex h-7 items-center gap-2 pl-4 text-sm text-fg-2"
              title={s.lastTool ? `${s.type} · ${s.lastTool}` : s.type}
              data-testid="subagent"
              data-state={s.state}
            >
              <span
                className={cx(
                  "size-1.5 shrink-0 rounded-full",
                  s.state === "running" ? "live-pulse bg-fg-3" : "border border-faint",
                )}
              />
              <span className="truncate">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AgentSection({
  card,
  pending,
  blocked,
  closedAt,
  start,
}: {
  card: CardView;
  /** a start from grove that has not claimed this card yet */
  pending?: PendingStart;
  /** why a start would fail, in place of the start button */
  blocked?: string;
  /** the card's last activity: when a closed card was finished or canceled */
  closedAt?: number;
  start: () => void;
}) {
  const now = useStore((s) => s.now);
  const role = cardRole(card);
  const { agent } = card;
  // while a start waits for its claim nothing offers a second one
  const waiting = pending && (
    // the panel is too narrow for all three on one line: the sentence takes the second whole
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="side-waiting">
      <Spinner size={12} />
      <RuntimeChip runtime={pending.where === "editor" ? "vscode" : "background"} />
      <span className="text-fg-3">Waiting for it to claim this card</span>
    </p>
  );
  const starter = (label: string) =>
    blocked ? (
      <p className="break-words text-sm text-fg-4">{blocked}</p>
    ) : (
      <Button
        variant="quiet"
        size="sm"
        className="-ml-2"
        onClick={start}
        data-testid="start-background-card"
      >
        {label}
      </Button>
    );

  let body: ReactNode;
  if (agent && (role === "held" || role === "closed-with-agent")) {
    const line =
      role === "held"
        ? stateLine(agent, now)
        : {
            text: [
              card.recordStatus === "done" ? "finished" : "canceled",
              closedAt !== undefined && formatRelativeTime(closedAt, now),
            ]
              .filter(Boolean)
              .join(" "),
            tone: "text-fg-3",
          };
    body = (
      <>
        <div className="flex items-center gap-2">
          <Avatar who={whoView(agent.ref)!} size={18} />
          <span className="truncate font-medium">{agent.ref.name}</span>
          <RuntimeChip runtime={agent.runtime} />
        </div>
        <div className="mt-1 space-y-0.5 pl-[26px] text-sm">
          {agent.model && <p className="text-fg-3">{agent.model}</p>}
          {line && <p className={line.tone}>{line.text}</p>}
        </div>
        {role === "held" && <Subagents list={agent.subagents} />}
        {card.status === "stopped" && (
          <div className="mt-2">{waiting ?? starter("Start a new agent instead")}</div>
        )}
      </>
    );
  } else {
    body = (role === "open" && waiting) || (
      <>
        <p className="text-sm text-fg-4">Nobody is on this card.</p>
        {role === "open" && <div className="mt-2">{starter("Start in the background")}</div>}
      </>
    );
  }
  return (
    <section data-testid="side-agent">
      <h2 className={cx("mb-2.5", HEADING)}>Agent</h2>
      {body}
    </section>
  );
}

/** one card with its thread and side panel (ui.md 4.3) */
export function CardPage({ cardId }: { cardId: string }) {
  const project = useStore(currentProject);
  const record = useStore((s) => (s.project ? s.records[s.project] : undefined));
  const stored = useStore((s) => s.card);
  const editor = useStore((s) => s.editor?.label ?? "the editor");
  /** `card()` answered null */
  const [gone, setGone] = useState(false);
  const [slow, setSlow] = useState(false);
  const waitingItem = useRef<HTMLLIElement>(null);
  const arrived = useRef(false);

  const projectId = project?.id;
  const head = record?.cards.find((c) => c.id === cardId);
  // the store keeps the last card it showed: only this one counts
  const card = stored?.id === cardId && stored.project === projectId ? stored : null;
  // the head's version moves with the card's own files. a conclusion is not one of them, so the
  // ones that name this card are the other half of "it changed"
  const version = `${head?.version} ${record?.conclusions
    .filter((c) => c.card?.id === cardId)
    .map((c) => (c.superseded ? `${c.id}~` : c.id))
    .join()}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is what says to read the card again
  useEffect(() => {
    if (!projectId) return;
    let stale = false;
    void window.grove.card(projectId, cardId).then(
      (c) => {
        if (stale) return;
        setGone(!c);
        if (c) useStore.getState().set({ card: c });
      },
      // main did not answer: what is on screen stays
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [projectId, cardId, version]);

  useEffect(() => {
    focusScreen();
    const t = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(t);
  }, []);

  // a notification lands here for a question, and the thread is oldest first. once: a re-fetch
  // keeps the scroll where it is
  useEffect(() => {
    if (!card || arrived.current) return;
    arrived.current = true;
    waitingItem.current?.scrollIntoView({ block: "nearest" });
  }, [card]);

  if (!project) return null;
  const shown = card ?? head;
  const agent = card?.agent;
  const role = card && cardRole(card);
  const blocked = startBlocked(project, false);
  const primary = card && cardPrimary(card, blocked);
  const disabled = primary?.action === "open" ? primary.disabled : undefined;
  const open = {
    disabled: !!disabled,
    title: disabled,
    onClick: () => openWith(agent?.sessionKey, agent?.open, cardId),
  };
  const start = (where: "editor" | "background") =>
    void startAgent({ project: project.id, where, cardId });
  // a null before the record's first read is not an answer yet
  const missing = gone && !!record?.readAt;

  return (
    <div
      className={cx("flex h-full min-h-0 flex-col", CHIPS_IN_LINE)}
      data-testid="card-page"
      data-id={cardId}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <button
          type="button"
          aria-label="Back"
          onClick={back}
          data-testid="back"
          className="no-drag fade flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-fg-3 hover:bg-raised hover:text-fg"
        >
          <Icon name="arrow-left" size={12} />
          <Kbd>esc</Kbd>
        </button>
        {shown && !missing && (
          <>
            <span className="shrink-0 tabular-nums text-fg-4">{shown.id}</span>
            <h1 className="min-w-0 truncate font-semibold" title={shown.title}>
              {shown.title}
            </h1>
            {card && <ProblemMark {...problemsFor(card.problems, `cards/${card.id}/card.md`)} />}
            <span
              className="flex shrink-0 items-center gap-1.5 text-sm text-fg-3"
              data-testid="card-status"
              data-status={shown.status}
            >
              <StatusIcon status={shown.status} size={12} />
              {STATUS_LABEL[shown.status]}
            </span>
            <span className="flex-1" />
            {primary && (
              <Button
                variant="primary"
                className={HINTED}
                data-testid="card-primary"
                data-action={primary.action}
                {...(primary.action === "open" ? open : { onClick: () => start("editor") })}
              >
                {primary.action === "open" ? "Open" : "Start an agent"} in {editor}
              </Button>
            )}
          </>
        )}
      </header>
      {missing ? (
        <p className="pt-24 text-center text-body text-fg-4" data-testid="card-missing">
          This card no longer exists.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            // it holds focus so the arrows and space scroll it. a ring round the column says nothing
            className="min-w-0 flex-1 overflow-y-auto outline-none!"
            tabIndex={-1}
            data-testid="card-main"
          >
            {card ? (
              <div className="mx-auto max-w-[680px] px-10 pt-7 pb-16">
                <h2 className={cx("mb-2", HEADING)}>Description</h2>
                {card.body ? (
                  <Markdown text={card.body} refs className="md-full" />
                ) : (
                  <p className="text-fg-4">No description.</p>
                )}
                <h2 className={cx("mt-9 mb-4", HEADING)}>Activity</h2>
                <Thread card={card} waitingItem={waitingItem} />
                {role === "held" && agent && (
                  <p
                    className="mt-8 border-t border-line pt-4 text-sm text-fg-4"
                    data-testid="answer-hint"
                  >
                    {agent.runtime === "terminal" ? (
                      "Answer in the agent's terminal."
                    ) : agent.runtime === "elsewhere" ? (
                      "Answer where the agent runs."
                    ) : (
                      <>
                        Answer in the agent's session ·{" "}
                        <Button variant="link" className={HINTED} {...open}>
                          Open in {editor}
                        </Button>
                      </>
                    )}
                  </p>
                )}
              </div>
            ) : (
              slow && (
                <div className="flex justify-center pt-24" data-testid="loading">
                  <Spinner />
                </div>
              )
            )}
          </div>
          {card && (
            <aside
              aria-label="Card details"
              className="w-[264px] shrink-0 space-y-7 overflow-y-auto border-l border-line px-5 py-7"
              data-testid="card-side"
            >
              <AgentSection
                card={card}
                pending={project.starting.find((s) => s.cardId === cardId)}
                blocked={blocked?.line}
                closedAt={head?.lastActivity}
                start={() => start("background")}
              />
              <section data-testid="side-artifacts">
                <h2 className={cx("mb-2.5", HEADING)}>Artifacts</h2>
                {card.artifacts.length === 0 ? (
                  <p className="text-sm text-fg-4">None yet.</p>
                ) : (
                  <div className="-mx-1.5">
                    {card.artifacts.map((a) => (
                      <button
                        key={`${a.type} ${a.ref}`}
                        type="button"
                        className={SIDE_ROW}
                        onClick={() => void openArtifact(card.project, a)}
                        data-testid="artifact"
                        data-type={a.type}
                      >
                        <Icon name={a.type === "link" ? "external" : a.type} size={11} faint />
                        <span className="min-w-0 flex-1 truncate text-left text-fg" title={a.ref}>
                          {artifactName(a)}
                        </span>
                        <span className="text-fg-4">
                          {a.type === "pr" ? "pull request" : a.type}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <section data-testid="side-links">
                <h2 className={cx("mb-2.5", HEADING)}>Links</h2>
                {card.needs.length === 0 && !card.from ? (
                  <p className="text-sm text-fg-4">None.</p>
                ) : (
                  <div className="space-y-2 text-sm text-fg-3">
                    {card.needs.map((id) => (
                      <p key={id}>
                        {linkWord("needs")} <CardChip cardId={id} />
                      </p>
                    ))}
                    {card.from && (
                      <p>
                        {linkWord("from")} <CardChip cardId={card.from} />
                      </p>
                    )}
                  </div>
                )}
              </section>
              {card.conclusions.length > 0 && (
                <section data-testid="side-conclusions">
                  <h2 className={cx("mb-2.5", HEADING)}>Conclusions</h2>
                  <div className="-mx-1.5">
                    {card.conclusions.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={SIDE_ROW}
                        title={c.what}
                        onClick={() => openConclusion(c.id)}
                        data-testid="card-conclusion"
                      >
                        <Mono className="text-fg-4">{c.id}</Mono>
                        <span
                          className={cx(
                            "min-w-0 flex-1 truncate text-left",
                            c.superseded ? "text-fg-4 line-through" : "text-fg",
                          )}
                        >
                          {c.what}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function Thread({ card, waitingItem }: { card: CardView; waitingItem: Ref<HTMLLIElement> }) {
  const items = threadItems(card);
  if (items.length === 0) return <p className="text-fg-4">No activity yet.</p>;
  return (
    <ol className="space-y-5" data-testid="thread">
      {items.map((item) => (
        <li
          key={item.key}
          // the newest one waiting on you is where a notification lands
          ref={item.waitingOnYou ? waitingItem : undefined}
          className="flex scroll-mb-7 gap-3"
          data-testid="thread-item"
          data-kind={item.kind}
        >
          <span className="pt-px">
            <Avatar who={item.who} size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex h-5 items-center gap-1.5 text-sm">
              <span className="truncate font-medium text-fg">{item.who.name}</span>
              {item.word && <span className="shrink-0 text-fg-3">{item.word}</span>}
              {item.toCard && <CardChip cardId={item.toCard} />}
              <span className="shrink-0 text-fg-4">
                · <Time at={item.at} />
              </span>
              {item.waitingOnYou && <Dot label="Waiting on you" />}
              <ProblemMark {...item.problems} />
            </div>
            {item.body && <Markdown text={item.body} refs className="md-full mt-0.5" />}
            {item.artifacts.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {item.artifacts.map((a) => (
                  <FileChip key={`${a.type} ${a.ref}`} artifact={a} project={card.project} />
                ))}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
