// the library in one process: the format, tolerant readers, derivations, argument checks, the
// registry agreeing with the texts generated from it, and the operations end to end.
//
//   pnpm vitest run packages/record/test/unit.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { CARD_ID, parseRecord, renderRecord } from "../src/format.ts";
import { syncProject } from "../src/index.ts";
import { indexLine } from "../src/ops.ts";
import {
  deriveStatus,
  questionsOf,
  readCard,
  readConclusions,
  readIndex,
  readProject,
  readRecord,
} from "../src/read.ts";
import { renderInstructions, renderRules } from "../src/render.ts";
import { mcpToolList, runTool, TOOLS } from "../src/tools.ts";
import { lastSaid, transcriptFile, turnAround } from "../src/transcript.ts";
import type { ClaimEvent, Comment } from "../src/types.ts";
import { asAgent, asPerson, cleanEnv, makeProject, tmpDir } from "./lib.ts";

const base = tmpDir("unit");
const TITLE =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a title that looks like shell and template syntax
  "-lead \"dq\" 'sq' `bt` $(whoami) $HOME ${X} \\back !bang #hash ; | & > < * ? ~ %s\nline two\ttab ünï 🙂 end ";

test("format: free text round-trips byte for byte", () => {
  const body = "\n---\nnot frontmatter\n---\n\ntrailing newline\n";
  const text = renderRecord(
    [
      ["title", TITLE],
      ["n", 3],
      ["list", ["D-1", "F-2"]],
    ],
    body,
  );
  const p = parseRecord(text);
  assert.deepEqual(p.problems, []);
  assert.equal(p.fields.title, TITLE);
  assert.equal(p.fields.v, 1);
  assert.deepEqual(p.fields.list, ["D-1", "F-2"]);
  assert.equal(p.body, body);
});

test("format: hand edits and half files are read, never thrown on", () => {
  const cases: [
    string,
    Partial<{ fields: Record<string, unknown>; body: string; problem: RegExp }>,
  ][] = [
    ["", { body: "", problem: /no frontmatter/ }],
    ["just a body", { body: "just a body", problem: /no frontmatter/ }],
    ["---\ntitle: x\n", { fields: { title: "x" }, problem: /not closed/ }],
    ["﻿---\r\ntitle: 'it''s'\r\n---\r\nbody\r\n", { fields: { title: "it's" }, body: "body" }],
    [
      "---\nrelated:\n  - D-1\n  - D-2\nflow: [D-3, D-4]\n---\n",
      { fields: { related: ["D-1", "D-2"], flow: ["D-3", "D-4"] } },
    ],
    ["---\na: 1\na: 2\n---\n", { fields: { a: 1 }, problem: /twice/ }],
    ["---\nv: 9\n---\n", { problem: /format 9/ }],
    ['---\ntitle: "broken \\q json"\n---\n', { fields: { title: "broken \\q json" } }],
    ["---\nnot a key line\n---\n", { problem: /not "key: value"/ }],
  ];
  for (const [text, want] of cases) {
    const p = parseRecord(text);
    if (want.fields)
      for (const [k, v] of Object.entries(want.fields))
        assert.deepEqual(p.fields[k], v, JSON.stringify(text));
    if (want.body !== undefined) assert.equal(p.body, want.body, JSON.stringify(text));
    if (want.problem)
      assert.ok(
        p.problems.some((x) => want.problem!.test(x)),
        `${JSON.stringify(text)}: ${p.problems}`,
      );
  }
  // random bytes never throw
  for (let i = 0; i < 2000; i++) {
    const s = Array.from({ length: Math.floor(Math.random() * 80) }, () =>
      String.fromCharCode(Math.floor(Math.random() * 128)),
    ).join("");
    parseRecord(Math.random() < 0.5 ? `---\n${s}` : s);
  }
});

test("readers: a broken project still reads, problems are listed", () => {
  const root = makeProject(path.join(base, "broken"));
  assert.ok(asAgent(root, "s1", "card_create", { title: "fine" }).ok);
  assert.ok(asAgent(root, "s1", "card_claim", { card: "AUTH-1" }).ok);
  // a card cut to nothing, a card of garbage, a claim with no event, a comment of an unknown kind
  fs.mkdirSync(path.join(root, "cards", "AUTH-2"));
  fs.writeFileSync(path.join(root, "cards", "AUTH-2", "card.md"), "");
  fs.mkdirSync(path.join(root, "cards", "AUTH-3"));
  fs.writeFileSync(path.join(root, "cards", "AUTH-3", "card.md"), "\u0000\u0001garbage");
  fs.writeFileSync(path.join(root, "cards", "AUTH-1", "claims", "0002.md"), "---\nseq: 2\n");
  fs.mkdirSync(path.join(root, "cards", "AUTH-1", "comments"));
  fs.writeFileSync(
    path.join(root, "cards", "AUTH-1", "comments", "0001.md"),
    "---\nkind: rant\nat: yesterday\n---\nhello",
  );
  fs.mkdirSync(path.join(root, "cards", "AUTH-4")); // a writer died before card.md
  fs.mkdirSync(path.join(root, "conclusions"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "conclusions", "D-1.md"),
    "---\nkind: finding\nwhat: mislabelled\n---\n",
  );
  fs.writeFileSync(path.join(root, "conclusions", "INDEX.md"), "torn li\nD-9 | decision | x\n");
  const r = readRecord(root);
  assert.deepEqual(
    r.cards.map((c) => c.id),
    ["AUTH-1", "AUTH-2", "AUTH-3"],
  );
  const c1 = r.cards[0]!;
  assert.equal(c1.status, "in_progress", "an unknown claim event changes nothing");
  assert.equal(c1.comments[0]!.kind, "comment");
  assert.ok(c1.comments[0]!.problems.some((p) => /"at" is not a time/.test(p)));
  assert.equal(r.cards[1]!.title, "(no title)");
  assert.equal(r.conclusions[0]!.kind, "decision", "the id letter wins");
  assert.ok(r.conclusions[0]!.problems.some((p) => /"kind" says finding/.test(p)));
  assert.deepEqual(
    readIndex(root).map((l) => l.id),
    ["D-1"],
    "torn lines skipped, a file with no line is read, a line with no file is dropped",
  );
  fs.writeFileSync(path.join(root, ".claude", "grove-project.json"), "{ not json");
  assert.ok(readProject(root)!.problems.includes("not valid JSON"));
  const bad = asAgent(root, "s1", "card_create", { title: "x" });
  assert.equal(bad.code, "unavailable");
  assert.match(bad.text, /Tell the person to open Grove once/);
});

