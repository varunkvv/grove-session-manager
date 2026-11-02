import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxRow } from "../../src/renderer/components/Inbox.tsx";
import {
  OutputFilters,
  type OutputFiltersProps,
} from "../../src/renderer/components/OutputFilters.tsx";
import {
  dayRange,
  familiesOf,
  filterOutputs,
  glyphOf,
  lookOf,
  type OutputFilter,
  outputsKey,
  projectsOf,
  rangeLabel,
  SHORTCUTS,
  screenOutputs,
  sectionsOf,
  shortcutRange,
  shortKey,
} from "../../src/renderer/logic/outputs.ts";
import type { InboxRowView, OutputView, PrView, SessionRef } from "../../src/shared/ipc.ts";

const pr = (number: number, state?: PrView["state"], o: Partial<PrView> = {}): PrView => ({
  url: `https://github.com/o/r/pull/${number}`,
  repo: "o/r",
  number,
  ...(state ? { state } : {}),
  ...o,
});

const out = (o: Partial<OutputView> & { kind: string }): OutputView => ({
  label: o.kind,
  verb: "made",
  first: 1,
  last: 1,
  touches: 1,
  ...o,
});

const prOut = (n: number, state?: PrView["state"], o: Partial<OutputView> = {}): OutputView =>
  out({
    kind: "pr",
    label: "pull request",
    key: `o/r#${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    pr: pr(n, state),
    first: n,
    last: n,
    ...o,
  });

const jira = (key: string, o: Partial<OutputView> = {}): OutputView =>
  out({
    kind: "jira",
    label: "jira card",
    key,
    url: `https://braze.atlassian.net/browse/${key}`,
    ...o,
  });

describe("a PR's look", () => {
  it("is its state, and an open one with nothing known before gh answers", () => {
    expect(lookOf(pr(1, "failing"))).toMatchObject({ glyph: "open", tone: "red" });
    expect(lookOf(pr(1, "ready"))).toMatchObject({ glyph: "open", tone: "green" });
    expect(lookOf(pr(1, "merged"))).toMatchObject({ glyph: "merged", done: true });
    expect(lookOf(pr(5))).toMatchObject({ glyph: "open", tone: "faint", done: false });
  });
});

