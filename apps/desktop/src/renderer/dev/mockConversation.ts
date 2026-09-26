// dev only: a session's conversation as the pane sees it, for visual work in a plain browser
// (?mock=conversation). one long, realistic conversation that is still running, and a short one
// for every other row.
import type {
  ConversationEntry,
  ConversationTurn,
  ConversationTurns,
  ConversationView,
  DetailStep,
  MainStats,
  SessionRow,
  StepDetail,
} from "../../shared/ipc.ts";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

/** a clock time `days` ago, so the day headers read Today, Yesterday and a date */
function at(days: number, h: number, m: number): number {
  const d = new Date(Date.now() - days * D);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

const FILES = [
  "packages/core/src/sessions/conversation.ts",
  "packages/core/src/sessions/timeline.ts",
  "apps/desktop/src/main/services/agentInspector.ts",
  "apps/desktop/src/renderer/components/ConversationPane.tsx",
  "apps/desktop/src/renderer/components/Inspector.tsx",
  "apps/desktop/src/renderer/logic/conversation.ts",
  "apps/desktop/e2e/conversation.spec.ts",
  "README.md",
];

const bodies = new Map<string, StepDetail>();

/** a turn's work in the rhythm real ones have: reads, searches, edits, a test run now and then */
function work(
  id: string,
  start: number,
  count: number,
  spanS: number,
  special: Record<number, Partial<Extract<DetailStep, { kind: "tool" }>>> = {},
): DetailStep[] {
  const steps: DetailStep[] = [];
  for (let n = 0; n < count; n++) {
    const t = start + Math.round((n / Math.max(1, count)) * spanS) * 1000;
    const file = FILES[(n * 5) % FILES.length] ?? "README.md";
    const phase = n % 19;
    if (phase === 0 && !special[n]) {
      steps.push({
        kind: "text",
        n,
        text: `Reading ${file.split("/").pop()} before touching it - the fold's shape decides what the view can draw.`,
        at: t,
      });
      continue;
    }
    if (phase === 1 && !special[n] && n % 3 === 1) {
      steps.push({
        kind: "thinking",
        n,
        text: "The duplicate uuids come after a compaction, so skipping by uuid keeps file order intact.",
        at: t,
      });
      continue;
    }
    const tool =
      phase < 7
        ? "Read"
        : phase < 9
          ? "Grep"
          : phase < 13
            ? "Edit"
            : phase === 13
              ? "Bash"
              : "Read";
    const target =
      tool === "Grep"
        ? `"seenKey" in packages/core`
        : tool === "Bash"
          ? n % 2
            ? "pnpm test"
            : "pnpm typecheck && pnpm lint"
          : file;
    const toolUseId = `toolu_${id}_${n}`;
    const failed = tool === "Bash" && n % 4 === 0;
    bodies.set(toolUseId, {
      input: JSON.stringify(
        tool === "Bash" ? { command: target } : { file_path: `/Users/you/src/grove/${target}` },
        null,
        2,
      ),
      result: failed
        ? "Exit code 1\n FAIL  test/sessions/conversation.test.ts > skips what Claude Code wrote a second time"
        : `(what ${tool} gave back for ${target})`,
      ...(failed ? { isError: true } : {}),
      truncated: false,
    });
    steps.push({
      kind: "tool",
      n,
      id: toolUseId,
      name: tool,
      target,
      at: t,
      durationMs: tool === "Bash" ? 7_000 : 400,
      ...(failed ? { failure: "exit 1" } : {}),
      ...special[n],
    });
  }
  return steps;
}

const ANSWER_FIRST = `Pieces 1-3 are committed. The fold skips duplicate uuids, and the 107MB transcript opens in **140ms** cold.

- \`sessions/conversation.ts\` folds a turn's work with the agent fold, so steps pair the same way
- a compaction mid-turn leaves the work after it without a prompt: it reads as a continuation
- the skeleton for the biggest transcript is 1.5MB, so it goes in one payload

Next is the view itself. Nothing is pushed.`;

const PLAN = `# session pane - read a whole conversation inside grove

## what

- a click on a session reads it in the pane. a double-click, Enter or the header button opens it
- the conversation: prompt, the work folded to one line, the answer
- plans, questions, compactions and interrupts always in sight

## how

1. fold the transcript into turns in core, beside the agent timeline
2. follow it from main with the agent inspector's poller
3. the view, virtualised like the agent detail

## out of scope

- rich step bodies (diffs, bash output) - piece 5
- the main conversation in the Agents view - piece 6`;

interface MockSession {
  view: ConversationView;
  steps: Map<number, DetailStep[]>;
  running: boolean;
}

function turn(
  n: number,
  t: Omit<ConversationTurn, "kind" | "n" | "marks"> & Partial<ConversationTurn>,
): ConversationTurn {
  return { kind: "turn", n, marks: [], ...t };
}

/** the one the pane was built against: three days, every kind of turn, and a live one at the end */
function long(key: string): MockSession {
  const steps = new Map<number, DetailStep[]>();
  const items: ConversationEntry[] = [];
  const add = (entry: ConversationEntry, work?: DetailStep[]) => {
    items.push(entry);
    if (work) steps.set(entry.n, work);
  };

  const t0 = at(2, 14, 2);
  add(
    turn(0, {
      prompt: {
        kind: "human",
        at: t0,
        text: `some feedback from using:
- clicking on a session should not open vs-code - double-clicking should and there can be a dedicated button as well. clicking on it should open the agent-view / chat-view within grove itself.
- should show the "main" agent in the agents view as well
- you need to show the full-featured read-only version of the chat in as tasteful manner as possible. definitely better than the vs code version please
- new sessions with different settings (model, permission mode)

the first three are one branch. the fourth is its own card.

also - keep the look quiet. it must look like it was always part of grove, warm neutrals, one accent, hairlines not boxes. check both themes.

and measure the big transcript before you promise anything about it.`,
      },
      answer: ANSWER_FIRST,
      tools: 48,
      filesEdited: 6,
      agents: 2,
      startedAt: t0,
      endedAt: t0 + 12 * MIN,
      durationMs: 12 * MIN,
    }),
    work(`${key}-0`, t0, 52, 720, {
      7: { name: "Agent", target: "Survey the transcripts on this machine", agentId: "a01" },
      30: { name: "Agent", target: "Check the vs code extension's open command", agentId: "a02" },
    }),
  );
  const t1 = at(2, 14, 20);
  add(
    turn(1, {
      prompt: { kind: "command", at: t1, text: "/model opus" },
      output: "Set model to opus 5 (claude-opus-5)",
      tools: 0,
      filesEdited: 0,
      agents: 0,
      startedAt: t1,
      endedAt: t1,
    }),
  );
  const t2 = at(2, 14, 26);
  add(
    turn(2, {
      prompt: {
        kind: "human",
        at: t2,
        images: 2,
        text: "here's the vs code panel for the same session. it's cramped and the tool calls are just json",
      },
      answer:
        "Agreed on both counts. The panel shows every tool call at full size, so a 300-step turn is a wall. The pane will fold a turn's work into one line and open it on demand, with the tool calls as one quiet line each.",
      tools: 0,
      filesEdited: 0,
      agents: 0,
      startedAt: t2,
      endedAt: t2 + 40_000,
      durationMs: 40_000,
    }),
  );
  const t3 = at(2, 15, 10);
  const planSteps = work(`${key}-3`, t3, 26, 1500, {
    9: { name: "AskUserQuestion", target: "", durationMs: 90_000 },
    17: { name: "ExitPlanMode", target: "", failure: "rejected" },
    24: { name: "ExitPlanMode", target: "" },
  });
  add(
    turn(3, {
      prompt: { kind: "human", at: t3, plan: true, text: "plan the session pane. keep it simple" },
      marks: [
        {
          kind: "question",
          step: 9,
          at: t3 + 6 * MIN,
          questions: [
            {
              header: "Click",
              question: "What should a single click on a session do?",
              options: ["Read it in the pane", "Open the editor", "Select only"],
              picked: "Read it in the pane",
            },
            {
              header: "Width",
              question: "How wide should the pane start?",
              options: ["Half of the room (Recommended)", "560px as today"],
              picked: "Half of the room (Recommended)",
            },
          ],
        },
        {
          kind: "plan",
          step: 17,
          at: t3 + 14 * MIN,
          text: PLAN.replace(
            "## out of scope",
            "## later\n\n- search inside the conversation\n\n## out of scope",
          ),
          outcome: "rejected",
          said: "search inside the conversation is not later - keep it, but as its own piece at the end. and say what the live turn does",
        },
        { kind: "plan", step: 24, at: t3 + 24 * MIN, text: PLAN, outcome: "approved" },
      ],
      answer: "The plan is in `plans/2026-09-25-session-pane.md`. Starting on piece 1.",
      tools: 22,
      filesEdited: 1,
      agents: 0,
      startedAt: t3,
      endedAt: t3 + 25 * MIN,
      durationMs: 25 * MIN,
    }),
    planSteps,
  );

  const t4 = at(1, 9, 12);
  add(
    turn(4, {
      prompt: {
        kind: "task",
        at: t4,
        status: "completed",
        text: 'Background command "pnpm app:e2e" completed (exit code 0)',
      },
      answer: "All 37 e2e tests pass, including the new conversation spec.",
      tools: 1,
      filesEdited: 0,
      agents: 0,
      startedAt: t4,
      endedAt: t4 + 20_000,
      durationMs: 20_000,
    }),
    work(`${key}-4`, t4, 1, 20),
  );
  const t5 = at(1, 9, 40);
  add(
    turn(5, {
      prompt: { kind: "human", at: t5, text: "run the whole suite again, the packaged one too" },
      interrupted: true,
      tools: 3,
      filesEdited: 0,
      agents: 0,
      startedAt: t5,
      endedAt: t5 + 90_000,
      durationMs: 90_000,
    }),
    work(`${key}-5`, t5, 4, 90),
  );
  const t6 = at(1, 9, 44);
  add(
    turn(6, {
      prompt: { kind: "human", at: t6, text: "go on, but skip the packaged test" },
      apiError: "Connection dropped (ECONNRESET) · retry 10 of 10",
      tools: 14,
      filesEdited: 2,
      agents: 0,
      startedAt: t6,
      endedAt: t6 + 6 * MIN,
      durationMs: 6 * MIN,
    }),
    work(`${key}-6`, t6, 16, 360),
  );
  const t7 = at(1, 11, 5);
  add({
    kind: "compact",
    n: 7,
    at: t7,
    trigger: "auto",
    preTokens: 1_025_204,
    postTokens: 25_073,
    summary: `## Primary request

Build the session pane in grove: a click reads a session's whole conversation in a pane beside the list, a double-click opens it.

## Where it stands

- pieces 1 and 2 committed (the fold in core, the follow in main)
- piece 3 in progress: the click rule and the header button
- the 107MB transcript folds in 140ms cold, its skeleton is 1.5MB`,
  });
  add(
    turn(8, {
      answer:
        "Piece 3 is committed: a click reads, a double-click or Enter opens, and the header button goes where Enter would. The pane starts at half the room and keeps the width it is dragged to.",
      tools: 76,
      filesEdited: 12,
      agents: 0,
      startedAt: t7 + 30_000,
      endedAt: t7 + 38 * MIN,
      durationMs: 38 * MIN,
    }),
    work(`${key}-8`, t7 + 30_000, 80, 2250),
  );

  const t9 = at(0, 10, 2);
  const nineSteps = work(`${key}-9`, t9, 9, 300);
  add(
    turn(9, {
      prompt: { kind: "human", at: t9, text: "looks good. ship it" },
      marks: [{ kind: "said", step: 4, at: t9 + 2 * MIN, text: "and write the context entry too" }],
      answer:
        "Not pushed - pushes to main publish a release, so it waits for review. The branch has three commits and the context entry is written.",
      tools: 8,
      filesEdited: 1,
      agents: 0,
      startedAt: t9,
      endedAt: t9 + 5 * MIN,
      durationMs: 5 * MIN,
    }),
    nineSteps,
  );
  const t10 = at(0, 10, 20);
  add(
    turn(10, {
      prompt: { kind: "command", at: t10, text: "/mcp" },
      output:
        "10 MCP server(s): 1 connected, 9 not connected, 0 disabled.\n  figma          connected\n  slack          needs auth\n  datadog        needs auth\nUse `/mcp` in the terminal for details.",
      tools: 0,
      filesEdited: 0,
      agents: 0,
      startedAt: t10,
      endedAt: t10,
    }),
  );
  const t11 = Date.now() - 42 * MIN;
  const liveSteps = work(`${key}-11`, t11, 320, 42 * 60 - 4);
  const lastLive = liveSteps.at(-1);
  if (lastLive?.kind === "tool") delete lastLive.durationMs;
  add(
    turn(11, {
      prompt: {
        kind: "human",
        at: t11,
        text: "now the conversation view itself - the live one first. it should follow the tail the way a running agent does",
      },
      tools: liveSteps.filter((s) => s.kind === "tool").length,
      filesEdited: 7,
      agents: 0,
      startedAt: t11,
      endedAt: Date.now(),
    }),
    liveSteps,
  );
  const view: ConversationView = {
    key,
    items,
    model: "claude-opus-5",
    tools: items.reduce((n, i) => n + (i.kind === "turn" ? i.tools : 0), 0),
    turns: items.filter((i) => i.kind === "turn").length,
    startedAt: t0,
    lastAt: Date.now(),
  };
  return { view, steps, running: true };
}

/** any other row: one prompt, a little work and an answer */
function short(row: SessionRow): MockSession {
  const t = row.activityMs - 4 * MIN;
  const key = row.key;
  const steps = new Map<number, DetailStep[]>([[0, work(`${key}-0`, t, 7, 200)]]);
  const view: ConversationView = {
    key,
    items: [
      turn(0, {
        prompt: {
          kind: "human",
          at: t,
          text: row.firstPrompt ?? "take a look at this and tell me what you think",
        },
        answer: `Done. ${row.title ?? "It"} is in a good state - two small fixes, both in \`src/\`, and the tests pass.`,
        tools: 6,
        filesEdited: 2,
        agents: 0,
        startedAt: t,
        endedAt: row.activityMs,
        durationMs: row.activityMs - t,
      }),
    ],
    model: row.usage?.[0]?.model ?? "claude-sonnet-5",
    tools: 6,
    turns: 1,
    startedAt: t,
    lastAt: row.activityMs,
  };
  return { view, steps, running: false };
}

const held = new Map<string, MockSession>();
let tail: ReturnType<typeof setInterval> | null = null;
let gen = 0;

export function mockConversations(
  sessions: SessionRow[],
  emit: (channel: "conversation:turns", payload: ConversationTurns) => void,
) {
  const get = (key: string): MockSession | null => {
    const known = held.get(key);
    if (known) return known;
    const row = sessions.find((r) => r.key === key);
    if (!row) return null;
    const made = row === sessions[0] ? long(key) : short(row);
    held.set(key, made);
    return made;
  };
  return {
    follow(key: string | null, find?: string) {
      if (tail) clearInterval(tail);
      tail = null;
      gen++;
      if (key === null) return null;
      const s = get(key);
      if (!s) return null;
      const mine = gen;
      const lastN = s.view.items.length - 1;
      if (s.running) {
        s.view = { ...s.view, live: { n: lastN, steps: s.steps.get(lastN) ?? [] } };
        // it keeps working: a step every couple of seconds, like a busy session does
        tail = setInterval(() => {
          const steps = s.steps.get(lastN) ?? [];
          const n = steps.length;
          const last = steps[n - 1];
          const settled =
            last?.kind === "tool" && last.durationMs === undefined
              ? [{ ...last, durationMs: 1_800 }]
              : [];
          const file = FILES[n % FILES.length] ?? "README.md";
          const id = `toolu_${key}-${lastN}_${n}`;
          bodies.set(id, {
            input: JSON.stringify({ file_path: `/Users/you/src/grove/${file}` }, null, 2),
            result: `(what Read gave back for ${file})`,
            truncated: false,
          });
          const added: DetailStep = {
            kind: "tool",
            n,
            id,
            name: n % 6 === 0 ? "Edit" : "Read",
            target: file,
            at: Date.now(),
          };
          const from = settled.length ? n - 1 : n;
          const all = [...steps.slice(0, from), ...settled, added];
          s.steps.set(lastN, all);
          const liveTurn = s.view.items[lastN] as ConversationTurn;
          const updated: ConversationTurn = {
            ...liveTurn,
            tools: all.filter((x) => x.kind === "tool").length,
            endedAt: Date.now(),
          };
          const items = [...s.view.items.slice(0, lastN), updated];
          s.view = {
            ...s.view,
            items,
            tools: s.view.tools + 1,
            lastAt: Date.now(),
            live: { n: lastN, steps: all },
          };
          const { key: _k, items: _i, live: _l, ...head } = s.view;
          emit("conversation:turns", {
            key,
            gen: mine,
            from: lastN,
            items: [updated],
            head,
            live: { n: lastN, from, steps: all.slice(from) },
          });
        }, 2_000);
      }
      const q = (find ?? "").toLowerCase();
      const found = q
        ? s.view.items.find(
            (i) =>
              i.kind === "turn" &&
              `${i.prompt?.text ?? ""}\n${i.answer ?? ""}`.toLowerCase().includes(q),
          )
        : undefined;
      return { gen: mine, conversation: s.view, ...(found ? { found: { n: found.n } } : {}) };
    },
    /** the session as one more row of its agents */
    main(key: string): MainStats | undefined {
      const s = get(key);
      if (!s) return undefined;
      const turns = s.view.items.filter((i): i is ConversationTurn => i.kind === "turn");
      const last = turns.at(-1);
      const liveSteps = last ? (s.steps.get(last.n) ?? []) : [];
      const step = liveSteps.findLast((x) => x.kind === "tool");
      const answered = turns.findLast((t) => t.answer);
      return {
        model: s.view.model,
        tools: s.view.tools,
        turns: turns.length,
        startedAt: s.view.startedAt,
        lastAt: s.view.lastAt,
        ...(answered?.answer ? { outcome: answered.answer.split(". ")[0] } : {}),
        ...(step?.kind === "tool" ? { lastStep: `${step.name} ${step.target}` } : {}),
        spans: turns.flatMap((t) =>
          t.startedAt !== undefined && t.endedAt !== undefined ? [[t.startedAt, t.endedAt]] : [],
        ) as Array<[number, number]>,
      };
    },
    steps(key: string, n: number): DetailStep[] | null {
      return get(key)?.steps.get(n) ?? [];
    },
    step(stepId: string): StepDetail | null {
      return bodies.get(stepId) ?? null;
    },
  };
}
