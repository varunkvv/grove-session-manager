// the tool registry. one entry per operation: its name, the description the model reads, its
// arguments and its handler. the MCP server, the CLI, the rules file and the server instructions
// are all generated from this list. adding an operation is one entry here and one function in ops.ts.
import { type Caller, resolveCaller } from "./identity.ts";
import * as ops from "./ops.ts";
import type { Artifact, By } from "./read.ts";
import { check, type InputSpec, jsonSchema, type Prop } from "./validate.ts";

export interface ToolDef {
  name: string;
  /** what the model reads in its tool list. says when to call it, not only what it does. at most 2,048 characters. */
  description: string;
  /** one line for the tool list in the rules file and in `record tools`. */
  summary: string;
  input: InputSpec;
  /** writes a record. every writing tool also takes `as`. */
  writes: boolean;
  /** MCP annotations.readOnlyHint. claude code runs read-only tools concurrently. */
  readOnly?: boolean;
  /** MCP _meta["anthropic/alwaysLoad"]: the full schema is in every request, with no tool search first. */
  alwaysLoad?: boolean;
  /** false: reachable from the CLI and the library, not listed over MCP. */
  mcp?: boolean;
  run(ctx: ops.Ctx, args: Record<string, unknown>): ops.OpResult;
}

const card = (description: string): Prop => ({
  type: "string",
  format: "id",
  max: 40,
  description,
});
const AS: Prop = {
  type: "string",
  format: "line",
  max: 40,
  description:
    'Only when you are a subagent: a short name for yourself, like "long-task" or "explore". It is stored on the record so the person can tell your writes from your parent session\'s. Leave it out in a main session.',
};
const ARTIFACTS: Prop = {
  type: "artifacts",
  description:
    'What you made, so it shows on the card: [{"type": "file", "ref": "artifacts/report.md"}, {"type": "branch", "ref": "feat/login-sso"}, {"type": "pr", "ref": "https://github.com/org/repo/pull/12"}]. type is file, branch, pr or link. A file ref is a path from the project root.',
};

