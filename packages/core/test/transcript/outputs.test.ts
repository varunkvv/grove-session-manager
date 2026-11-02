import { afterEach, describe, expect, it } from "vitest";
import { SEED_RULES } from "../../src/transcript/outputRules.ts";
import {
  mergeRules,
  OutputCollector,
  type OutputState,
  resolveSite,
  setOutputRules,
  verbOf,
  words,
} from "../../src/transcript/outputs.ts";

const T = Date.parse("2026-11-01T10:00:00.000Z");
let n = 0;

/** a call and its result, as Claude Code writes them */
function call(
  name: string,
  input: Record<string, unknown>,
  result: unknown,
  extra: Record<string, unknown> = {},
) {
  const id = `toolu_${++n}`;
  return [
    {
      type: "assistant",
      uuid: `u${n}`,
      message: { content: [{ type: "tool_use", id, name, input }] },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content:
              typeof result === "string"
                ? result
                : [{ type: "text", text: JSON.stringify(result) }],
            ...extra,
          },
        ],
      },
      ...(typeof result === "object" && !Array.isArray(result) ? {} : {}),
    },
  ];
}

function run(lines: Array<Record<string, unknown>>, s: OutputState = {}): OutputState {
  const c = new OutputCollector(s);
  for (const l of lines) {
    if (l.type === "assistant") c.calls(l, T);
    else if (l.type === "user") {
      const line = JSON.stringify(l);
      if (c.wants(line)) c.results(l, T);
    } else if (l.type === "pr-link") c.prLink(l, T);
  }
  return s;
}

afterEach(() => setOutputRules());

describe("verbOf", () => {
  it("reads a name's words", () => {
    expect(words("createJiraIssue")).toEqual(["create", "jira", "issue"]);
    expect(words("notion-create-pages")).toEqual(["notion", "create", "pages"]);
    expect(verbOf("create_pull_request")).toBe("made");
    expect(verbOf("slack_send_message")).toBe("made");
    expect(verbOf("add_issue_comment")).toBe("commented");
    expect(verbOf("update_text_style")).toBe("updated");
    expect(verbOf("get_document")).toBeNull();
    expect(verbOf("search_issues")).toBeNull();
    expect(verbOf("use_figma")).toBeNull();
  });
});

describe("outputs from tool calls", () => {
  it("an unlisted tool counts for its own vendor's url, made by the call", () => {
    const s = run(
      call(
        "mcp__linear__create_issue",
        { title: "fix the sync" },
        { url: "https://linear.app/acme/issue/ENG-12/fix-the-sync" },
      ),
    );
    expect(s.outputs).toMatchObject([
      {
        url: "https://linear.app/acme/issue/ENG-12",
        kind: "linear",
        key: "ENG-12",
        title: "fix the sync",
        verb: "made",
        tool: "create_issue",
      },
    ]);
  });

  it("a url from another vendor, or from a browser tool, is not an output", () => {
    const s = run([
      ...call("mcp__notes__create_note", {}, { link: "https://github.com/o/r/pull/3" }),
      ...call("mcp__claude-in-chrome__tabs_create_mcp", {}, "https://github.com/o/r/pull/4"),
    ]);
    expect(s.outputs).toBeUndefined();
  });

  it("a read is never an output, and its result is never parsed", () => {
    const c = new OutputCollector({});
    const [a, r] = call(
      "mcp__github__get_pull_request",
      {},
      { html_url: "https://github.com/o/r/pull/1" },
    );
    c.calls(a as Record<string, unknown>, T);
    expect(c.wants(JSON.stringify(r))).toBe(false);
  });

  it("a url the call was given is not made by it, but an edit touched it", () => {
    const given = "https://docs.google.com/document/d/abc123/edit";
    expect(
      run(call("mcp__gdrive__copy_file", { url: given }, { url: given })).outputs,
    ).toBeUndefined();
    expect(
      run(call("mcp__gdrive__update_file", { url: given }, { url: given })).outputs,
    ).toMatchObject([{ url: "https://docs.google.com/document/d/abc123", verb: "updated" }]);
  });

  it("a failed call makes nothing", () => {
    const s = run(
      call("mcp__slack__slack_send_message", {}, "https://x.slack.com/archives/C1/p1", {
        is_error: true,
      }),
    );
    expect(s.outputs).toBeUndefined();
  });

  it("one url once: the strongest verb wins and touches add up", () => {
    const url = "https://acme.slack.com/archives/C096/p1792169130192459";
    const s = run([
      ...call(
        "mcp__slack__slack_send_message",
        { message: "hi" },
        { message_link: `${url}?thread_ts=1&cid=C096` },
      ),
      ...call("mcp__slack__slack_update_message", {}, { message_link: url }),
    ]);
    expect(s.outputs).toHaveLength(1);
    expect(s.outputs?.[0]).toMatchObject({
      url,
      verb: "made",
      touches: 2,
      tool: "slack_send_message",
    });
  });

  it("a result split from its call by the offset is still read", () => {
    const [a, r] = call(
      "mcp__github__create_pull_request",
      { title: "t" },
      { html_url: "https://github.com/o/r/pull/9" },
    );
    const s: OutputState = {};
    new OutputCollector(s).calls(a as Record<string, unknown>, T);
    const resumed = structuredClone(s);
    const c = new OutputCollector(resumed);
    expect(c.wants(JSON.stringify(r))).toBe(true);
    c.results(r as Record<string, unknown>, T);
    expect(resumed.outputs?.[0]).toMatchObject({ key: "o/r#9", verb: "made" });
    expect(resumed.waiting).toBeUndefined();
  });
});

