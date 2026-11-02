import { describe, expect, it } from "vitest";
import {
  familiesOf,
  glyphOf,
  lookOf,
  markOf,
  ordered,
  outputsKey,
  prsOf,
  screenOutputs,
  sectionsOf,
  shortKey,
} from "../../src/renderer/logic/outputs.ts";
import type { OutputView, PrView, SessionRef } from "../../src/shared/ipc.ts";

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

  it("menus and the chat's pane: open ones newest first, then merged and closed", () => {
    const { open, done } = ordered([
      pr(1, "merged"),
      pr(2, "ready"),
      pr(3, "closed"),
      pr(4, "draft"),
    ]);
    expect(open.map((p) => p.number)).toEqual([4, 2]);
    expect(done.map((p) => p.number)).toEqual([3, 1]);
  });
});

describe("a row's cell", () => {
  it("none: no mark, and a fork's copies alone are none", () => {
    expect(markOf(undefined)).toBeNull();
    expect(markOf([])).toBeNull();
    expect(markOf([prOut(1, "ready", { inherited: true })])).toBeNull();
  });

  it("one PR: its glyph, `#n`, and its state colour", () => {
    const m = markOf([prOut(2352, "failing")]);
    expect(m).toMatchObject({ glyph: "pr", label: "#2352", look: { tone: "red" } });
    expect(m?.single?.url).toBe("https://github.com/o/r/pull/2352");
  });

  it("one of another kind: its glyph and key, or the short label without one, no colour", () => {
    const m = markOf([jira("CDIT-1462")]);
    expect(m).toMatchObject({ glyph: "issue", label: "CDIT-1462" });
    expect(m?.look).toBeUndefined();
    expect(markOf([out({ kind: "claude", label: "claude artifact", url: "u" })])?.label).toBe(
      "Claude artifact",
    );
  });

  it("several: the glyph of the latest it made, and the count, made first in the menu", () => {
    const m = markOf([
      prOut(1, "ready", { last: 10 }),
      jira("CDIT-1", { last: 30, verb: "updated" }),
      jira("CDIT-2", { last: 20 }),
    ]);
    expect(m).toMatchObject({ glyph: "issue", label: "3" });
    expect(m?.single).toBeUndefined();
    expect(m?.made.map((o) => o.key)).toEqual(["CDIT-2", "o/r#1"]);
    expect(m?.other.map((o) => o.key)).toEqual(["CDIT-1"]);
  });

  it("several with a PR as the latest made one keeps the PR's colour", () => {
    const m = markOf([prOut(3, "ready", { last: 99 }), jira("CDIT-2")]);
    expect(m).toMatchObject({ glyph: "pr", label: "2", look: { tone: "green" } });
  });

  it("a fork's copies never count in the number", () => {
    const m = markOf([jira("CDIT-1"), jira("CDIT-2", { inherited: true })]);
    expect(m).toMatchObject({ label: "CDIT-1" });
  });

  it("a PR's `#n` is short, any other key is itself", () => {
    expect(shortKey(prOut(7))).toBe("#7");
    expect(shortKey(jira("CDIT-9"))).toBe("CDIT-9");
  });

  it("the chat's PR pane lists the PRs oldest first, a fork's copies out", () => {
    expect(
      prsOf([prOut(5), jira("A-1"), prOut(2), prOut(9, "ready", { inherited: true })]).map(
        (p) => p.number,
      ),
    ).toEqual([2, 5]);
  });

  it("the header redraws when a PR's look moves, not otherwise", () => {
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
      ["other", "Jira cards", ["CDIT-1"]],
      ["other", "Google docs", ["d"]],
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
