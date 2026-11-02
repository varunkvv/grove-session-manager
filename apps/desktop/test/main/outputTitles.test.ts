import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionOutput, SessionRecord } from "@grove/core";
import { describe, expect, it } from "vitest";
import { untitledAsks } from "../../src/main/services/outputs.ts";
import {
  type Ask,
  OUTPUT_TITLES_FILE,
  OutputTitles,
  parseTitles,
  titlePrompt,
} from "../../src/main/services/outputTitles.ts";

const asks: Ask[] = [
  {
    url: "https://acme.slack.com/archives/C1/p1",
    kind: "slack",
    label: "Slack message",
    hint: "false alarm,\nsafe to resolve",
  },
  { url: "https://claude.ai/artifact/A1", kind: "claude", label: "Claude artifact" },
];

describe("output titles", () => {
  it("the prompt numbers the items and asks for one json array", () => {
    const p = titlePrompt([...asks]);
    expect(p).toContain("1. kind: Slack message (slack)");
    expect(p).toContain("words: false alarm, safe to resolve");
    expect(p).toContain("2. kind: Claude artifact (claude)");
    expect(p).toContain("words: none");
  });

  it("a reply's array is read even with words around it, and a bad item is skipped", () => {
    const got = parseTitles(
      'here you go: [{"n": 1, "title": "slack alarm check", "description": ""}, {"n": 9, "title": "x"}, {"n": 2, "title": ""}] done',
      [...asks],
    );
    expect(got).toEqual([{ url: asks[0]!.url, title: "slack alarm check" }]);
    expect(parseTitles("no json here", asks)).toEqual([]);
  });

  it("writes once per url, asks at low effort with no tools, and keeps what it wrote", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grove-out-titles-"));
    const calls: string[][] = [];
    const t = new OutputTitles({
      stateDir: dir,
      claudeBin: async () => "claude",
      env: async () => ({}),
      enabled: () => true,
      onChange: () => {},
      run: async (_bin, args) => {
        calls.push([...args]);
        return {
          code: 0,
          stdout:
            '[{"n":1,"title":"slack alarm check","description":"a false alarm on the schedulers"},{"n":2,"title":"odds model"}]',
          stderr: "",
        } as never;
      },
    });
    t.want([...asks]);
    t.want([...asks]);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--effort");
    expect(calls[0]).toContain("low");
    expect(calls[0]).toContain("haiku");
    expect(calls[0]).toContain("--tools");
    expect(t.get(asks[0]!.url)).toMatchObject({ title: "slack alarm check" });
    expect(
      JSON.parse(readFileSync(path.join(dir, OUTPUT_TITLES_FILE), "utf8"))[asks[1]!.url].title,
    ).toBe("odds model");
  });

  it("the asks are the outputs with no title, key or written name, one per url", () => {
    const rec = (outputs: SessionOutput[]) => ({ path: "p", outputs }) as SessionRecord;
    const o = (over: Partial<SessionOutput>): SessionOutput =>
      ({
        kind: "slack",
        label: "Slack message",
        url: "u",
        verb: "made",
        first: 1,
        last: 1,
        touches: 1,
        tool: "t",
        ...over,
      }) as SessionOutput;
    const got = untitledAsks(
      [
        rec([
          o({ url: "u1" }),
          o({ url: "u1" }),
          o({ url: "u2", title: "named" }),
          o({ url: "u3", key: "CDIT-1" }),
          o({ url: "u4" }),
        ]),
      ],
      (url) => (url === "u4" ? { title: "written" } : undefined),
    );
    expect(got.map((a) => a.url)).toEqual(["u1"]);
  });
});
