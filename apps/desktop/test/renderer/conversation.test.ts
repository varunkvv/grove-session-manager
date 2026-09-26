import { describe, expect, it } from "vitest";
import {
  applyTurns,
  conversationLines,
  conversationMeta,
  dayLabel,
  openLabel,
  spanLabel,
  workLine,
} from "../../src/renderer/logic/conversation.ts";
import type { ConversationTurn, ConversationView } from "../../src/shared/ipc.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

const turn = (n: number, over: Partial<ConversationTurn> = {}): ConversationTurn => ({
  kind: "turn",
  n,
  marks: [],
  tools: 0,
  filesEdited: 0,
  agents: 0,
  ...over,
});

describe("the pane's header", () => {
  it("says how long a session went on at the grain a person thinks in", () => {
    expect(spanLabel(45_000)).toBe("45s");
    expect(spanLabel(12 * MIN)).toBe("12m");
    expect(spanLabel(5 * HOUR + 12 * MIN)).toBe("5h 12m");
    expect(spanLabel(52 * HOUR)).toBe("2d 4h");
    expect(spanLabel(48 * HOUR)).toBe("2d");
  });

  it("says where it ran, the branch, the model, how long and how much, and never a context size", () => {
    const row = {
      comboName: "chat-features",
      cwdBase: "session-manager-chat-view",
      projectLabel: "chat-features",
      gitBranch: "chat-view",
      usage: [
        {
          model: "claude-opus-5",
          input: 1,
          output: 1,
          cacheRead: 1,
          cacheWrite: 1,
          messages: 1,
        },
      ],
    };
    const head = { model: "claude-opus-5", tools: 412, startedAt: 0, lastAt: 52 * HOUR };
    expect(conversationMeta(row, head)).toBe(
      "chat-features · chat-view · opus 5 · 2d 4h · 412 tools",
    );
    // before the conversation is read, the row's own numbers say what they can
    expect(conversationMeta({ ...row, comboName: undefined, gitBranch: undefined }, null)).toBe(
      "session-manager-chat-view · opus 5",
    );
    expect(conversationMeta(row, { tools: 1 })).toContain("1 tool");
  });

  it("names where the open button goes by the first offer", () => {
    const offer = (id: string, label = id) =>
      ({ id, label, enabled: true }) as Parameters<typeof openLabel>[0];
    expect(openLabel(offer("combo-land"), "VS Code")).toBe("Open in VS Code");
    expect(openLabel(offer("folder-land"), "Cursor")).toBe("Open in Cursor");
    expect(openLabel(offer("attach"), "VS Code")).toBe("Open in Terminal");
    expect(openLabel(offer("continue-bg", "Continue in background…"), "VS Code")).toBe(
      "Continue in background…",
    );
    expect(openLabel(undefined, "VS Code")).toBe("Open in VS Code");
  });
});

describe("a push applied to the conversation on screen", () => {
  const base: ConversationView = {
    key: "k",
    items: [turn(0, { answer: "one" }), turn(1)],
    tools: 1,
    turns: 2,
    live: {
      n: 1,
      steps: [
        { kind: "tool", n: 0, id: "t0", name: "Read", target: "a.ts", at: 1, durationMs: 5 },
        { kind: "tool", n: 1, id: "t1", name: "Bash", target: "ls", at: 2 },
      ],
    },
  };

  it("replaces every entry from the first that changed, and keeps the ones before", () => {
    const next = applyTurns(base, {
      key: "k",
      gen: 1,
      from: 1,
      items: [turn(1, { answer: "two" }), { kind: "compact", n: 2, at: 9 }],
      head: { tools: 2, turns: 2 },
    });
    expect(next.items[0]).toBe(base.items[0]);
    expect(next.items.map((i) => i.n)).toEqual([0, 1, 2]);
    expect(next.tools).toBe(2);
    // the live work was not in this push: it stays as it was
    expect(next.live).toBe(base.live);
  });

  it("splices the live turn's work from its first changed step, or starts a new turn's", () => {
    const settled = applyTurns(base, {
      key: "k",
      gen: 1,
      from: 2,
      items: [],
      head: { tools: 2, turns: 2 },
      live: {
        n: 1,
        from: 1,
        steps: [{ kind: "tool", n: 1, id: "t1", name: "Bash", target: "ls", at: 2, durationMs: 9 }],
      },
    });
    expect(settled.live?.steps[0]).toBe(base.live?.steps[0]);
    expect(settled.live?.steps[1]).toMatchObject({ durationMs: 9 });
    const fresh = applyTurns(settled, {
      key: "k",
      gen: 1,
      from: 2,
      items: [turn(2)],
      head: { tools: 2, turns: 3 },
      live: { n: 2, from: 0, steps: [] },
    });
    expect(fresh.live).toEqual({ n: 2, steps: [] });
  });
});