test("record_state reads only, and fails as unavailable where there is no project", () => {
  const empty = path.join(base, "not a project");
  fs.mkdirSync(empty);
  const r = asAgent(empty, "s1", "record_state", {});
  assert.equal(r.code, "unavailable");
  assert.deepEqual(fs.readdirSync(empty), [], "record_state wrote something");
  const root = makeProject(path.join(base, "fresh"));
  assert.ok(asAgent(root, "s1", "record_state", {}).ok);
  assert.deepEqual(fs.readdirSync(root), [".claude"], "record_state made a folder");
});

test("derivations: status and holder from the claim log", () => {
  const ev = (seq: number, event: string, session: string): ClaimEvent =>
    ({
      seq,
      event,
      session,
      agent: session,
      at: `2026-10-02T00:00:0${seq}Z`,
      pid: 1,
      pidStart: "",
      host: "h",
      by: "agent",
    }) as ClaimEvent;
  assert.deepEqual(deriveStatus([]), { status: "todo", holder: null });
  const held = deriveStatus([ev(1, "claim", "a"), ev(2, "claim", "a")]);
  assert.equal(held.status, "in_progress");
  assert.equal(held.holder!.since, "2026-10-02T00:00:01Z", "a refresh keeps the first time");
  assert.equal(deriveStatus([ev(1, "claim", "a"), ev(2, "takeover", "b")]).holder!.session, "b");
  assert.equal(deriveStatus([ev(1, "claim", "a"), ev(2, "release", "a")]).status, "todo");
  assert.equal(deriveStatus([ev(1, "claim", "a"), ev(2, "done", "a")]).status, "done");
  assert.equal(deriveStatus([ev(1, "cancel", "person")]).status, "canceled");
  assert.equal(deriveStatus([ev(1, "claim", "a"), ev(2, "archived", "a")]).status, "in_progress");
});

test("derivations: questions are open until an answer names them", () => {
  const c = (seq: number, kind: string, extra: Partial<Comment> = {}): Comment =>
    ({
      seq,
      kind,
      card: "AUTH-1",
      text: "",
      at: "",
      by: "agent",
      session: "s",
      agent: "",
      artifacts: [],
      file: "",
      problems: [],
      ...extra,
    }) as Comment;
  const qs = questionsOf([
    c(1, "question", { to: "person" }),
    c(2, "comment"),
    c(3, "question", { to: "AUTH-2" }),
    c(4, "answer", { answers: 1 }),
    c(5, "answer", { answers: 1 }),
  ]);
  assert.deepEqual(
    qs.map((q) => [q.seq, q.open, q.answeredBy]),
    [
      [1, false, [4, 5]],
      [3, true, []],
    ],
  );
});

test("derivations: superseded, chains and two that replace the same one", () => {
  const root = makeProject(path.join(base, "supersede"));
  const rec = (what: string, replaces?: string) => {
    const r = asAgent(root, "s1", "conclusion_record", {
      kind: "decision",
      what,
      replaces,
      by: "agent",
    });
    assert.ok(r.ok, r.text);
    return r.text.split(" ")[0]!;
  };
  const d1 = rec("redis");
  const d2 = rec("postgres", d1);
  rec("sqlite", d2);
  // a second replacement of D-1 is refused now, but two writers that both saw D-1 current can still
  // land one each (the check is not part of the link). readers must handle it, so write it by hand
  assert.equal(
    asAgent(root, "s1", "conclusion_record", {
      kind: "decision",
      what: "memcached",
      replaces: d1,
      by: "agent",
    }).code,
    "invalid",
  );
  fs.writeFileSync(
    path.join(root, "conclusions", "D-4.md"),
    '---\nv: 1\nid: D-4\nkind: decision\nwhat: "memcached"\nwhy: ""\nby: agent\nsession: s1\nat: 2099-01-01T00:00:00.000Z\nreplaces: D-1\n---\n',
  );
  const all = readConclusions(root);
  const by = (id: string) => all.find((x) => x.id === id)!;
  assert.deepEqual([by("D-1").superseded, by("D-1").replacedBy], [true, ["D-2", "D-4"]]);
  assert.deepEqual(
    [by("D-2").superseded, by("D-3").superseded, by("D-4").superseded],
    [true, false, false],
  );
  const search = asAgent(root, "s1", "conclusion_search", { query: "redis" });
  assert.match(search.text, /^0 conclusions match "redis"/);
  assert.match(search.text, /1 superseded and not shown: D-1 \(replaced by D-2, D-4\)/);
  assert.match(
    asAgent(root, "s1", "conclusion_search", { query: "d-1" }).text,
    /SUPERSEDED by D-2, D-4 - do not follow this one/,
  );
  assert.equal(
    asAgent(root, "s1", "conclusion_record", {
      kind: "decision",
      what: "x",
      replaces: "D-99",
      by: "agent",
    }).code,
    "not_found",
  );
});