describe("a row's outputs", () => {
  it("a row draws none of them: no mark, no count, no label", () => {
    const row: InboxRowView = {
      key: "k",
      sessionId: "s1",
      title: "ship it",
      where: "ingest",
      project: "ingest",
      kind: "turn",
      at: 1,
      summary: "",
      open: {},
      reviewKeys: [],
      outputs: [prOut(7, "ready"), jira("CDIT-9")],
    } as unknown as InboxRowView;
    const html = renderToStaticMarkup(
      createElement(InboxRow, { row, active: false, open: false, tokens: [], onClick: () => {} }),
    );
    expect(html).toContain("ship it");
    expect(html).not.toMatch(/output|CDIT-9|#7/i);
  });

  it("a PR's `#n` is short, any other key is itself", () => {
    expect(shortKey(prOut(7))).toBe("#7");
    expect(shortKey(jira("CDIT-9"))).toBe("CDIT-9");
  });

  it("a row redraws when a PR's look moves, not otherwise", () => {
    expect(outputsKey([prOut(1, "ready")])).toBe(
      outputsKey([prOut(1, "ready", { pr: pr(1, "ready", { checkedAt: 9 }) })]),
    );
    expect(outputsKey([prOut(1, "ready")])).not.toBe(outputsKey([prOut(1, "failing")]));
  });
});

describe("the session card", () => {
  it("groups by kind label, made first, then updated and commented dimmed, a fork's copies last", () => {
    const sections = sectionsOf([
      jira("CDIT-1", { verb: "commented", last: 5 }),
      prOut(1, "ready", { last: 1 }),
      jira("CDIT-2", { last: 9 }),
      prOut(2, "merged", { last: 7 }),
      out({ kind: "gdoc", label: "google doc", url: "d", verb: "updated", last: 3 }),
      jira("CDIT-3", { inherited: true, last: 99 }),
    ]);
    expect(sections.map((s) => [s.tone, s.title, s.items.map((o) => o.key ?? o.url)])).toEqual([
      ["made", "Jira cards", ["CDIT-2"]],
      ["made", "Pull requests", ["o/r#2", "o/r#1"]],
      ["other", "Jira cards touched", ["CDIT-1"]],
      ["other", "Google docs touched", ["d"]],
      ["inherited", "From before the fork", ["CDIT-3"]],
    ]);
  });

  it("nothing made: no section", () => {
    expect(sectionsOf(undefined)).toEqual([]);
  });
});

describe("the Outputs screen", () => {
  const session = (id: string, outputs: OutputView[]): SessionRef =>
    ({ key: id, sessionId: id, title: id, outputs }) as SessionRef;

  it("newest first, one url once, one (kind, key) once, the earliest maker kept", () => {
    const a = session("a", [
      jira("CDIT-1", { first: 5, last: 10 }),
      prOut(1, "ready", { first: 1, last: 50 }),
    ]);
    // the same card through another site name, made later, touched last
    const b = session("b", [
      jira("CDIT-1", { url: "https://other.atlassian.net/browse/CDIT-1", first: 8, last: 40 }),
      prOut(1, "ready", { first: 1, last: 60, inherited: true }),
      jira("CDIT-2", { first: 9, last: 20 }),
    ]);
    const got = screenOutputs([b, a]);
    expect(got.map((e) => [e.o.key, e.session.key, e.o.last])).toEqual([
      ["o/r#1", "a", 60],
      ["CDIT-1", "a", 40],
      ["CDIT-2", "b", 20],
    ]);
  });

  it("a maker beats a session that only updated it", () => {
    const a = session("a", [jira("CDIT-1", { first: 1, verb: "updated" })]);
    const b = session("b", [jira("CDIT-1", { first: 9 })]);
    expect(screenOutputs([a, b]).map((e) => e.session.key)).toEqual(["b"]);
  });

  it("an output with no url and no key is kept as it is", () => {
    const a = session("a", [
      out({ kind: "link", label: "link" }),
      out({ kind: "link", label: "link" }),
    ]);
    expect(screenOutputs([a])).toHaveLength(2);
  });

  it("the filter chips are the families present, most first", () => {
    const got = familiesOf(
      screenOutputs([
        session("a", [jira("A-1"), jira("A-2"), prOut(1), out({ kind: "figma", url: "f" })]),
      ]),
    );
    expect(got).toEqual([
      { glyph: "issue", n: 2 },
      { glyph: "pr", n: 1 },
      { glyph: "design", n: 1 },
    ]);
    expect(glyphOf("unheard-of")).toBe("link");
  });
});

describe("the Outputs screen's filters", () => {
  const s2 = (id: string, where: string, outputs: OutputView[]): SessionRef =>
    ({ key: id, sessionId: id, title: id, where, outputs }) as SessionRef;

  it("projects are chips, most outputs first, and each is its session's where", () => {
    const entries = screenOutputs([
      s2("a", "billing", [jira("B-1"), jira("B-2")]),
      s2("b", "grove", [prOut(3)]),
    ]);
    expect(projectsOf(entries)).toEqual([
      { name: "billing", n: 2 },
      { name: "grove", n: 1 },
    ]);
  });

  it("set filters are ANDed across axes and ORed within one, and none set is all", () => {
    const entries = screenOutputs([
      s2("a", "billing", [jira("B-1"), prOut(4)]),
      s2("b", "grove", [prOut(3), jira("G-1")]),
    ]);
    expect(filterOutputs(entries, { projects: [], kinds: [] })).toHaveLength(4);
    expect(filterOutputs(entries, { projects: ["grove"], kinds: [] })).toHaveLength(2);
    expect(filterOutputs(entries, { projects: [], kinds: ["pr"] })).toHaveLength(2);
    expect(filterOutputs(entries, { projects: ["grove"], kinds: ["pr"] })).toHaveLength(1);
    expect(
      filterOutputs(entries, { projects: ["billing", "grove"], kinds: ["issue", "pr"] }),
    ).toHaveLength(4);
  });
});

describe("the date filter", () => {
  const now = new Date(2026, 10, 1, 15, 30).getTime();
  const day = (m: number, d: number) => new Date(2026, m, d).getTime();
  const endOf = (m: number, d: number) => new Date(2026, m, d + 1).getTime() - 1;

  it("a shortcut is whole local days ending today, any is no range", () => {
    expect(shortcutRange("any", now)).toEqual({});
    expect(shortcutRange("today", now)).toEqual({ from: day(10, 1), to: endOf(10, 1) });
    expect(shortcutRange("week", now)).toEqual({ from: day(9, 26), to: endOf(10, 1) });
    expect(shortcutRange("month", now)).toEqual({ from: day(9, 3), to: endOf(10, 1) });
    expect(shortcutRange("quarter", now)).toEqual({ from: day(7, 4), to: endOf(10, 1) });
    expect(shortcutRange("thisMonth", now)).toEqual({ from: day(10, 1), to: endOf(10, 1) });
    expect(shortcutRange("thisMonth", new Date(2026, 10, 20, 9).getTime()).from).toBe(day(10, 1));
    expect(SHORTCUTS.map((r) => r.value)).toEqual([
      "any",
      "today",
      "week",
      "month",
      "thisMonth",
      "quarter",
    ]);
  });

  it("two picks make a range in either order, and one day is a range", () => {
    const want = { from: day(9, 26), to: endOf(10, 1) };
    expect(dayRange(day(9, 26), day(10, 1))).toEqual(want);
    expect(dayRange(day(10, 1), day(9, 26))).toEqual(want);
    expect(dayRange(day(10, 1) + 5_000, day(10, 1))).toEqual({
      from: day(10, 1),
      to: endOf(10, 1),
    });
  });

  it("the button says the range in short local days", () => {
    expect(rangeLabel({})).toBe("Any time");
    expect(rangeLabel(shortcutRange("week", now))).toBe("Oct 26 \u2013 Nov 1");
    expect(rangeLabel(shortcutRange("today", now))).toBe("Nov 1");
  });

  it("keeps outputs last touched inside the days, both ends included", () => {
    const entries = screenOutputs([
      {
        key: "a",
        sessionId: "a",
        title: "a",
        where: "p",
        outputs: [
          jira("A-1", { last: day(10, 1) }),
          jira("A-2", { last: endOf(10, 1) }),
          jira("A-3", { last: day(9, 31) + 5_000 }),
          jira("A-4", { last: day(9, 25) }),
        ],
      } as SessionRef,
    ]);
    const keys = (f: Partial<OutputFilter>) =>
      filterOutputs(entries, { projects: [], kinds: [], ...f })
        .map((e) => e.o.key)
        .sort();
    expect(keys(shortcutRange("today", now))).toEqual(["A-1", "A-2"]);
    expect(keys(shortcutRange("week", now))).toEqual(["A-1", "A-2", "A-3"]);
    expect(keys({ from: day(9, 25) })).toEqual(["A-1", "A-2", "A-3", "A-4"]);
    expect(keys({ to: endOf(9, 31) })).toEqual(["A-3", "A-4"]);
    expect(keys({ from: day(9, 31), to: endOf(9, 31) })).toEqual(["A-3"]);
  });
});

describe("the filter bar", () => {
  const props: OutputFiltersProps = {
    projects: [
      { name: "billing", n: 3 },
      { name: "grove", n: 2 },
      { name: "kirby", n: 1 },
    ],
    families: [
      { glyph: "pr", n: 4 },
      { glyph: "issue", n: 2 },
    ],
    picked: { projects: ["billing", "grove", "kirby"], kinds: ["pr"] },
    range: shortcutRange("week", new Date(2026, 10, 1, 15).getTime()),
    now: new Date(2026, 10, 1, 15).getTime(),
    onProjects: () => {},
    onKinds: () => {},
    onRange: () => {},
  };
  const html = renderToStaticMarkup(createElement(OutputFilters, props));

  it("Project, Kind and When are closed dropdown buttons", () => {
    for (const id of ["outputs-project", "outputs-kind", "outputs-when"]) {
      expect(html).toMatch(
        new RegExp(`aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*data-testid="${id}"`),
      );
    }
    expect(html).not.toContain("outputs-project-popover");
  });

  it("what is picked shows as chips, two and then +N, and the range as its days", () => {
    expect(html).toContain("billing");
    expect(html).toContain("grove");
    expect(html).not.toContain(">kirby<");
    expect(html).toContain("+1");
    expect(html).toContain("Pull requests");
    expect(html).toContain('aria-label="Remove billing"');
    expect(html).toContain("Oct 26 \u2013 Nov 1");
  });
});