describe("the conversation, line by line", () => {
  const T = Date.parse("2026-09-25T10:00:00");
  const tool = (n: number, name = "Read", extra = {}) =>
    ({
      kind: "tool",
      n,
      id: `t${n}`,
      name,
      target: `f${n}.ts`,
      at: T + n * 1000,
      durationMs: 5,
      ...extra,
    }) as const;
  const base = (items: ConversationView["items"]): ConversationView => ({
    key: "k",
    items,
    tools: 0,
    turns: items.length,
  });
  const opts = {
    open: new Set<number>(),
    closedLive: false,
    steps: new Map(),
    live: null,
    thinking: false,
    openRuns: new Set<string>(),
    now: T + 60_000,
  };
  const kinds = (lines: ReturnType<typeof conversationLines>) =>
    lines.map((l) => (l.type === "mark" ? `mark:${l.mark.kind}` : l.type));

  it("draws a turn as its prompt, one line for the work, what was asked, and the answer", () => {
    const view = base([
      turn(0, {
        prompt: { kind: "human", text: "plan it", at: T },
        tools: 4,
        answer: "done",
        marks: [{ kind: "plan", step: 2, at: T, text: "# plan", outcome: "approved" }],
      }),
      turn(1, { prompt: { kind: "human", text: "thanks", at: T + 1 }, answer: "sure" }),
    ]);
    // closed: the plan is right under the work line. a turn with no tools has no work line
    expect(kinds(conversationLines(view, opts))).toEqual([
      "prompt",
      "work",
      "mark:plan",
      "answer",
      "prompt",
      "answer",
    ]);
  });

  it("puts what was asked and said among the steps when the work is open", () => {
    const steps = [tool(0, "Read"), tool(1, "Edit"), tool(2, "ExitPlanMode"), tool(3, "Bash")];
    const view = base([
      turn(0, {
        prompt: { kind: "human", text: "go", at: T },
        tools: 4,
        marks: [
          { kind: "plan", step: 2, at: T, text: "# plan" },
          { kind: "said", step: 1, at: T, text: "also the tests" },
        ],
      }),
    ]);
    const lines = conversationLines(view, {
      ...opts,
      open: new Set([0]),
      steps: new Map([[0, steps]]),
    });
    // said before the step it arrived ahead of, the plan right after the call that proposed it
    expect(kinds(lines)).toEqual([
      "prompt",
      "work",
      "tool",
      "mark:said",
      "tool",
      "tool",
      "mark:plan",
      "tool",
    ]);
    // ids start with the turn: two turns' step 0 never collide
    expect(lines[2]?.id).toBe("0:t:0");
    // still reading it: one quiet line, not an empty gap
    const waiting = conversationLines(view, { ...opts, open: new Set([0]) });
    expect(kinds(waiting)).toEqual(["prompt", "work", "loading"]);
  });

  it("keeps the live turn open unless someone closes it, and says how turns ended", () => {
    const view = base([
      turn(0, { prompt: { kind: "human", text: "a", at: T }, tools: 1, interrupted: true }),
      turn(1, {
        prompt: { kind: "human", text: "b", at: T + 1 },
        tools: 1,
        apiError: "retry 3 of 10",
      }),
      turn(2, {
        prompt: { kind: "human", text: "c", at: T + 2 },
        tools: 1,
        error: "API Error: 529",
      }),
      turn(3, { prompt: { kind: "human", text: "d", at: T + 3 }, tools: 0 }),
    ]);
    const lines = conversationLines(view, {
      ...opts,
      live: 3,
      steps: new Map([[3, [tool(0)]]]),
    });
    const statuses = lines.flatMap((l) => (l.type === "status" ? [`${l.tone}:${l.text}`] : []));
    expect(statuses).toEqual(["quiet:Interrupted", "quiet:retry 3 of 10", "error:API Error: 529"]);
    // the live one has a work line even with no tool yet, and it is open
    const work = lines.filter((l) => l.type === "work");
    expect(work.at(-1)).toMatchObject({ open: true, live: true });
    expect(lines.at(-1)?.type).toBe("tool");
    const closed = conversationLines(view, { ...opts, live: 3, closedLive: true });
    expect(closed.at(-1)).toMatchObject({ type: "work", open: false });
  });

  it("heads each day when a conversation spans more than one", () => {
    const day = 24 * HOUR;
    const one = base([turn(0, { prompt: { kind: "human", text: "a", at: T }, tools: 0 })]);
    expect(conversationLines(one, opts).some((l) => l.type === "day")).toBe(false);
    const three = base([
      turn(0, { prompt: { kind: "human", text: "a", at: T - 2 * day }, tools: 0 }),
      { kind: "compact", n: 1, at: T - day },
      turn(2, { prompt: { kind: "human", text: "b", at: T - day + 1000 }, tools: 0 }),
      turn(3, { prompt: { kind: "human", text: "c", at: T }, tools: 0 }),
    ]);
    const headers = conversationLines(three, opts).flatMap((l) =>
      l.type === "day" ? [l.label] : [],
    );
    expect(headers).toEqual(["Wed 23 Sep", "Yesterday", "Today"]);
    expect(dayLabel(Date.parse("2025-12-31T10:00:00"), T)).toBe("Wed 31 Dec 2025");
  });

  it("says what the work was in one line", () => {
    const t0 = turn(0, { tools: 48, filesEdited: 6, agents: 2, durationMs: 12 * MIN });
    expect(workLine(t0, 0, false)).toBe("12m · 48 steps · 6 files edited · 2 agents");
    expect(workLine(turn(1, { tools: 1, filesEdited: 1, startedAt: 0 }), 90_000, true)).toBe(
      "2m · 1 step · 1 file edited",
    );
  });
});
