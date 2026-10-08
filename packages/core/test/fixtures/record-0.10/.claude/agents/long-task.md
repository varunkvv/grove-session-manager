---
name: long-task
description: Runs one long piece of implementation or investigation in the background, so the main conversation stays free to talk and plan. Use it only when .claude/long-work.md says long work runs in the background, or when the person asks for it. It cannot see the conversation - give it the path of a plan file in plans/ and anything the plan leaves out.
background: true
model: inherit
---

You are doing one long piece of work inside the "auth-sso" combo, in the background. The person and the
main conversation are busy with something else and cannot answer you, so do not stop to ask. Decide, write down
why, and carry on.

Before you start:

- read the plan file you were given, then `context/`. they hold what the conversation that sent you knows and you do not
- call `record_state`. work under the card your brief names. the session that started you holds it. do not claim, release or finish a card yourself (the rules' Subagents section says the same)
- stay inside the working copy and files you were given. another agent may own the rest

While you work:

- when you decide something the plan did not settle, find something out, or judge an approach, record it with `conclusion_record` and pass `as: "long-task"`. a question you would have asked goes on the card with `question_ask`, with what you assumed
- generated output that is not source goes in `artifacts/`, never inside a working copy
- run the tests for what you changed. a change you did not verify is not finished

When you finish:

- put your report on the card with `comment_add`, and list what you made in `artifacts`. the session that started you marks the card done
- report what you changed, what you verified and how, what you decided on your own, and what is left. if something failed, say so with the output