export const TOOLS: ToolDef[] = [
  {
    name: "record_state",
    summary:
      "the goal, every card with status and holder, open questions, newest conclusions, who you are",
    description:
      "Read the shared project record: the goal, every card with its status and holder, the open questions, the newest conclusions (decisions, findings, verdicts) and which session you are. Call it before you start any work in this project, and again whenever you need the current picture. A subagent, and a session started inside a working copy, gets no state at session start, so for them this call is the only way to see it. Read-only.",
    input: {
      properties: {
        all: {
          type: "boolean",
          description:
            "true lists every card and open question and up to 50 conclusions, with no size cap. Leave it out for the normal view.",
        },
      },
      required: [],
      example: {},
    },
    writes: false,
    readOnly: true,
    alwaysLoad: true,
    run: (ctx, a) => ops.recordState(ctx, { all: a.all as boolean | undefined }),
  },
  {
    name: "my_cards",
    summary:
      "the cards you hold, what is new on them, questions left for you. also refreshes your claims after a resume",
    description:
      "List the cards this session holds, what is new on them since your last write (comments, answers to your questions) and the open questions other agents left for you. Call it at the start of every turn, and after a resume or a fork. It refreshes your claims when the session came back in a new process, and tells you when a card was taken over, released or canceled by someone else. Takes no arguments.",
    input: { properties: {}, required: [], example: {} },
    writes: false,
    alwaysLoad: true,
    run: (ctx) => ops.myCards(ctx),
  },
  {
    name: "card_show",
    summary:
      "one card in full: description, holder, the whole thread, its conclusions, linked cards",
    description:
      "Read one card in full: its description, status, who holds it and whether their process is running, the whole thread (comments, questions with their answers, claim events), the conclusions recorded on it and the cards linked to it. Call it before you claim or work on a card, and before you answer a question on it. Read-only.",
    input: {
      properties: { card: card("The card id, like AUTH-3.") },
      required: ["card"],
      example: { card: "AUTH-3" },
    },
    writes: false,
    readOnly: true,
    run: (ctx, a) => ops.cardShow(ctx, { card: a.card as string }),
  },
  {
    name: "card_create",
    summary: "create a card for work that is not part of your own card",
    description:
      "Create a card: one sizeable piece of work that an agent can pick up and finish. Call it when you find work that is not part of your own card, or when the person asks for something new. Do not do that work yourself unless it is small and blocks you. The new card is todo and unclaimed, the person sees it in their inbox, and any agent may claim it. Creating a card does not claim it. Write the body as a brief for an agent that has not seen your conversation: what to do, what done looks like, what you already know, and the ids of related cards and conclusions. Returns the new id, like AUTH-7.",
    input: {
      properties: {
        title: {
          type: "string",
          format: "line",
          max: 200,
          description: "One line that says what the work is.",
        },
        body: { type: "string", max: 20000, description: "The brief, in markdown." },
        from: card(
          "The card you were working on when you found this work. Leave it out when there is none.",
        ),
        needs: {
          type: "ids",
          description:
            'Ids of cards that have to be done before this one can start, like ["AUTH-4"].',
        },
        as: AS,
      },
      required: ["title"],
      example: {
        title: "Rate limit the callback endpoint",
        body: "Found while doing AUTH-1. ...",
        from: "AUTH-1",
      },
    },
    writes: true,
    run: (ctx, a) =>
      ops.cardCreate(ctx, {
        title: a.title as string,
        body: a.body as string | undefined,
        from: a.from as string | undefined,
        needs: a.needs as string[] | undefined,
      }),
  },
  {
    name: "card_claim",
    summary: "claim a card before you work on it. one session holds a card",
    description:
      "Claim a card before you work on it. Exactly one session holds a card, which is how two agents never do the same work. It succeeds when the card is todo or already yours. If another agent holds it, you are told so: do not work on it. If the holder's process is gone, you are told that too: ask the person, do not take it. Subagents do not claim: they work under their parent session's claim.",
    input: {
      properties: { card: card("The card id, like AUTH-3."), as: AS },
      required: ["card"],
      example: { card: "AUTH-3" },
    },
    writes: true,
    alwaysLoad: true,
    run: (ctx, a) => ops.cardClaim(ctx, { card: a.card as string }),
  },
  {
    name: "card_release",
    summary: "give a card back unfinished, with a note on where you stopped",
    description:
      "Give back a card you hold, unfinished, so that another agent can claim it. Say in note where you stopped and what is left. Use card_done when the work is complete, and card_cancel when it should not be done at all.",
    input: {
      properties: {
        card: card("The card id."),
        note: {
          type: "string",
          max: 4000,
          description: "Where you stopped and what is left, for the next agent.",
        },
        as: AS,
      },
      required: ["card"],
      aliases: { text: "note" },
      example: {
        card: "AUTH-3",
        note: "The form is done. The redirect for SSO-only orgs is not started.",
      },
    },
    writes: true,
    run: (ctx, a) =>
      ops.cardRelease(ctx, { card: a.card as string, note: a.note as string | undefined }),
  },
  {
    name: "card_done",
    summary: "mark your card done, with a summary of what was and was not done",
    description:
      "Mark a card you hold as done. You decide when it is complete. summary is what the person and later agents read instead of your transcript: what was done, what was not done, how you checked it, and the ids of the conclusions that matter (D-4, F-2). List what you made in artifacts. A done card cannot be reopened. Follow-up work is a new card created with from.",
    input: {
      properties: {
        card: card("The card id."),
        summary: {
          type: "string",
          max: 4000,
          description: "What was done, what was not, and how you checked it.",
        },
        artifacts: ARTIFACTS,
        as: AS,
      },
      required: ["card", "summary"],
      aliases: { text: "summary" },
      example: {
        card: "AUTH-3",
        summary:
          "Login page with the SSO button is in. Email-first step sends SSO orgs to okta (D-5). Not done: the error page for a disabled org, see AUTH-9. Checked with the e2e suite.",
      },
    },
    writes: true,
    run: (ctx, a) =>
      ops.cardDone(ctx, {
        card: a.card as string,
        summary: a.summary as string,
        artifacts: a.artifacts as Artifact[] | undefined,
      }),
  },
  {
    name: "card_cancel",
    summary: "cancel a card that should not be done, with the reason",
    description:
      "Cancel a card that should not be done: it is a duplicate, the plan changed, or a conclusion made it pointless. reason is required and should cite the card or conclusion that explains it. You can cancel a card you hold or a card nobody holds. A canceled card keeps its id and its thread, and cannot be reopened.",
    input: {
      properties: {
        card: card("The card id."),
        reason: {
          type: "string",
          max: 4000,
          description:
            "Why it should not be done. Cite the card or conclusion id that explains it.",
        },
        as: AS,
      },
      required: ["card", "reason"],
      aliases: { text: "reason" },
      example: { card: "AUTH-8", reason: "Duplicate of AUTH-5." },
    },
    writes: true,
    run: (ctx, a) => ops.cardCancel(ctx, { card: a.card as string, reason: a.reason as string }),
  },
  {
    name: "card_takeover",
    summary: "take a card another session holds. only when the person told you to",
    description:
      "Take a card that another session holds. Call this only when the person told you to take that card, in the chat or in the prompt they started you with. Without force it works only when the holder's process is gone (a closed tab, a crash). force true also takes the card from an agent that is still running, and is only for when the person explicitly said to do that. Never use it to get a card you would like to work on.",
    input: {
      properties: {
        card: card("The card id."),
        force: {
          type: "boolean",
          description:
            "true only when the person explicitly told you to take the card from an agent that is still running.",
        },
        as: AS,
      },
      required: ["card"],
      example: { card: "AUTH-3" },
    },
    writes: true,
    run: (ctx, a) =>
      ops.cardTakeover(ctx, { card: a.card as string, force: a.force as boolean | undefined }),
  },
  {
    name: "comment_add",
    summary: "add a note to a card's thread: what you made, what you learned, where you stopped",
    description:
      "Add a comment to a card's thread. Use it when you made something (a branch, a PR, a file under artifacts/ - list it in artifacts), when you learned something the next agent would otherwise have to find out again, or when you stopped early or hit something you could not solve. Refer to other cards and to conclusions by id (AUTH-3, D-4). Not for questions (use question_ask) and not for conclusions (use conclusion_record).",
    input: {
      properties: {
        card: card("The card to comment on. It can be any card, not only one you hold."),
        text: { type: "string", max: 20000, description: "The comment, in markdown." },
        artifacts: ARTIFACTS,
        as: AS,
      },
      required: ["card", "text"],
      example: {
        card: "AUTH-4",
        text: "Okta app settings per environment are written up.",
        artifacts: [{ type: "file", ref: "artifacts/okta-app-settings.md" }],
      },
    },
    writes: true,
    run: (ctx, a) =>
      ops.commentAdd(ctx, {
        card: a.card as string,
        text: a.text as string,
        artifacts: a.artifacts as Artifact[] | undefined,
      }),
  },
  {
    name: "question_ask",
    summary: "put a question on the record, to the person or to the agent on another card",
    description:
      "Put a question on the record. Every question goes here, with its answer once there is one. A question that lives only in the chat is lost to every other agent and never reaches the person's inbox. card is the card the question is about, normally the one you hold. to is \"person\" (the default) for the person who runs the project, or a card id to ask whichever agent holds that card. After asking the person here, ask them in the chat as well. If you cannot carry on without the answer, stop there. If you can, say what you assumed and carry on. Returns the question's id, like AUTH-4#6.",
    input: {
      properties: {
        card: card("The card the question is about, normally the one you hold."),
        text: {
          type: "string",
          max: 20000,
          description: "The question, with the options you see and what you would pick.",
        },
        to: {
          type: "string",
          max: 40,
          description:
            'Who should answer: "person" (the default), or a card id like AUTH-4 for the agent that holds that card.',
        },
        as: AS,
      },
      required: ["card", "text"],
      example: {
        card: "AUTH-4",
        text: "Staging has no okta tenant. Create a dev tenant, or point staging at the prod tenant with its own app? I would create a dev tenant.",
        to: "person",
      },
    },
    writes: true,
    alwaysLoad: true,
    run: (ctx, a) =>
      ops.questionAsk(ctx, {
        card: a.card as string,
        text: a.text as string,
        to: a.to as string | undefined,
      }),
  },
  {
    name: "question_answer",
    summary: "record the answer to an open question, which closes it",
    description:
      'Answer an open question, which closes it. Use it when the person answered one of your questions in the chat (record their answer in their words, with by "person"), when another agent\'s question is addressed to a card you hold (my_cards lists those), or when you found the answer to your own question. card and question are the two parts of the question\'s id: AUTH-4#6 is card "AUTH-4", question 6. If the answer settles something, also call conclusion_record.',
    input: {
      properties: {
        card: card("The card the question is on: the part before # in AUTH-4#6."),
        question: {
          type: "integer",
          description: "The question's number: the part after # in AUTH-4#6.",
        },
        text: { type: "string", max: 20000, description: "The answer." },
        by: {
          type: "string",
          enum: ["agent", "person"],
          description:
            'Whose answer it is. "person" when the person gave it and you are writing it down. Default "agent".',
        },
        as: AS,
      },
      required: ["card", "question", "text"],
      example: {
        card: "AUTH-4",
        question: 6,
        text: "Create a dev tenant. I will get the okta admin to approve it.",
        by: "person",
      },
    },
    writes: true,
    run: (ctx, a) =>
      ops.questionAnswer(ctx, {
        card: a.card as string,
        question: a.question as number,
        text: a.text as string,
        by: a.by as By | undefined,
      }),
  },
  {
    name: "conclusion_record",
    summary:
      "record a decision, a finding or a verdict the moment it is settled, yours or the person's",
    description:
      'Record something that is now settled, so that the person and every later agent can look it up instead of deciding or finding it again. Three kinds. decision: what we will do ("refresh tokens stay on the server"). finding: what turned out to be true ("staging has no okta tenant in terraform state"). verdict: a judgement on an option, an approach or a piece of work ("the saml strategy cannot be reused for oidc"). Record it the moment it is settled, not at the end of the work. That includes the ones nobody announced: a default, a limit, a name, a library or a file layout you picked, something you took as true without checking, something you ruled out or left out of scope. It also includes every one the person makes in the chat or in an answer to your question ("go with that", "no, use redis", "8h, to match the policy"): those are by "person". Call conclusion_search first. If it is already settled, follow it and cite its id. If you go against an earlier conclusion, pass its id in replaces and say why. Do not record routine edits or what the diff already says. Returns the id, like D-12. Cite it in cards, comments and commit messages.',
    input: {
      properties: {
        kind: {
          type: "string",
          enum: ["decision", "finding", "verdict"],
          description:
            "decision: what we will do. finding: what turned out to be true. verdict: a judgement on an option, an approach or a piece of work.",
        },
        what: {
          type: "string",
          format: "line",
          max: 300,
          description:
            "What was concluded, as one sentence that stands on its own without the conversation.",
        },
        why: {
          type: "string",
          max: 2000,
          description:
            "The reason or the evidence, in one or two lines. For a finding, how you checked.",
        },
        card: card(
          "The card it belongs to, normally the one you hold. Leave it out when it is about the whole project.",
        ),
        by: {
          type: "string",
          enum: ["agent", "person"],
          description:
            'Whose conclusion it is, always given. "person" when the person decided, picked, answered, approved or judged it, in the chat or in an answer to your question, and you are writing it down. "agent" only when you reached it yourself.',
        },
        replaces: card(
          "The id of an earlier conclusion that this one overrules, like D-4. That one then shows as superseded.",
        ),
        related: {
          type: "ids",
          description: 'Ids of conclusions this one depends on or affects, like ["D-4", "F-2"].',
        },
        changes_plan: {
          type: "boolean",
          description:
            "true when this changes what the project should do, so the person has to see it. It then goes to their inbox. Mostly for findings: an agent's decisions and verdicts go to the inbox anyway.",
        },
        area: {
          type: "string",
          format: "line",
          max: 40,
          description: "One word for the part of the system: api, web, infra, tests.",
        },
        as: AS,
      },
      required: ["kind", "what", "by"],
      example: {
        kind: "decision",
        what: "Refresh tokens stay on the server. The browser only gets an opaque session id.",
        why: "Keeps tokens out of the page. Costs one redis read per request.",
        card: "AUTH-1",
        by: "agent",
        area: "api",
      },
    },
    writes: true,
    alwaysLoad: true,
    run: (ctx, a) => ops.conclusionRecord(ctx, a as unknown as ops.ConclusionArgs),
  },
  {
    name: "conclusion_search",
    summary: "search what is already settled, before you decide or investigate",
    description:
      "Search the project's conclusions (decisions, findings, verdicts). Call it before you decide something, before you investigate something that may already be known, and whenever you need the id of an earlier conclusion to cite or replace. query is words that must all appear (in what, why, area, card or author; \"person\" finds the person's own), or an id like D-4. With no arguments it lists the newest. Superseded conclusions are left out and counted, unless include_replaced is true. Read-only.",
    input: {
      properties: {
        query: {
          type: "string",
          format: "line",
          max: 200,
          description: 'Words that must all appear, or a conclusion id like "D-4".',
        },
        kind: {
          type: "string",
          enum: ["decision", "finding", "verdict"],
          description: "Only this kind.",
        },
        card: card("Only conclusions recorded on this card."),
        include_replaced: {
          type: "boolean",
          description: "true also lists superseded conclusions, marked as such.",
        },
        limit: { type: "integer", description: "How many to list. Default 20, at most 50." },
      },
      required: [],
      example: { query: "session redis" },
    },
    writes: false,
    readOnly: true,
    run: (ctx, a) => ops.conclusionSearch(ctx, a as ops.SearchArgs),
  },
];

