import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureRoot,
  longTaskAgentPath,
  renderClaudeMdStub,
  renderLongTaskAgent,
} from "../../src/combos/claudeMd.ts";
import type { Combo } from "../../src/types.ts";
import { makeSandbox } from "../helpers/transcript.ts";

function combo(): Combo {
  return {
    name: "prod-debug",
    root: path.join(makeSandbox("grove-md-"), "claude-ws", "prod-debug"),
    note: "incident triage",
    folders: [
      { path: "/Users/you/src/api", mode: "worktree", branch: { kind: "detach" } },
      {
        path: "/Users/you/src/shared",
        mode: "worktree",
        branch: { kind: "new", name: "prod-debug" },
        as: "common",
      },
      { path: "/Users/you/src/logs", mode: "reference" },
    ],
  };
}

describe("combo root and CLAUDE.md", () => {
  it("root gets the stub once, describing the combo and its members", async () => {
    const c = combo();
    expect(await ensureRoot(c)).toEqual({ created: true });
    const md = readFileSync(path.join(c.root, "CLAUDE.md"), "utf8");
    expect(md).toBe(renderClaudeMdStub(c));
    expect(md).toContain("# prod-debug");
    expect(md).toContain("incident triage");
    expect(md).toContain("`api/` - working copy");
    expect(md).toContain("`common/` - working copy");
    expect(md).toContain("`/Users/you/src/logs` - reference");
    expect(md).toContain("not a git repository");
  });

  it("says what a worktree is, where plans and artifacts go, and how sessions leave word for each other", async () => {
    const md = renderClaudeMdStub(combo());
    // what this is
    expect(md).toContain("A working copy is a git worktree");
    expect(md).toContain("detached at HEAD");
    expect(md).toContain("on branch `prod-debug`");
    expect(md).toContain("never remove a working copy");
    // where things go
    expect(md).toContain("`plans/`");
    expect(md).toContain("`artifacts/`");
    expect(md).toContain("Nothing below belongs inside a working copy");
    // forks and background agents do not share a conversation
    expect(md).toContain("forks of this conversation");
    expect(md).toContain("`context/in-progress.md`");
    // it is loaded into every session in the combo, so it has to stay small
    expect(md.length).toBeLessThan(3200);
  });

  it("long work is sent to an agent that always runs in the background", async () => {
    const c = combo();
    await ensureRoot(c);
    const agent = readFileSync(longTaskAgentPath(c), "utf8");
    expect(longTaskAgentPath(c)).toBe(path.join(c.root, ".claude", "agents", "long-task.md"));
    expect(agent).toBe(renderLongTaskAgent(c));
    // frontmatter claude code 2.1.278 recognises. `background` is what makes it the default.
    expect(agent).toMatch(
      /^---\nname: long-task\ndescription: .+\nbackground: true\nmodel: inherit\n---\n/,
    );
    // it starts without the conversation, so it is sent to where the context was written down
    expect(agent).toContain("read the plan file you were given, then `context/`");
    expect(agent).toContain("`context/in-progress.md`");
    expect(agent).toContain("do not stop to ask");
    // the agent never volunteers itself: whether long work goes to it is the policy file's call
    expect(agent).toContain("Use it only when .claude/long-work.md says");
    // CLAUDE.md is read once per session, so it only points at the file that can change
    const md = renderClaudeMdStub(c);
    expect(md).toContain("`.claude/long-work.md`");
    expect(md).toContain("read it each time");
    expect(md).not.toContain("`long-task`");
  });

  it("the agent file is the person's after creation, like everything else in the root", async () => {
    const c = combo();
    await ensureRoot(c);
    writeFileSync(longTaskAgentPath(c), "my own agent\n");
    await ensureRoot(c);
    expect(readFileSync(longTaskAgentPath(c), "utf8")).toBe("my own agent\n");
    unlinkSync(longTaskAgentPath(c));
    await ensureRoot(c);
    expect(existsSync(longTaskAgentPath(c))).toBe(false);
  });

  it("the shared folders are made once, with the root, and never put back", async () => {
    const c = combo();
    await ensureRoot(c);
    for (const dir of ["plans", "artifacts", "context"]) {
      expect(existsSync(path.join(c.root, dir)), dir).toBe(true);
    }
    rmSync(path.join(c.root, "artifacts"), { recursive: true });
    await ensureRoot(c);
    expect(existsSync(path.join(c.root, "artifacts"))).toBe(false);
  });

  it("never rewritten: the file is the person's after creation", async () => {
    const c = combo();
    await ensureRoot(c);
    const file = path.join(c.root, "CLAUDE.md");
    writeFileSync(file, "my own notes\n");
    expect(await ensureRoot({ ...c, note: "changed" })).toEqual({ created: false });
    expect(readFileSync(file, "utf8")).toBe("my own notes\n");
  });

  it("not recreated after the person deletes it", async () => {
    const c = combo();
    await ensureRoot(c);
    unlinkSync(path.join(c.root, "CLAUDE.md"));
    await ensureRoot(c);
    expect(() => readFileSync(path.join(c.root, "CLAUDE.md"))).toThrow();
  });
});