test("validation: small slips are repaired, the rest refused with an example", () => {
  const root = makeProject(path.join(base, "validate"));
  asAgent(root, "s1", "card_create", { title: "one" });
  assert.ok(asAgent(root, "s1", "card_claim", { card: " auth-1 " }).ok);
  assert.ok(asAgent(root, "s1", "question_ask", { card: "auth-1", text: "a or b?" }).ok);
  assert.ok(
    asAgent(root, "s1", "question_answer", { card: "AUTH-1", question: "1", text: "a" }).ok,
  );
  // sonnet sent `answer` in the decision-29 trial
  assert.ok(
    asAgent(root, "s1", "question_answer", { card: "AUTH-1", question: 1, answer: "b" }).ok,
  );
  assert.match(
    asAgent(root, "s1", "question_answer", { card: "AUTH-1", question: "AUTH-9#3", text: "a" })
      .text,
    /"question" must be a whole number, 1 or more\. For AUTH-4#6 pass 6/,
  );
  assert.ok(
    asAgent(root, "s1", "conclusion_record", {
      kind: "Decision",
      what: "a\u001b[31m red\u0007",
      related: "",
      changes_plan: "false",
      by: "Person",
    }).ok,
  );
  assert.match(
    fs.readFileSync(path.join(root, "conclusions", "D-1.md"), "utf8"),
    /\nwhat: "a \[31m red"\n/,
    "control characters are stripped from one-line fields",
  );
  assert.ok(
    asAgent(root, "s1", "conclusion_record", {
      kind: "finding",
      what: "b",
      related: ["d-1", "D-1"],
      by: "agent",
    }).ok,
  );
  assert.match(
    asAgent(root, "s1", "conclusion_record", {
      kind: "finding",
      what: "b",
      related: "d-1, D-1",
      by: "agent",
    }).text,
    /"related" must be a list of ids/,
  );
  assert.match(
    asAgent(root, "s1", "card_create", { title: "t", needs: '["AUTH-1"]' }).text,
    /"needs" must be a list of ids/,
  );
  const r = asAgent(root, "s1", "conclusion_record", {
    kind: "decision",
    what: "x".repeat(301),
    by: "agent",
  });
  assert.equal(r.code, "invalid");
  assert.match(
    r.text,
    /"what" is 301 characters, the limit is 300\. Shorten it and put the detail in the other text argument/,
  );
  assert.match(
    asAgent(root, "s1", "conclusion_record", { kind: "decision", what: "8h idle timeout" }).text,
    /"by" is required/,
  );
  assert.match(
    asAgent(root, "s1", "card_release", { card: "AUTH-1", text: "stopped at the form" }).text,
    /^AUTH-1 released/,
  );
  assert.ok(asAgent(root, "s1", "card_claim", { card: "AUTH-1" }).ok);
  assert.match(
    asAgent(root, "s1", "card_create", {}).text,
    /"title" is required\. card_create takes: title \(required\)/,
  );
  assert.match(
    asAgent(root, "s1", "card_done", {
      card: "AUTH-1",
      summary: "s",
      artifacts: [{ type: "image", ref: "x" }],
    }).text,
    /each entry of "artifacts" must be \{"type": "file" \| "branch" \| "pr" \| "link"/,
  );
  assert.match(
    asAgent(root, "s1", "comment_add", {
      card: "AUTH-1",
      text: "x",
      artifacts: '[{"type":"pr","ref":"https://github.com/o/r/pull/3"}]',
    }).text,
    /"artifacts" must be a list/,
  );
  assert.match(
    asAgent(root, "s1", "comment_add", { card: "AUTH-1", text: "x", artifacts: ["artifacts/x.md"] })
      .text,
    /each entry of "artifacts" must be/,
  );
  for (const ref of ["../../../../etc/passwd", "/Users/me/.ssh/id_rsa", "artifacts/../../x"])
    assert.match(
      asAgent(root, "s1", "comment_add", {
        card: "AUTH-1",
        text: "x",
        artifacts: [{ type: "file", ref }],
      }).text,
      /must be a path from the project root/,
    );
  assert.ok(
    asAgent(root, "s1", "card_done", {
      card: "AUTH-1",
      summary: "s",
      artifacts: [
        { type: "pr", ref: "https://github.com/o/r/pull/3" },
        { type: "file", ref: "artifacts/x.md" },
      ],
    }).ok,
  );
  assert.match(
    fs.readFileSync(
      path.join(
        root,
        "cards",
        "AUTH-1",
        "claims",
        fs
          .readdirSync(path.join(root, "cards", "AUTH-1", "claims"))
          .sort()
          .at(-1)!,
      ),
      "utf8",
    ),
    /artifacts: \[\{"type":"pr","ref":"https:\/\/github.com\/o\/r\/pull\/3"\},\{"type":"file","ref":"artifacts\/x.md"\}\]/,
  );
  assert.ok(
    !CARD_ID.test("D-1") && !CARD_ID.test("V-2") && CARD_ID.test("DATA-1") && CARD_ID.test("A-1"),
  );
  assert.equal(syncProject(root, { prefix: "F", name: "x", goal: "" }).code, "invalid");
});

test("the INDEX line stays under 1,000 bytes whatever `what` holds", () => {
  const what = "🙂".repeat(300);
  const line = indexLine({
    id: "D-123456",
    kind: "decision",
    at: "2026-10-02T18:24:13.123Z",
    card: "ABCDEFGH-123456",
    by: "person",
    replaces: "D-123455",
    what,
  });
  assert.ok(Buffer.byteLength(line) < 1000, `${Buffer.byteLength(line)} bytes`);
});

test("the registry, the rules file and the server instructions agree", () => {
  const served = mcpToolList().map((t) => t.name as string);
  assert.deepEqual(new Set(served).size, served.length);
  const rules = renderRules({
    launcher: "/Users/x/claude-ws/.grove/bin/record",
    prefix: "AUTH",
    root: "/Users/x/claude-ws/auth",
  });
  const named = (text: string) =>
    new Set(
      [...text.matchAll(/`?\b([a-z]+_[a-z_]+)\b`?/g)]
        .map((m) => m[1]!)
        .filter(
          (w) =>
            TOOLS.some((t) => t.name === w) ||
            /^(card|conclusion|question|comment|record|my)_/.test(w),
        ),
    );
  for (const n of named(rules))
    assert.ok(served.includes(n), `the rules name ${n}, which is not served`);
  for (const n of served) assert.ok(rules.includes(`\`${n}\``), `the rules do not list ${n}`);
  const instr = renderInstructions();
  assert.ok(instr.length < 600, `${instr.length} characters`);
  for (const n of named(instr)) assert.ok(served.includes(n), `the instructions name ${n}`);
  for (const t of mcpToolList())
    assert.ok(
      (t.description as string).length <= 2048,
      `${t.name}: ${(t.description as string).length}`,
    );
  // every example in the registry passes its own validation
  for (const t of TOOLS) {
    const r = asAgent(
      makeProject(path.join(base, `example ${t.name}`)),
      "s1",
      t.name,
      t.input.example,
    );
    assert.notEqual(r.code, "invalid", `${t.name} example: ${r.text}`);
  }
  // every CLI example in the rules passes validation, so the fallback an agent copies works
  for (const m of rules.matchAll(
    / call ([a-z_]+) '(\{.*\})' --root \/Users\/x\/claude-ws\/auth$/gm,
  )) {
    const r = asAgent(
      makeProject(path.join(base, `rules example ${m[1]}`)),
      "s1",
      m[1]!,
      JSON.parse(m[2]!.replace(/"\.\.\."/g, '"x"')),
    );
    assert.notEqual(r.code, "invalid", `rules example ${m[1]}: ${r.text}`);
  }
  // decision 12's fallback is in the rules, single-quoted, and no heredoc is taught
  assert.match(
    rules,
    /^ {4}\/Users\/x\/claude-ws\/.grove\/bin\/record call card_claim '\{"card":"AUTH-3"\}' --root \/Users\/x\/claude-ws\/auth$/m,
  );
  assert.match(
    renderRules({ launcher: "/Users/x y/.grove/bin/record", prefix: "AUTH", root: "/r" }),
    /^ {4}'\/Users\/x y\/.grove\/bin\/record' call card_claim/m,
    "a path with a space is quoted",
  );
  assert.doesNotMatch(rules, /<<'?JSON/);
  assert.match(rules, /context\/in-progress\.md/);
});

test("operations: a question to the person, answered by the person, then recorded as theirs", () => {
  const root = makeProject(path.join(base, "qa"));
  asAgent(root, "s1", "card_create", { title: "login" });
  asAgent(root, "s1", "card_claim", { card: "AUTH-1" });
  const q = asAgent(root, "s1", "question_ask", {
    card: "AUTH-1",
    text: "dev tenant or prod tenant?",
  });
  assert.match(
    q.text,
    /^AUTH-1#1 asked, to the person\..*Now ask the person the same question in the chat/,
  );
  assert.equal(readCard(root, "AUTH-1")!.asksPerson, true);
  const a = asAgent(root, "s1", "question_answer", {
    card: "AUTH-1",
    question: 1,
    text: "dev tenant",
    by: "person",
  });
  assert.match(
    a.text,
    /AUTH-1#2 answers #1\. AUTH-1#1 is closed\..*conclusion_record with card "AUTH-1" and by "person"/,
  );
  assert.equal(readCard(root, "AUTH-1")!.asksPerson, false);
  const d = asAgent(root, "s1", "conclusion_record", {
    kind: "decision",
    what: "staging uses a dev tenant",
    card: "AUTH-1",
    by: "person",
    related: [],
  });
  assert.match(d.text, /^D-1 recorded: decision, the person's\./);
  const text = fs.readFileSync(path.join(root, "conclusions", "D-1.md"), "utf8");
  assert.match(text, /\nby: person\nsession: s1\nagent: "s1"\n/);
});

test("operations: a question to another card's agent reaches it through my_cards", () => {
  const root = makeProject(path.join(base, "q-agent"));
  asAgent(root, "s1", "card_create", { title: "api" });
  asAgent(root, "s2", "card_create", { title: "web" });
  asAgent(root, "s1", "card_claim", { card: "AUTH-1" });
  asAgent(root, "s2", "card_claim", { card: "AUTH-2" });
  assert.match(
    asAgent(root, "s2", "question_ask", {
      card: "AUTH-2",
      text: "what does /session return?",
      to: "auth-1",
    }).text,
    /to the agent on AUTH-1 \(s1 holds AUTH-1 now\)/,
  );
  const mine = asAgent(root, "s1", "my_cards", {});
  assert.match(mine.text, /questions other agents left for you:\nAUTH-2#1 for AUTH-1 \| s2 \|/);
  asAgent(root, "s1", "question_answer", { card: "AUTH-2", question: 1, text: "a session id" });
  assert.match(asAgent(root, "s2", "my_cards", {}).text, /new answer #2 to #1 \| s1 \|/);
  assert.doesNotMatch(asAgent(root, "s1", "my_cards", {}).text, /questions other agents left/);
});

test("a stray file where a card folder goes is stepped over", () => {
  const root = makeProject(path.join(base, "stray"));
  assert.ok(asAgent(root, "s1", "card_create", { title: "one" }).ok);
  fs.writeFileSync(path.join(root, "cards", "AUTH-2"), "written by hand\n");
  assert.match(asAgent(root, "s1", "card_create", { title: "two" }).text, /^AUTH-3 created/);
  assert.match(asAgent(root, "s1", "card_create", { title: "three" }).text, /^AUTH-4 created/);
  fs.mkdirSync(path.join(root, "conclusions", "D-1.md"), { recursive: true });
  assert.match(
    asAgent(root, "s1", "conclusion_record", { kind: "decision", what: "x", by: "agent" }).text,
    /^D-2 recorded/,
  );
});

test("replacing a conclusion that is already replaced is refused, with the current one named", () => {
  const root = makeProject(path.join(base, "replace twice"));
  asAgent(root, "s1", "conclusion_record", {
    kind: "decision",
    what: "sessions live 12h",
    by: "person",
  });
  asAgent(root, "s1", "conclusion_record", {
    kind: "decision",
    what: "sessions live 8h",
    by: "person",
    replaces: "D-1",
  });
  const r = asAgent(root, "s2", "conclusion_record", {
    kind: "decision",
    what: "sessions live 24h",
    by: "agent",
    replaces: "D-1",
  });
  assert.equal(r.code, "invalid");
  assert.equal(
    r.text,
    'D-1 was already replaced by D-2 ("sessions live 8h", the person\'s). Read it with conclusion_search, then pass replaces "D-2" if you mean to overrule it.',
  );
  assert.ok(
    asAgent(root, "s2", "conclusion_record", {
      kind: "decision",
      what: "sessions live 24h",
      by: "agent",
      replaces: "D-2",
    }).ok,
  );
});

test("the project file: rev never goes back, long text is cut, the prefix follows the cards on disk", () => {
  const root = makeProject(path.join(base, "project file"));
  for (const g of ["a", "b", "c"]) syncProject(root, { prefix: "AUTH", name: "p", goal: g });
  asAgent(root, "s1", "card_create", { title: "x" });
  asAgent(root, "s1", "comment_add", { card: "AUTH-1", text: "x" });
  const file = path.join(root, ".claude", "grove-project.json");
  const before = JSON.parse(fs.readFileSync(file, "utf8")).rev;
  fs.writeFileSync(file, '{"v":1,"name":"p","prefix":"AUTH","goal":');
  assert.ok(syncProject(root, { prefix: "AUTH", name: "p", goal: "c" }).ok);
  assert.ok(
    JSON.parse(fs.readFileSync(file, "utf8")).rev > before,
    "rev went back after a broken file",
  );
  assert.ok(syncProject(root, { prefix: "AUTH", name: "p", goal: "g".repeat(2500) }).ok);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).goal.length, 2000);
  fs.rmSync(file);
  const r = syncProject(root, { prefix: "NEW", name: "p", goal: "g" });
  assert.equal(r.ok, false);
  assert.match(
    r.text,
    /already has cards with prefix AUTH \(1 of them\)\. the prefix cannot change/,
  );
});

// ---------- sources, what the person said, and the conversation a conclusion was recorded in ----------

/** one session's transcript in a claude config folder, with lines the way claude code 2.1.286 writes them. */
function transcript(claude: string, session: string, lines: object[]): string {
  const dir = path.join(claude, "projects", "-tmp-some-project");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return file;
}
const userLine = (content: unknown, extra: object = {}) => ({
  parentUuid: null,
  isSidechain: false,
  type: "user",
  message: { role: "user", content },
  uuid: "u1",
  timestamp: "2026-10-04T10:00:00.000Z",
  ...extra,
});
const typedLine = (text: string) =>
  userLine([{ type: "text", text }], { origin: { kind: "human" } });
const says = (...content: object[]) => ({
  parentUuid: "u1",
  isSidechain: false,
  type: "assistant",
  message: { role: "assistant", id: "msg_1", content },
});
const calls = (id: string, name = "Bash") => ({ type: "tool_use", id, name, input: {} });
const resultLine = (id: string, text: string) =>
  userLine([{ type: "tool_result", tool_use_id: id, content: text }], {
    toolUseResult: { stdout: text },
  });
const queued = (text: unknown, kind = "human", commandMode = "prompt") => ({
  type: "attachment",
  attachment: { type: "queued_command", prompt: text, commandMode, origin: { kind } },
});
/** everything claude code writes into a transcript that looks like a turn and is not the person typing. */
const NOISE = [
  resultLine("toolu_a", 'a result that quotes {"type":"user"} and a prompt'),
  userLine([{ type: "text", text: "[Image: original 800x600]" }], { isMeta: true }),
  userLine("<task-notification><task-id>b1</task-id></task-notification>", {
    origin: { kind: "task-notification" },
  }),
  userLine("a subagent's report, written like a prompt", { origin: { kind: "peer" } }),
  userLine("<system-reminder>hook output: lint passed</system-reminder>"),
  userLine("<command-name>/compact</command-name><command-args></command-args>"),
  userLine("<local-command-stdout>Compacted</local-command-stdout>"),
  userLine("This session is being continued from a previous one.", { isCompactSummary: true }),
  userLine("[Request interrupted by user]"),
  userLine("a subagent's own prompt", { isSidechain: true }),
  { type: "attachment", attachment: { type: "hook_success", stdout: "ok" } },
  queued("<task-notification>done</task-notification>", "task-notification", "task-notification"),
  queued("[Subagent hand-back] the report follows", "peer"),
  { type: "last-prompt", lastPrompt: "an older prompt claude code keeps for its own titles" },
];

test("said: the last thing the person typed, and nothing else that looks like a turn", () => {
  const claude = path.join(base, "said claude");
  const projects = path.join(claude, "projects");
  const file = transcript(claude, "sess-said", [
    typedLine("the first prompt"),
    says({ type: "text", text: "on it" }, calls("toolu_a")),
    ...NOISE,
    // the editor's context and a hook's reminder ride on the prompt. only the typed part is kept
    userLine(
      [
        { type: "text", text: "<ide_opened_file>src/a.ts</ide_opened_file>" },
        { type: "text", text: "<system-reminder>be brief</system-reminder>\nno, use redis" },
      ],
      { origin: { kind: "human" } },
    ),
    says({ type: "text", text: "ok" }, calls("toolu_b")),
    ...NOISE,
  ]);
  assert.equal(transcriptFile(projects, "sess-said"), file);
  assert.equal(lastSaid(file), "no, use redis");

  // typed while the agent worked: claude code writes an attachment, never a user line
  fs.appendFileSync(file, `${JSON.stringify(queued([{ type: "text", text: "8h, not 24" }]))}\n`);
  fs.appendFileSync(file, `${JSON.stringify(NOISE[0])}\n`);
  assert.equal(lastSaid(file), "8h, not 24");
  // a line from before claude code wrote an origin, and a prompt that names the keys the reader looks for
  fs.appendFileSync(
    file,
    `${JSON.stringify(userLine('why is "toolUseResult": {"type":"user"} here?'))}\n`,
  );
  assert.equal(lastSaid(file), 'why is "toolUseResult": {"type":"user"} here?');
  // a line still being written is not read as one
  fs.appendFileSync(file, '{"type":"user","message":{"role":"user","content":"half a li');
  assert.equal(lastSaid(file), 'why is "toolUseResult": {"type":"user"} here?');
  // a turn started with a slash command: its arguments are what the person said. one with none says nothing
  const command = (name: string, args: string) =>
    userLine(
      `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`,
      { origin: { kind: "human" } },
    );
  fs.appendFileSync(file, `\n${JSON.stringify(command("loop", "watch the rollout\nevery 5m"))}\n`);
  fs.appendFileSync(file, `${JSON.stringify(command("mcp", ""))}\n`);
  assert.equal(lastSaid(file), "/loop watch the rollout\nevery 5m");

  // nothing to read is nothing, never a throw
  assert.equal(transcriptFile(projects, "no-such-session"), null);
  assert.equal(transcriptFile(path.join(base, "no claude here"), "sess-said"), null);
  for (const bad of ["", "person/../x", "../sess-said", ".hidden"])
    assert.equal(transcriptFile(projects, bad), null, bad);
  assert.equal(lastSaid(path.join(projects, "missing.jsonl")), undefined);
  assert.equal(lastSaid(projects), undefined, "a folder");
  const junk = path.join(projects, "junk.jsonl");
  fs.writeFileSync(junk, Buffer.from([0, 255, 10, 123, 34, 10, 10, 200]));
  assert.equal(lastSaid(junk), undefined);
  assert.equal(lastSaid(transcript(claude, "only-noise", NOISE)), undefined);
});

test("said: bounded. a line longer than a read is still whole, and 8MB back is as far as it looks", () => {
  const claude = path.join(base, "said far");
  const big = (mb: number) => resultLine("toolu_big", "x".repeat(mb * 1024 * 1024));
  // 2.5MB in one line, across three 1MB reads
  const near = transcript(claude, "near", [
    typedLine("go with the dev tenant"),
    big(2.5),
    big(0.1),
  ]);
  assert.equal(lastSaid(near), "go with the dev tenant");
  const far = transcript(claude, "far", [typedLine("too far back"), big(3), big(3), big(3)]);
  const t0 = process.hrtime.bigint();
  assert.equal(lastSaid(far), undefined);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`lastSaid over the full 8MB window, nothing found: ${ms.toFixed(1)}ms`);
  assert.ok(ms < 250, `${ms}ms`);
});

/** conclusion_record as the MCP server runs it: a session with a transcript, and the call's own id. */
function asSession(
  root: string,
  claude: string,
  session: string,
  tool: string,
  args: Record<string, unknown>,
  toolUseId?: string,
) {
  return runTool(tool, args, {
    root,
    toolUseId,
    env: cleanEnv({
      CLAUDE_CONFIG_DIR: claude,
      GROVE_RECORD_SESSION: session,
      GROVE_RECORD_PID: String(process.pid),
      GROVE_RECORD_AGENT: "session store",
      GROVE_RECORD_REGISTRY: "/nonexistent",
    }),
  });
}

test("conclusion_record keeps what the person said, and a transcript it cannot read costs nothing", () => {
  const root = makeProject(path.join(base, "said record"));
  const claude = path.join(base, "said record claude");
  const long = `use redis.\n\nthe thread:\u001b[31m ${"ops said a cookie cannot be revoked. ".repeat(80)}`;
  transcript(claude, "sess-1", [typedLine(long), says(calls("toolu_rec"))]);
  const rec = (session: string) =>
    asSession(root, claude, session, "conclusion_record", {
      kind: "decision",
      what: "Sessions move to redis.",
      by: "person",
    });
  assert.ok(rec("sess-1").ok);
  const d1 = readConclusions(root).find((c) => c.id === "D-1")!;
  assert.equal(Array.from(d1.said!).length, 2000);
  assert.ok(d1.said!.startsWith("use redis.\n\nthe thread: [31m ops said"), d1.said!.slice(0, 40));
  assert.ok(d1.said!.endsWith("…"));
  assert.deepEqual(d1.problems, []);
  // the file is one line per key whatever was typed
  assert.match(
    fs.readFileSync(d1.file, "utf8"),
    /\nsaid: "use redis\.\\n\\nthe thread: \[31m ops said[^\n]*…"\n---\n/,
  );

  // no transcript for the session, no claude folder at all, the person writing from grove: no `said`, and the write lands
  assert.ok(rec("sess-without-a-transcript").ok);
  assert.ok(
    asAgent(root, "sess-1", "conclusion_record", { kind: "finding", what: "x", by: "agent" }).ok,
  );
  assert.ok(asPerson(root, "conclusion_record", { kind: "verdict", what: "y", by: "person" }).ok);
  for (const c of readConclusions(root).filter((c) => c.id !== "D-1")) {
    assert.equal(c.said, undefined, c.id);
    assert.doesNotMatch(fs.readFileSync(c.file, "utf8"), /\nsaid:/);
  }
  // a conclusion file from before these keys existed reads as it did
  assert.deepEqual(readConclusions(root).find((c) => c.id === "V-1")!.sources, []);
});

test("sources: urls and paths from the root are kept, everything else is refused", () => {
  const root = makeProject(path.join(base, "sources"));
  const rec = (sources: unknown) =>
    asAgent(root, "s1", "conclusion_record", { kind: "finding", what: "w", by: "agent", sources });
  const kept = () => readConclusions(root)[0]!.sources;

  assert.ok(
    rec([
      {
        ref: " https://acme.slack.com/archives/C01/p17?thread_ts=1.2 ",
        note: "ops:\n no  revoke\u0007",
      },
      "artifacts/thread-digest.md",
      { ref: path.join(root, "artifacts", "figma frame.png") },
      { ref: "http://localhost:3000/logs", note: "" },
    ]).ok,
  );
  assert.deepEqual(kept(), [
    { ref: "https://acme.slack.com/archives/C01/p17?thread_ts=1.2", note: "ops: no revoke" },
    { ref: "artifacts/thread-digest.md" },
    // given in full, stored from the root: what another agent's Read and the app both take
    { ref: path.join("artifacts", "figma frame.png") },
    { ref: "http://localhost:3000/logs" },
  ]);
  assert.match(
    fs.readFileSync(readConclusions(root)[0]!.file, "utf8"),
    /\nsources: \[\{"ref":"https:[^\n]*\}\]\n/,
    "one line of frontmatter",
  );
  assert.ok(rec([]).ok);
  assert.deepEqual(kept(), []);
  assert.doesNotMatch(fs.readFileSync(readConclusions(root)[0]!.file, "utf8"), /sources/);

  const refused: [unknown, RegExp][] = [
    ["https://x.test/a", /"sources" must be a list, like \[\{"ref"/],
    [[{ note: "no ref" }], /each entry of "sources" must be \{"ref"/],
    [[{ ref: "  " }], /each entry of "sources" must be/],
    [[{ ref: "a.md", note: 3 }], /each entry of "sources" must be/],
    [[null], /each entry of "sources" must be/],
    [[{ ref: "../outside.md" }], /must be a url, or a file inside the project/],
    [[{ ref: "artifacts/../../etc/passwd" }], /must be a url, or a file inside the project/],
    [
      [{ ref: "/etc/passwd" }],
      /source "\/etc\/passwd" must be a url, or a file inside the project/,
    ],
    [[{ ref: `${root}-other/notes.md` }], /must be a url, or a file inside the project/],
    [[{ ref: root }], /must be a url, or a file inside the project/],
    [[{ ref: "~/notes.md" }], /must be a url, or a file inside the project/],
    [[{ ref: "file:///etc/passwd" }], /must be an http\(s\) url with no password in it/],
    [[{ ref: "javascript:alert(1)" }], /must be an http\(s\) url/],
    [[{ ref: "slack://channel?id=C01" }], /must be an http\(s\) url/],
    [[{ ref: "https://me:secret@x.test/doc" }], /with no password in it/],
    [[{ ref: "https://" }], /must be an http\(s\) url/],
    [[{ ref: `https://x.test/${"a".repeat(1000)}` }], /its ref is over 1000 characters/],
    [[{ ref: "a.md", note: "n".repeat(301) }], /its note is over 300 characters/],
    [Array.from({ length: 13 }, (_, i) => `a${i}.md`), /has 13 entries, the limit is 12/],
  ];
  const before = readConclusions(root).length;
  for (const [sources, re] of refused) {
    const r = rec(sources);
    assert.equal(r.code, "invalid", JSON.stringify(sources));
    assert.match(r.text, re);
    // the refusal carries the shape, so the next call is right
    assert.match(r.text, /Example: \{.*"sources":\[\{"ref":"https:/);
  }
  assert.equal(readConclusions(root).length, before, "a refused call writes nothing");

  // a hand edit: bare refs and a note of the wrong type are read, never thrown on
  const file = path.join(root, "conclusions", "F-9.md");
  fs.writeFileSync(
    file,
    '---\nv: 1\nid: F-9\nwhat: "by hand"\nat: 2026-10-04T10:00:00.000Z\nsources: ["notes.md", {"ref": "https://x.test", "note": 4}, {"note": "no ref"}, 7]\n---\n',
  );
  assert.deepEqual(readConclusions(root).find((c) => c.id === "F-9")!.sources, [
    { ref: "notes.md" },
    { ref: "https://x.test", note: "4" },
  ]);
  const schema = mcpToolList().find((t) => t.name === "conclusion_record")!.inputSchema as {
    properties: { sources: { type: string; items: { required: string[] } } };
  };
  assert.equal(schema.properties.sources.type, "array");
  assert.deepEqual(schema.properties.sources.items.required, ["ref"]);
});

test("the turn around a call: the person's message before it and the agent's words up to it", () => {
  const claude = path.join(base, "turn claude");
  const file = transcript(claude, "sess-turn", [
    // a prompt that quotes the very key the call is found by
    typedLine('set up the store. fyi a call looks like "id":"toolu_rec"'),
    says({ type: "text", text: "Reading the store." }, calls("toolu_old")),
    resultLine("toolu_old", "store.ts"),
    typedLine("here is the thread: ops says a cookie cannot be revoked. so?"),
    says({ type: "thinking", thinking: "private" }, { type: "text", text: "I read the thread." }),
    resultLine("toolu_x", "more"),
    ...NOISE,
    says(
      { type: "text", text: "Redis it is. Recording that." },
      calls("toolu_rec", "mcp__grove__conclusion_record"),
      { type: "text", text: "said after the call" },
    ),
    resultLine("toolu_rec", "D-1 recorded"),
    says({ type: "text", text: "Done." }, calls("toolu_late")),
  ]);
  assert.deepEqual(turnAround(file, "toolu_rec"), {
    prompt: "here is the thread: ops says a cookie cannot be revoked. so?",
    text: "I read the thread.\n\nRedis it is. Recording that.",
  });
  assert.deepEqual(turnAround(file, "toolu_old"), {
    prompt: 'set up the store. fyi a call looks like "id":"toolu_rec"',
    text: "Reading the store.",
  });
  // something typed mid-turn is the newer message
  assert.equal(
    turnAround(
      transcript(claude, "sess-queued", [
        typedLine("start"),
        says({ type: "text", text: "starting" }),
        queued("no, use redis"),
        says({ type: "text", text: "ok, redis" }, calls("toolu_q")),
      ]),
      "toolu_q",
    )?.prompt,
    "no, use redis",
  );
  // long ones are cut: the person's from the end, the agent's from the start, since its last words led to the call
  const long = turnAround(
    transcript(claude, "sess-long", [
      typedLine(`P${"p".repeat(3000)}`),
      says({ type: "text", text: `first ${"a".repeat(3000)}` }),
      says({ type: "text", text: "the last thing it said" }, calls("toolu_l")),
    ]),
    "toolu_l",
  )!;
  assert.equal(Array.from(long.prompt!).length, 2000);
  assert.ok(long.prompt!.startsWith("Pppp") && long.prompt!.endsWith("…"));
  assert.equal(Array.from(long.text!).length, 2000);
  assert.ok(long.text!.startsWith("…aaa") && long.text!.endsWith("the last thing it said"));
  // no prompt before it (a resumed session whose start was trimmed), and nothing the agent said
  assert.deepEqual(turnAround(transcript(claude, "bare", [says(calls("toolu_b"))]), "toolu_b"), {});

  assert.equal(turnAround(file, "toolu_never"), null);
  assert.equal(turnAround(file, 'toolu_rec"'), null, "an id is its own alphabet");
  assert.equal(turnAround(file, ""), null);
  assert.equal(turnAround(path.join(claude, "missing.jsonl"), "toolu_rec"), null);
  assert.equal(turnAround(claude, "toolu_rec"), null, "a folder");
});

test("one call reads a conclusion in full: sources, what the person said, the conversation", () => {
  const root = makeProject(path.join(base, "full"));
  const claude = path.join(base, "full claude");
  asAgent(root, "sess-1", "card_create", { title: "Session store" });
  const prompt = "here is the thread:\nops: a cookie cannot be revoked\nso, redis?";
  const file = transcript(claude, "sess-1", [
    typedLine(prompt),
    says({ type: "text", text: "The thread settles it: redis." }, calls("toolu_rec")),
  ]);
  const sources = [
    { ref: "https://acme.slack.com/archives/C01/p17", note: "ops: a cookie cannot be revoked" },
    { ref: "artifacts/thread-digest.md" },
  ];
  const rec = asSession(
    root,
    claude,
    "sess-1",
    "conclusion_record",
    {
      kind: "decision",
      what: "Sessions move to redis.",
      why: "A cookie cannot be revoked.\nSSO logout needs revoke.",
      by: "person",
      card: "AUTH-1",
      area: "api",
      sources,
    },
    "toolu_rec",
  );
  assert.ok(rec.ok, rec.text);
  const d1 = readConclusions(root)[0]!;
  assert.deepEqual([d1.sources, d1.said, d1.toolUseId], [sources, prompt, "toolu_rec"]);
  // an agent the person never talked to, in another session, with no transcript of its own
  const read = (args: Record<string, unknown>, tool = "conclusion_search") =>
    asSession(root, claude, "sess-2", tool, args).text;
  asSession(root, claude, "sess-2", "conclusion_record", {
    kind: "finding",
    what: "The api suite takes 11 minutes.",
    by: "agent",
  });

  const full = read({ query: "d-1" });
  assert.equal(
    full,
    [
      `D-1 decision | by the person (recorded by session store) | ${d1.at.slice(5, 16).replace("T", " ")} | AUTH-1 | area api`,
      "  what: Sessions move to redis.",
      "  why: A cookie cannot be revoked.",
      "      SSO logout needs revoke.",
      "  source: https://acme.slack.com/archives/C01/p17 - ops: a cookie cannot be revoked",
      "  source: artifacts/thread-digest.md",
      "  the conversation it was recorded in:",
      "    the person: here is the thread:",
      "      ops: a cookie cannot be revoked",
      "      so, redis?",
      "    session store, before recording it: The thread settles it: redis.",
      `  transcript: ${file} (the call is toolu_rec)`,
    ].join("\n"),
  );
  // a search hit and the card: every source, and the person's words on one line
  const hit = read({ query: "redis" });
  assert.match(hit, /^1 conclusion matches "redis" \(of 2 in the project\)\.\nD-1 decision \|/);
  assert.match(
    hit,
    /\n {2}source: https:\/\/acme\.slack\.com\/archives\/C01\/p17 - ops: a cookie cannot be revoked\n {2}source: artifacts\/thread-digest\.md\n {2}the person said: here is the thread: ops: a cookie cannot be revoked so, redis\?\n/,
  );
  assert.match(
    hit,
    /\nTo read one in full, with the conversation it was recorded in, call conclusion_search with its id as the query\.$/,
  );
  const card = read({ card: "AUTH-1" }, "card_show");
  assert.match(
    card,
    /\nD-1 decision, the person's \| Sessions move to redis\.\n {2}source: https:[^\n]+\n {2}source: artifacts\/thread-digest\.md\n {2}the person said: here is the thread: /,
  );
  // the state says only that there is more
  const state = read({}, "record_state");
  assert.match(
    state,
    /\nD-1 decision \(the person's\) AUTH-1 \[2 sources\] \| Sessions move to redis\./,
  );
  assert.match(state, /\nF-1 finding \| The api suite takes 11 minutes\./);

  // claude code deleted the transcript: the call still answers, and the words kept on the record are what is left
  fs.rmSync(file);
  const later = read({ query: "D-1" });
  assert.match(
    later,
    /\n {2}the person said: here is the thread:\n {6}ops: a cookie cannot be revoked\n {6}so, redis\?\n/,
  );
  assert.match(
    later,
    /\n {2}the conversation: the session's transcript is gone or cannot be read from here\. What the person said is what is left\.$/,
  );
  // the transcript is there and the call is not in it
  transcript(claude, "sess-1", [typedLine("something else")]);
  assert.match(
    read({ query: "D-1" }),
    /\n {2}the conversation: the call that recorded it is not in the session's transcript \(a subagent's call, or one made through the CLI\)\. transcript: \/.+sess-1\.jsonl$/,
  );
  // nothing kept beside the conclusion itself: its session never had a transcript here
  assert.match(
    read({ query: "F-1" }),
    /\n {2}sources: none recorded\n {2}the conversation: the session's transcript is gone or cannot be read from here\.$/,
  );
  assert.ok(asPerson(root, "conclusion_record", { kind: "verdict", what: "v", by: "person" }).ok);
  assert.match(
    read({ query: "V-1" }),
    /\n {2}the conversation: none\. The person recorded it in Grove\.$/,
  );
  // an id that is not there is still a search with no hit
  assert.match(read({ query: "D-9" }), /^0 conclusions match "D-9"/);
});