export function tool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** the tools/list payload. */
export function mcpToolList(): Record<string, unknown>[] {
  return TOOLS.filter((t) => t.mcp !== false).map((t) => {
    const out: Record<string, unknown> = {
      name: t.name,
      description: t.description,
      inputSchema: jsonSchema(t.input),
    };
    if (t.readOnly) out.annotations = { readOnlyHint: true };
    if (t.alwaysLoad) out._meta = { "anthropic/alwaysLoad": true };
    return out;
  });
}

export interface RunOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  /** the MCP server's parent: the claude process. */
  ppid?: number;
  toolUseId?: string;
  /** grove writing for the person. */
  person?: boolean;
}

/** validate, work out who is calling, run. the one way in for the server, the CLI and the library. never throws. */
export function runTool(name: string, rawArgs: unknown, o: RunOptions): ops.OpResult {
  const t = tool(name);
  if (!t) {
    return {
      ok: false,
      code: "invalid",
      text: `There is no tool "${name}". The tools are: ${TOOLS.filter((x) => x.mcp !== false)
        .map((x) => x.name)
        .join(", ")}.`,
    };
  }
  const checked = check(name, t.input, rawArgs);
  if (!checked.ok) return { ok: false, code: "invalid", text: checked.text };
  const { as, ...args } = checked.args;
  return ops.attempt(() => {
    const caller: Caller = resolveCaller({
      env: o.env,
      ppid: o.ppid,
      as: as as string | undefined,
      toolUseId: o.toolUseId,
      person: o.person,
    });
    return t.run({ root: o.root, caller, env: o.env }, args);
  });
}
