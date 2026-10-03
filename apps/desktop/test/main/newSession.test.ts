import { longWorkPromptLine, longWorkSessionPolicy } from "@grove/core";
import { describe, expect, it } from "vitest";
import {
  backgroundArgs,
  cliFlags,
  editorPrompt,
  terminalArgs,
} from "../../src/main/services/newSession.ts";
import { EFFORTS, MODELS, PERMISSION_MODES } from "../../src/shared/newSession.ts";

const APPEND = "--append-system-prompt=";

describe("the flags a new CLI session starts with", () => {
  it("nothing picked passes nothing: the combo's own settings decide", () => {
    expect(cliFlags({})).toEqual([]);
    expect(backgroundArgs({}, "tidy up")).toEqual(["--bg", "--", "tidy up"]);
    expect(terminalArgs({}, "tidy up")).toEqual(["--", "tidy up"]);
    expect(terminalArgs({}, "")).toEqual([]);
  });

  it("every setting, in a fixed order, before `--` and the prompt", () => {
    const all = {
      model: "haiku",
      mode: "plan",
      effort: "low",
      longWork: "foreground",
      name: "nightly tidy",
    } as const;
    const flags = [
      "--model",
      "haiku",
      "--permission-mode",
      "plan",
      "--effort",
      "low",
      `${APPEND}${longWorkSessionPolicy("foreground")}`,
      "--name=nightly tidy",
    ];
    expect(cliFlags(all)).toEqual(flags);
    expect(backgroundArgs(all, "go")).toEqual(["--bg", ...flags, "--", "go"]);
    expect(terminalArgs(all, "go")).toEqual([...flags, "--", "go"]);
    // an interactive session with no first message: the flags and nothing after them
    expect(terminalArgs(all, "")).toEqual(flags);
  });

  it("free text can never become a flag: the name is one argument, the prompt comes after `--`", () => {
    expect(backgroundArgs({ name: "-x --bg" }, "--dangerously-skip-permissions")).toEqual([
      "--bg",
      "--name=-x --bg",
      "--",
      "--dangerously-skip-permissions",
    ]);
    expect(terminalArgs({}, "-p hi")).toEqual(["--", "-p hi"]);
  });

  it("the long-work override is the whole policy for that mode, in one argument", () => {
    for (const mode of ["background", "foreground"] as const) {
      const [arg, ...rest] = cliFlags({ longWork: mode });
      expect(rest).toEqual([]);
      expect(arg?.startsWith(APPEND)).toBe(true);
      expect(arg?.slice(APPEND.length)).toBe(longWorkSessionPolicy(mode));
      expect(arg).toContain("overrides .claude/long-work.md");
    }
  });

  it("a permission mode only when one was picked, never skip-permissions", () => {
    for (const s of [{}, { model: "opus" as const }, { effort: "max" as const }, { name: "n" }]) {
      expect(backgroundArgs(s, "x").join(" ")).not.toMatch(/permission|dangerously|skip/);
    }
    expect(cliFlags({ mode: "bypassPermissions" })).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("every value on the lists is a plain word, so none of them can read as anything but a value", () => {
    for (const o of [...MODELS, ...PERMISSION_MODES, ...EFFORTS]) {
      expect(o.value).toMatch(/^[a-zA-Z]+$/);
    }
    // the two the CLI has that are left out on purpose
    expect(PERMISSION_MODES.map((m) => m.value)).not.toContain("manual");
    expect(PERMISSION_MODES.map((m) => m.value)).not.toContain("dontAsk");
  });
});

describe("the prompt the editor gets", () => {
  it("as typed, with the long-work override as a first line the person sees before sending", () => {
    expect(editorPrompt("look at the logs")).toBe("look at the logs");
    expect(editorPrompt("")).toBe("");
    expect(editorPrompt("look at the logs", "foreground")).toBe(
      `${longWorkPromptLine("foreground")}\n\nlook at the logs`,
    );
    // no dangling blank line under the override when nothing was typed
    expect(editorPrompt("", "background")).toBe(longWorkPromptLine("background"));
  });
});
