import { describe, expect, it } from "vitest";
import { backgroundArgs, cliFlags, terminalArgs } from "../../src/main/services/newSession.ts";
import { EFFORTS, MODELS, PERMISSION_MODES, startDefaults } from "../../src/shared/newSession.ts";

describe("a project's model and effort for its new sessions", () => {
  it("are the ones claude takes, and anything else is claude's own default", () => {
    expect(startDefaults({ model: "opus", effort: "max" })).toEqual({
      model: "opus",
      effort: "max",
    });
    expect(startDefaults({})).toEqual({});
    expect(startDefaults({ model: "gpt", effort: "ludicrous" })).toEqual({});
    expect(backgroundArgs(startDefaults({ model: "sonnet", effort: "low" }), "go")).toEqual([
      "--bg",
      "--model",
      "sonnet",
      "--effort",
      "low",
      "--",
      "go",
    ]);
  });
});

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
      name: "nightly tidy",
    } as const;
    const flags = [
      "--model",
      "haiku",
      "--permission-mode",
      "plan",
      "--effort",
      "low",
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
