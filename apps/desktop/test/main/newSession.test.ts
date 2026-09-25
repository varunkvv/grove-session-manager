import { longWorkPromptLine, longWorkSessionPolicy } from "@grove/core";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/main/errors.ts";
import {
  backgroundArgs,
  cliFlags,
  editorPrompt,
  parseNewSession,
  terminalArgs,
} from "../../src/main/services/newSession.ts";
import { EFFORTS, MODELS, PERMISSION_MODES } from "../../src/shared/newSession.ts";

const APPEND = "--append-system-prompt=";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : "not-app-error";
  }
  return undefined;
}

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

describe("a request from the page", () => {
  const base = { combo: "ops", prompt: "tidy up" };

  it("is held to the lists: anything off them is refused, not dropped", () => {
    expect(code(() => parseNewSession({ ...base, where: "background", model: "gpt" }))).toBe(
      "invalid",
    );
    expect(code(() => parseNewSession({ ...base, where: "terminal", mode: "dontAsk" }))).toBe(
      "invalid",
    );
    expect(code(() => parseNewSession({ ...base, where: "terminal", effort: "--max" }))).toBe(
      "invalid",
    );
    expect(code(() => parseNewSession({ ...base, where: "background", longWork: "both" }))).toBe(
      "invalid",
    );
    expect(code(() => parseNewSession({ ...base, where: "window" }))).toBe("invalid");
    expect(code(() => parseNewSession(null))).toBe("invalid");
    // Default in a select arrives as nothing
    expect(parseNewSession({ ...base, where: "terminal", model: "", mode: undefined })).toEqual({
      combo: "ops",
      where: "terminal",
      prompt: "tidy up",
    });
  });

  it("background needs a prompt. terminal and the editor do not", () => {
    expect(code(() => parseNewSession({ combo: "ops", where: "background", prompt: "  " }))).toBe(
      "empty-prompt",
    );
    expect(parseNewSession({ combo: "ops", where: "terminal", prompt: " " }).prompt).toBe("");
    expect(parseNewSession({ combo: "ops", where: "editor", prompt: "" }).prompt).toBe("");
    expect(
      code(() => parseNewSession({ ...base, where: "terminal", prompt: "x".repeat(20_001) })),
    ).toBe("long-prompt");
  });

  it("the editor gets the prompt and the long-work choice only. the panel picks its own model", () => {
    expect(
      parseNewSession({
        ...base,
        prompt: "  keep my indent\n",
        where: "editor",
        longWork: "foreground",
        model: "haiku",
        mode: "plan",
        effort: "low",
        name: "n",
        throughTerminal: true,
      }),
    ).toEqual({
      combo: "ops",
      where: "editor",
      prompt: "  keep my indent",
      longWork: "foreground",
    });
  });

  it("a name is squashed to one line and capped. the Terminal way round is for background only", () => {
    const req = parseNewSession({
      ...base,
      where: "background",
      name: "  nightly\n tidy ",
      model: "sonnet",
      throughTerminal: true,
    });
    expect(req).toEqual({
      combo: "ops",
      where: "background",
      prompt: "tidy up",
      model: "sonnet",
      name: "nightly tidy",
      throughTerminal: true,
    });
    expect(
      parseNewSession({ ...base, where: "terminal", throughTerminal: true }).throughTerminal,
    ).toBeUndefined();
    expect(code(() => parseNewSession({ ...base, where: "terminal", name: "n".repeat(101) }))).toBe(
      "long-name",
    );
  });
});
