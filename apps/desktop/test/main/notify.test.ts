import type { LiveStatus } from "@grove/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Note, Notifier, type NotifyOptions } from "../../src/main/services/notify.ts";
import type { LandingTarget } from "../../src/shared/ipc.ts";

interface Shown {
  title: string;
  body: string;
  click: () => void;
  close: () => void;
}

function setup(o: Partial<Pick<NotifyOptions, "enabled" | "focused">> = {}) {
  const shown: Shown[] = [];
  const landed: LandingTarget[] = [];
  const notifier = new Notifier({
    enabled: o.enabled ?? (() => true),
    focused: o.focused ?? (() => false),
    land: (t) => landed.push(t),
    create: ({ title, body }) => {
      const on: Record<string, () => void> = {};
      const note: Note = {
        on: (event, listener) => {
          on[event] = listener;
        },
        show: () =>
          shown.push({ title, body, click: () => on.click?.(), close: () => on.close?.() }),
      };
      return note;
    },
  });
  return { notifier, shown, landed };
}

const status = (o: Partial<LiveStatus> & Pick<LiveStatus, "state">): LiveStatus => ({
  at: 0,
  lastEventAt: 0,
  ...o,
});
const finished = (turnMs = 90_000, detail?: string) =>
  status({ state: "waiting", turnMs, ...(detail ? { detail } : {}) });
const S1 = { sessionId: "s1", title: "rounding fix", project: "chat", click: () => {} };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the bodies", () => {
  it("today's three keep their words, and a short turn says nothing", () => {
    const { notifier, shown } = setup();
    notifier.live(status({ state: "permission", detail: "Bash" }), S1);
    notifier.live(status({ state: "permission" }), S1);
    notifier.live(status({ state: "failed" }), S1);
    notifier.live(finished(90_000, "Done with the fix"), S1);
    notifier.live(finished(30_000), { ...S1, sessionId: "s2" });
    notifier.live(status({ state: "running" }), { ...S1, sessionId: "s3" });
    notifier.live(finished(), { sessionId: "s4", click: () => {} });
    expect(shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: "rounding fix", body: "Needs permission: Bash" },
      { title: "rounding fix", body: "Needs permission" },
      { title: "rounding fix", body: "Stopped on an API error" },
      { title: "rounding fix", body: "Finished after 2m: Done with the fix" },
      { title: "Claude session", body: "Finished after 2m" },
    ]);
  });

  it("a click runs what the caller said, once per notification", () => {
    const { notifier, shown } = setup();
    const click = vi.fn();
    notifier.live(status({ state: "failed" }), { ...S1, click });
    shown[0]?.click();
    expect(click).toHaveBeenCalledOnce();
  });
});

describe("a finished turn with a recap", () => {
  it("says what the recap says the person has to do, and a permission prompt never does", () => {
    const { notifier: n, shown } = setup();
    n.live(finished(120_000, "Done with the fix"), { ...S1, needs: "Pick the tenant." });
    n.live(status({ state: "permission", detail: "Bash" }), { ...S1, needs: "Pick." });
    expect(shown.map((s) => s.body)).toEqual([
      "Finished after 2m: Pick the tenant.",
      "Needs permission: Bash",
    ]);
  });
});

describe("one finished turn per session per two minutes", () => {
  it("a second turn that ends within two minutes says nothing", () => {
    const { notifier, shown } = setup();
    notifier.live(finished(), S1);
    vi.advanceTimersByTime(119_000);
    notifier.live(finished(90_000, "and the tests"), S1);
    expect(shown.map((s) => s.body)).toEqual(["Finished after 2m"]);
  });

  it("two minutes later, or another session: both", () => {
    const { notifier, shown } = setup();
    notifier.live(finished(), S1);
    notifier.live(finished(), { ...S1, sessionId: "s2" });
    vi.advanceTimersByTime(120_000);
    notifier.live(finished(), S1);
    expect(shown).toHaveLength(3);
  });

  it("permission and failed are never held back by it", () => {
    const { notifier, shown } = setup();
    notifier.live(finished(), S1);
    notifier.live(status({ state: "permission", detail: "Bash" }), S1);
    notifier.live(status({ state: "permission", detail: "Bash" }), S1);
    notifier.live(status({ state: "failed" }), S1);
    expect(shown).toHaveLength(4);
  });

  it("one that was not shown does not count", () => {
    let focused = true;
    const { notifier, shown } = setup({ focused: () => focused });
    notifier.setVisible("chat", false);
    notifier.live(finished(), S1);
    focused = false;
    notifier.live(finished(), S1);
    expect(shown.map((s) => s.body)).toEqual(["Finished after 2m"]);
  });
});

