import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assignCombos, projectDirLabel } from "../../src/sessions/membership.ts";
import { claudeProjectSlug, comboDirSlug } from "../../src/slug.ts";
import type { Combo, SessionRecord } from "../../src/types.ts";
import { makeSandbox } from "../helpers/transcript.ts";

function rec(partial: Partial<SessionRecord>): SessionRecord {
  return {
    path: "/p/x.jsonl",
    projectDirName: "-x",
    sessionId: "x",
    mtimeMs: 1,
    size: 1,
    parsed: true,
    activityMs: 1,
    recognized: 1,
    ...partial,
  };
}

describe("claudeProjectSlug", () => {
  it("every non-alphanumeric becomes '-', nothing is collapsed or lowercased", () => {
    expect(claudeProjectSlug("/Users/you/src/api")).toBe("-Users-you-src-api");
    expect(
      claudeProjectSlug("/Users/Some.Person/code/workspaces/nightly-etl-jobs/data_projects"),
    ).toBe("-Users-Some-Person-code-workspaces-nightly-etl-jobs-data-projects");
    expect(claudeProjectSlug("/a  b/ç")).toBe("-a--b--");
  });

  it("over 200 chars: first 200 + '-' + base36 of the 31-hash over the ORIGINAL path", () => {
    const cwd = `/Users/you/${"deep-dir.name/".repeat(20)}end`;
    expect(cwd.length).toBeGreaterThan(250);
    // reference implementation lifted from the claude 2.1.278 bundle
    const reference = (e: string) => {
      const r = e.replace(/[^a-zA-Z0-9]/g, "-");
      if (r.length <= 200) return r;
      let h = 0;
      for (let n = 0; n < e.length; n++) h = ((h << 5) - h + e.charCodeAt(n)) | 0;
      return `${r.slice(0, 200)}-${Math.abs(h).toString(36)}`;
    };
    const slug = claudeProjectSlug(cwd);
    expect(slug).toBe(reference(cwd));
    expect(slug.slice(0, 200)).toBe(cwd.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200));
    expect(slug).toMatch(/^.{200}-[0-9a-z]{1,7}$/);
    expect(claudeProjectSlug(cwd.replace(/\./g, "-"))).not.toBe(slug);
  });

  it("comboDirSlug keeps combo directories inside [a-z0-9-]", () => {
    expect(comboDirSlug("Prod Debug!")).toBe("prod-debug");
    expect(comboDirSlug("  ENG-218 / façade ")).toBe("eng-218-facade");
    expect(comboDirSlug("...")).toBe("");
  });
});

describe("assignCombos", () => {
  const base = makeSandbox("grove-member-");
  const root = path.join(base, "ws", "prod");
  const sibling = path.join(base, "ws", "prod-debug");
  mkdirSync(path.join(root, "api"), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const combos: Combo[] = [
    { name: "prod", root, folders: [] },
    { name: "prod-debug", root: sibling, folders: [] },
  ];

  it("cwd equal to the root -> 'root', cwd under it -> 'inside'", () => {
    const [a, b] = assignCombos([rec({ cwd: root }), rec({ cwd: path.join(root, "api") })], combos);
    expect(a).toMatchObject({ comboName: "prod", comboRelation: "root" });
    expect(b).toMatchObject({ comboName: "prod", comboRelation: "inside" });
  });

  it("never matches on a path or slug prefix", () => {
    const [a] = assignCombos([rec({ cwd: sibling })], combos);
    expect(a!.comboName).toBe("prod-debug");
    const [b] = assignCombos([rec({ cwd: `${root}-other` })], combos);
    expect(b!.comboName).toBeUndefined();
    expect(claudeProjectSlug(sibling).startsWith(claudeProjectSlug(root))).toBe(true);
    const [c] = assignCombos(
      [rec({ projectDirName: `${claudeProjectSlug(root)}-debug-x` })],
      combos,
    );
    expect(c!.comboName).toBeUndefined();
  });

  it("before a cwd is readable, the project dir name decides", () => {
    const [a] = assignCombos([rec({ projectDirName: claudeProjectSlug(sibling) })], combos);
    expect(a).toMatchObject({ comboName: "prod-debug", comboRelation: "root" });
  });

  it("a parsed cwd outranks the project dir name", () => {
    const [a] = assignCombos(
      [rec({ cwd: "/Users/you/src/api", projectDirName: claudeProjectSlug(root) })],
      combos,
    );
    expect(a!.comboName).toBeUndefined();
  });

  it("a symlinked app root still maps: roots are realpath'd before slugging", () => {
    const link = path.join(base, "link-ws");
    symlinkSync(path.join(base, "ws"), link);
    const viaLink: Combo[] = [{ name: "prod", root: path.join(link, "prod"), folders: [] }];
    const [byCwd, byDir] = assignCombos(
      [rec({ cwd: root }), rec({ projectDirName: claudeProjectSlug(root) })],
      viaLink,
    );
    expect(byCwd!.comboName).toBe("prod");
    expect(byDir!.comboName).toBe("prod");
  });

  it("no combos -> rows pass through untouched", () => {
    expect(assignCombos([rec({ cwd: root })], [])[0]!.comboName).toBeUndefined();
  });

  it("projectDirLabel borrows a sibling's cwd and never reverses a slug", () => {
    const sib = rec({ projectDirName: "-Users-you-src-my-api", cwd: "/Users/you/src/my-api" });
    expect(projectDirLabel("-Users-you-src-my-api", [sib])).toBe("my-api");
    expect(projectDirLabel("-Users-you-src-other", [sib])).toBe("-Users-you-src-other");
  });
});
