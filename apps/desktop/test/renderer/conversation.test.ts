import { describe, expect, it } from "vitest";
import {
  applyTurns,
  conversationMeta,
  openLabel,
  spanLabel,
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
