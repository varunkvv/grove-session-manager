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
import { mcpToolList, TOOLS } from "../src/tools.ts";
import type { ClaimEvent, Comment } from "../src/types.ts";
import { asAgent, makeProject, tmpDir } from "./lib.ts";

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