describe("stopped mid-turn", () => {
  const stop = (n: Notifier, sessionId: string, project = "chat", click = () => {}) =>
    n.stopped({ sessionId, title: `agent ${sessionId}`, project, click });

  it("one waits five seconds, then shows on its own", () => {
    const { notifier, shown } = setup();
    const click = vi.fn();
    stop(notifier, "s1", "chat", click);
    vi.advanceTimersByTime(4_999);
    expect(shown).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: "agent s1", body: "Stopped mid-turn" },
    ]);
    shown[0]?.click();
    expect(click).toHaveBeenCalledOnce();
  });

  it("three within five seconds fold into one that lands on the inbox", () => {
    const { notifier, shown, landed } = setup();
    stop(notifier, "s1", "chat");
    vi.advanceTimersByTime(2_000);
    stop(notifier, "s2", "chat");
    vi.advanceTimersByTime(2_000);
    stop(notifier, "s3", "data");
    vi.advanceTimersByTime(1_000);
    expect(shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: "Grove", body: "3 agents stopped mid-turn" },
    ]);
    shown[0]?.click();
    expect(landed).toEqual([{ view: "inbox" }]);
    // the next one starts a new window
    stop(notifier, "s4", "chat");
    vi.advanceTimersByTime(5_000);
    expect(shown.map((s) => s.body)).toEqual(["3 agents stopped mid-turn", "Stopped mid-turn"]);
  });

  it("is never held back by a finished turn", () => {
    const { notifier, shown } = setup();
    notifier.live(finished(), S1);
    stop(notifier, "s1");
    vi.advanceTimersByTime(5_000);
    expect(shown).toHaveLength(2);
  });
});

describe("a focused window holds back only what is on screen", () => {
  it("the visible project's waits, another project's shows, one in no project waits", () => {
    const { notifier, shown } = setup({ focused: () => true });
    notifier.setVisible("chat", false);
    notifier.live(status({ state: "failed" }), { ...S1, project: "chat" });
    notifier.live(status({ state: "failed" }), { ...S1, title: "data agent", project: "data" });
    notifier.live(status({ state: "failed" }), {
      sessionId: "s9",
      title: "loose",
      click: () => {},
    });
    expect(shown.map((s) => s.title)).toEqual(["data agent"]);
  });

  it("the inbox is every project's: all of them wait while it is on screen", () => {
    let focused = true;
    const { notifier, shown } = setup({ focused: () => focused });
    notifier.setVisible("chat", true);
    notifier.live(status({ state: "failed" }), { ...S1, project: "chat" });
    notifier.live(status({ state: "failed" }), { ...S1, project: "data" });
    notifier.stopped({ ...S1, project: "data" });
    vi.advanceTimersByTime(5_000);
    expect(shown).toHaveLength(0);
    // he looked away: the inbox on screen holds nothing back
    focused = false;
    notifier.live(status({ state: "failed" }), { ...S1, project: "data" });
    expect(shown).toHaveLength(1);
  });

  it("nothing on screen: every project's shows", () => {
    const { notifier, shown } = setup({ focused: () => true });
    notifier.setVisible("chat", false);
    notifier.setVisible(null, false);
    notifier.live(status({ state: "failed" }), S1);
    expect(shown).toHaveLength(1);
  });

  it("not focused: everything shows", () => {
    const { notifier, shown } = setup({ focused: () => false });
    notifier.setVisible("chat", false);
    notifier.live(status({ state: "failed" }), S1);
    notifier.live(status({ state: "failed" }), { sessionId: "s9", click: () => {} });
    expect(shown).toHaveLength(2);
  });

  it("stopped ones on screen leave the fold, the rest still notify", () => {
    const { notifier, shown } = setup({ focused: () => true });
    notifier.setVisible("chat", false);
    notifier.stopped({ sessionId: "s1", title: "a", project: "chat", click: () => {} });
    notifier.stopped({ sessionId: "s2", title: "b", project: "data", click: () => {} });
    vi.advanceTimersByTime(5_000);
    expect(shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: "b", body: "Stopped mid-turn" },
    ]);
  });

  it("switched off: nothing", () => {
    const { notifier, shown } = setup({ enabled: () => false });
    notifier.live(status({ state: "failed" }), S1);
    notifier.stopped({ ...S1, project: "chat" });
    vi.advanceTimersByTime(5_000);
    expect(shown).toHaveLength(0);
  });
});

describe("references to shown notifications", () => {
  const kept = (n: Notifier) => (n as unknown as { kept: unknown[] }).kept.length;

  it("kept until clicked or closed, the newest 50 at most", () => {
    const { notifier, shown } = setup();
    for (let i = 0; i < 60; i++) notifier.live(status({ state: "failed" }), S1);
    expect(shown).toHaveLength(60);
    expect(kept(notifier)).toBe(50);
    shown[59]?.click();
    shown[58]?.close();
    expect(kept(notifier)).toBe(48);
  });
});
