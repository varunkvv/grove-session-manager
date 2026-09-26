import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.join(import.meta.dirname, "../../src/renderer");
const files = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
  .map((f) => [f, readFileSync(path.join(dir, f), "utf8")] as const);

// the visual rules, enforced: one accent via tokens, no gradients, one shadow, mono only where allowed
describe("design lint", () => {
  it("no raw colours outside app.css", () => {
    for (const [f, src] of files) {
      expect(src.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(/g) ?? [], f).toEqual([]);
    }
  });
  it("no gradients anywhere", () => {
    for (const [f, src] of files) expect(/gradient/i.test(src), f).toBe(false);
    expect(/gradient/i.test(readFileSync(path.join(dir, "app.css"), "utf8"))).toBe(false);
  });
  it("the only shadow is the overlay shadow, and it is ours rather than a tailwind utility", () => {
    for (const [f, src] of files) {
      expect(src.match(/\bshadow-[a-z0-9-]+/g) ?? [], f).toEqual([]);
    }
  });

  // a token with only one value is the way this breaks, so check every colour carries both
  it("every colour token has a light value as well as a dark one", () => {
    const theme = /@theme \{([\s\S]*?)\n\}/.exec(readFileSync(path.join(dir, "app.css"), "utf8"));
    expect(theme, "the theme block is gone").not.toBeNull();
    const colours = [...(theme?.[1] ?? "").matchAll(/(--color-[a-z0-9-]+): ([^;]+);/g)];
    expect(colours.length).toBeGreaterThan(10);
    for (const [, name, value] of colours) {
      if (name === "--color-transparent" || name === "--color-*") continue;
      expect(value?.trim().startsWith("light-dark("), `${name} has one appearance only`).toBe(true);
    }
  });

  it("the accent is for state that matters: drift, search highlights, the banner action, warnings, a session waiting on you, an agent that failed", () => {
    const uses = files.flatMap(([f, src]) =>
      (src.match(/(?:bg|text|border)-accent(?:-soft)?/g) ?? []).map(() => f),
    );
    const allowed = new Set([
      "components/Rail.tsx",
      "components/Chrome.tsx",
      "components/ui.tsx",
      "components/ComboDialog.tsx",
      "components/Dialogs.tsx",
      "components/SessionList.tsx",
      "components/Inspector.tsx",
      "components/AgentDetail.tsx",
      "components/ConversationPane.tsx",
      "components/Steps.tsx",
    ]);
    for (const f of uses) expect(allowed.has(f), `${f} uses the accent`).toBe(true);
    // a row takes the accent only when its session asks for someone, never for decoration
    const list = files.find(([f]) => f === "components/SessionList.tsx")![1];
    for (const line of list.split("\n").filter((l) => /-accent/.test(l))) {
      expect(line, "accent on a session row outside the live badge").toMatch(/loud|NEEDS_YOU/);
    }
    // the pane's only colour is an agent, a step or a turn that ended in an error
    const inspector = new Set([
      "components/Inspector.tsx",
      "components/AgentDetail.tsx",
      "components/ConversationPane.tsx",
      "components/Steps.tsx",
    ]);
    for (const [f, src] of files.filter(([f]) => inspector.has(f))) {
      for (const line of src.split("\n").filter((l) => /-accent/.test(l))) {
        expect(line, `accent in ${f} for something other than an error`).toMatch(/error/);
      }
    }
  });
});
