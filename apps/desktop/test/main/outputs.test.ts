import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  outputRulesKey,
  type SessionOutput,
  type SessionRecord,
  setOutputRules,
} from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  inheritedIds,
  loadOutputRules,
  outputViews,
  prWants,
} from "../../src/main/services/outputs.ts";
import type { SessionRow } from "../../src/shared/ipc.ts";

const out = (o: Partial<SessionOutput> & { url: string }): SessionOutput => ({
  kind: "pr",
  label: "Pull request",
  verb: "made",
  first: 1,
  last: 2,
  touches: 1,
  tool: "Bash",
  ...o,
});

const rec = (path: string, o: Partial<SessionRecord> = {}): SessionRecord =>
  ({ path, sessionId: path, activityMs: 100, ...o }) as SessionRecord;

const PR = "https://github.com/o/r/pull/7";

describe("a fork's copy of an output", () => {
  it("is inherited on the newer session, by the tool_use id", () => {
    const a = rec("a", { createdAt: 10, outputs: [out({ url: PR, id: "t1" })] });
    const b = rec("b", { createdAt: 20, outputs: [out({ url: PR, id: "t1" })] });
    const got = inheritedIds([b, a], () => 0);
    expect(got.get("b")).toEqual(new Set(["t1"]));
    expect(got.has("a")).toBe(false);
  });

  it("goes to the older file when the first lines tie, as they do in a fork", () => {
    const a = rec("a", { createdAt: 10, outputs: [out({ url: PR, id: "t1" })] });
    const b = rec("b", { createdAt: 10, outputs: [out({ url: PR, id: "t1" })] });
    const born = (p: string) => (p === "a" ? 5 : 9);
    expect([...inheritedIds([a, b], born).keys()]).toEqual(["b"]);
    expect([...inheritedIds([b, a], born).keys()]).toEqual(["b"]);
  });

  it("falls back to activity without a createdAt, and ignores ids only one session has", () => {
    const a = rec("a", {
      activityMs: 5,
      outputs: [out({ url: PR, id: "t1" }), out({ url: "x", id: "t2" })],
    });
    const b = rec("b", { activityMs: 9, outputs: [out({ url: PR, id: "t1" })] });
    const got = inheritedIds([a, b], () => 0);
    expect(got.get("b")).toEqual(new Set(["t1"]));
    expect(got.has("a")).toBe(false);
  });
});

describe("outputs as rows have them", () => {
  it("marks the copy, joins github's word on a PR, and drops the need", () => {
    const a = rec("a", { createdAt: 1, outputs: [out({ url: PR, id: "t1", key: "o/r#7" })] });
    const b = rec("b", { createdAt: 2, outputs: [out({ url: PR, id: "t1", key: "o/r#7" })] });
    const views = outputViews([a, b], (url) =>
      url === PR ? { state: "ready", title: "fix it", checkedAt: 5 } : undefined,
    );
    expect(views.get("a")?.[0]).toMatchObject({
      url: PR,
      pr: { number: 7, repo: "o/r", state: "ready" },
    });
    expect(views.get("a")?.[0]?.inherited).toBeUndefined();
    expect(views.get("b")?.[0]?.inherited).toBe(true);
  });

  it("fills a jira site another session learned, and has no url while none is known", () => {
    const wait = out({
      kind: "jira",
      label: "Jira card",
      url: "{site}/browse/CDIT-1",
      key: "CDIT-1",
      need: "c1",
    });
    const a = rec("a", { outputs: [wait] });
    expect(outputViews([a]).get("a")?.[0]?.url).toBeUndefined();
    const b = rec("b", { sites: { c1: "https://braze.atlassian.net/" } });
    const got = outputViews([a, b]).get("a")?.[0];
    expect(got?.url).toBe("https://braze.atlassian.net/browse/CDIT-1");
    expect(got?.pr).toBeUndefined();
  });
});

describe("the PRs PrService asks about", () => {
  const row = (outputs: SessionRow["outputs"], activityMs: number, live = false): SessionRow =>
    ({
      key: "k",
      sessionId: "s",
      projectLabel: "p",
      activityMs,
      parsed: true,
      outputs,
      ...(live ? { live: {} } : {}),
    }) as SessionRow;
  const pr = (url: string) => ({
    kind: "pr",
    label: "Pull request",
    verb: "made" as const,
    last: 1,
    touches: 1,
    url,
    pr: { url, number: 1, repo: "o/r" },
  });

  it("only github.com PRs on rows that are recent or live", () => {
    const rows = [
      row([pr(PR), { ...pr("https://ghe.corp/o/r/pull/2") }], 1000),
      row([pr("https://github.com/o/r/pull/9")], 0),
      row(
        [
          pr("https://github.com/o/r/pull/10"),
          { kind: "jira", label: "Jira card", verb: "made", last: 1, touches: 1, key: "A-1" },
        ],
        0,
        true,
      ),
    ];
    expect(prWants(rows, 2000, 1500, () => true).map((w) => w.url)).toEqual([
      PR,
      "https://github.com/o/r/pull/10",
    ]);
    expect(prWants(rows, 2000, 500, () => false)[0]?.working).toBe(false);
  });
});

describe("the person's own rules file", () => {
  afterEach(() => setOutputRules());
  const dirWith = (text?: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-rules-"));
    if (text !== undefined) writeFileSync(path.join(dir, "output-rules.json"), text);
    return dir;
  };
  const seed = outputRulesKey();

  it("a missing file is the seed", () => {
    loadOutputRules(dirWith());
    expect(outputRulesKey()).toBe(seed);
  });

  it("a rule in it changes what is read, and a bad file is the seed", () => {
    loadOutputRules(
      dirWith(
        JSON.stringify({
          hosts: [
            {
              match: "^https://jira\\.corp/browse/([A-Z]+-\\d+)",
              kind: "jira",
              label: "Jira card",
              key: "$1",
              vendor: ["jira"],
            },
          ],
        }),
      ),
    );
    expect(outputRulesKey()).not.toBe(seed);
    loadOutputRules(dirWith("{not json"));
    expect(outputRulesKey()).toBe(seed);
    loadOutputRules(dirWith(JSON.stringify({ hosts: "nope" })));
    expect(outputRulesKey()).toBe(seed);
    loadOutputRules(dirWith("[1]"));
    expect(outputRulesKey()).toBe(seed);
  });
});
