# auth-sso

SSO for the dashboard

## What this folder is

A combo: one folder that gathers the repos a single task needs. It is not a git repository -
run git inside the member folders.

- (no members yet)

A working copy is a git worktree: a second checkout of the original clone, sharing its `.git`.

- commits and branches made here show up in the original clone straight away, and the other way round
- it started clean. uncommitted work in the original clone is not here
- a branch can be checked out in one worktree at a time. when `git checkout <branch>` refuses, that is why
- never remove a working copy with `rm -rf` or `git worktree remove`. Grove owns their lifecycle

## Where things go

Nothing below belongs inside a working copy. Keep those clean, so nothing lands in a commit by accident.

- `plans/` - plans and designs, one file each: `YYYY-MM-DD-topic.md`. a plan that only exists in a chat is gone when the session ends or forks
- `artifacts/` - generated things that are not source: reports, query results, exports, diagrams, scratch scripts
- `context/` - what other sessions need to know. see below

## Long work

Before starting anything you expect to take more than a few minutes of autonomous work, read
`.claude/long-work.md` and follow it. It says whether long work runs in the background or here,
and it can change while a session is running, so read it each time rather than remembering it.

## Other sessions work here too

Several sessions can be working in this folder at once: forks of this conversation, background
agents, other tabs. They do not share your conversation. The project record is the memory you
have in common: cards (who is doing what), questions with their answers, and conclusions
(decisions, findings, verdicts). `.claude/rules/grove-record.md` says how to read and write it.

- before starting a task, call `record_state`, and claim a card before you work on it
- record each decision, finding and verdict when it is settled, yours and the person's
- `context/` is for longer notes the record points at: `context/<topic>.md`, short dated entries, added to and never rewritten

This file was written once when the combo was created. It is yours to edit.