describe("the seeded tools", () => {
  it("a jira card is made from its key, and the site is learned from the cloud id", () => {
    const cloudId = "faca91cf-8b29-43c3-81c2-c56bd87e4c5a";
    const s = run([
      ...call(
        "mcp__claude_ai_Atlassian__atlassian__createJiraIssue",
        { cloudId, projectKey: "CDIT", summary: "preselect the source" },
        {
          id: "638345",
          key: "CDIT-1462",
          self: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/638345`,
        },
      ),
      ...call("mcp__claude_ai_Atlassian__atlassian__getAccessibleAtlassianResources", {}, [
        { id: cloudId, url: "https://braze.atlassian.net", name: "braze" },
      ]),
      ...call(
        "mcp__rovo__addCommentToJiraIssue",
        { cloudId, issueIdOrKey: "CDIT-1238", commentBody: "x" },
        { id: "1" },
      ),
    ]);
    const [made, comment] = s.outputs ?? [];
    expect(made).toMatchObject({
      url: "{site}/browse/CDIT-1462",
      need: cloudId,
      key: "CDIT-1462",
      title: "preselect the source",
      verb: "made",
      kind: "jira",
    });
    expect(resolveSite(made!, s.sites ?? {}).url).toBe(
      "https://braze.atlassian.net/browse/CDIT-1462",
    );
    expect(comment).toMatchObject({
      url: "https://braze.atlassian.net/browse/CDIT-1238",
      verb: "commented",
    });
  });

  it("a site name where the cloud id goes is used as the host", () => {
    const s = run(
      call(
        "mcp__atlassian__editJiraIssue",
        { cloudId: "jira.example.com", issueIdOrKey: "A-1" },
        { key: "A-1" },
      ),
    );
    expect(s.outputs?.[0]?.url).toBe("https://jira.example.com/browse/A-1");
  });

  it("a google doc edit is the doc, from its id", () => {
    const s = run(
      call(
        "mcp__claude_ai_MintMCP_Bundle__gdocs__insert_text",
        { document_id: "1V31-Vqb", text: "x" },
        { id: "1V31-Vqb", message: "ok" },
      ),
    );
    expect(s.outputs?.[0]).toMatchObject({
      url: "https://docs.google.com/document/d/1V31-Vqb/edit",
      kind: "gdoc",
      verb: "updated",
    });
  });

  it("an Artifact made from a type, but not a quickstart's type links", () => {
    const s = run([
      ...call(
        "Artifact",
        { action: "quickstart", intent: "design" },
        "type_url: https://claude.ai/artifact/QKN21svewxgy",
      ),
      ...call(
        "Artifact",
        { type_url: "https://claude.ai/artifact/QKN21svewxgy", title: "Odds" },
        { url: "https://claude.ai/artifact/HFMLePRc", title: "Odds", created_from_type: true },
      ),
    ]);
    expect(s.outputs).toMatchObject([
      { url: "https://claude.ai/artifact/HFMLePRc", kind: "claude", verb: "made", title: "Odds" },
    ]);
  });

  it("a claude doc is made by a batch that creates it", () => {
    const frame = { frame: { artifactUrl: "https://claude.ai/artifact/98RdquNi" } };
    const s = run([
      ...call(
        "mcp__claude_ai_Claude_Docs__batch",
        { container: { kind: "project", create: { name: "x" } } },
        frame,
      ),
      ...call("mcp__claude_ai_Claude_Docs__create", { object: "utterance" }, frame),
    ]);
    expect(s.outputs).toMatchObject([
      { url: "https://claude.ai/artifact/98RdquNi", verb: "made", touches: 2 },
    ]);
  });

  it("gh pr create: the url from its output, the title from its flag", () => {
    const s = run(
      call(
        "Bash",
        { command: 'cd x && gh pr create --title "fix the sync" --body b' },
        "https://github.com/braze-inc/kirby/pull/2352\n",
      ),
    );
    expect(s.outputs?.[0]).toMatchObject({
      url: "https://github.com/braze-inc/kirby/pull/2352",
      key: "braze-inc/kirby#2352",
      title: "fix the sync",
      verb: "made",
    });
  });

  it("other commands are never waited on", () => {
    const c = new OutputCollector({});
    const [a] = call("Bash", { command: "git push origin x" }, "https://github.com/o/r/pull/new/x");
    c.calls(a as Record<string, unknown>, T);
    expect(c.wants(JSON.stringify(a))).toBe(false);
  });

  it("a pr-link line is a pull request it touched", () => {
    const s = run([
      { type: "pr-link", prNumber: 5, prUrl: "https://github.com/o/r/pull/5", prRepository: "o/r" },
    ]);
    expect(s.outputs?.[0]).toMatchObject({ key: "o/r#5", verb: "updated", kind: "pr" });
  });
});

describe("a person's own rules", () => {
  it("go on top of the seed", () => {
    setOutputRules({
      hosts: [
        {
          match: "^https://wiki\\.acme\\.dev/p/\\d+",
          kind: "wiki",
          label: "acme wiki",
          vendor: ["acmewiki"],
        },
      ],
    });
    const s = run(call("mcp__acmewiki__create_page", {}, { url: "https://wiki.acme.dev/p/7" }));
    expect(s.outputs?.[0]).toMatchObject({ kind: "wiki", url: "https://wiki.acme.dev/p/7" });
  });

  it("a tool of theirs replaces the seed's", () => {
    const merged = mergeRules(SEED_RULES, { tools: [{ tool: "createJiraIssue", skip: true }] });
    expect(merged.tools.filter((t) => t.tool === "createJiraIssue")).toEqual([
      { tool: "createJiraIssue", skip: true },
    ]);
  });
});
