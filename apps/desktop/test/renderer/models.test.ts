import { describe, expect, it } from "vitest";
import { splitModels } from "../../src/renderer/logic/models.ts";
import type { ChatStatus } from "../../src/shared/ipc.ts";
import fixture from "../fixtures/models.json";

type Model = ChatStatus["models"][number];

/** claude 2.1.310's initialize answer on varun's account, mapped the way chat.ts maps it */
const live: Model[] = fixture.models.map((m) => ({
  value: m.value,
  label: m.displayName,
  ...(m.resolvedModel ? { id: m.resolvedModel } : {}),
}));

const m = (value: string, id?: string): Model => ({ value, label: value, ...(id ? { id } : {}) });

describe("the model menu", () => {
  it("keeps Default and the newest of each series on the real list, the rest under More", () => {
    const { top, more } = splitModels(live);
    expect(top.map((x) => x.label)).toEqual([
      "Default (recommended)",
      "Opus 5.5",
      "Fable 5.1",
      "Sonnet 5.5",
      "Haiku 5.5",
    ]);
    expect(more.map((x) => x.label)).toEqual([
      "Haiku 4.5",
      "Sonnet 5",
      "Opus 5",
      "Fable 5",
      "Opus 4.8",
      "Opus 4.7",
      "Opus 4.6",
      "Sonnet 4.6",
    ]);
  });

  it("an alias wins a tie with the id it stands for", () => {
    const { top, more } = splitModels([
      m("claude-opus-5-5", "claude-opus-5-5"),
      m("opus", "claude-opus-5-5"),
    ]);
    expect(top.map((x) => x.value)).toEqual(["opus"]);
    expect(more.map((x) => x.value)).toEqual(["claude-opus-5-5"]);
  });

  it("a date in the id is not a version", () => {
    const { top } = splitModels([
      m("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"),
      m("claude-haiku-5", "claude-haiku-5"),
    ]);
    expect(top.map((x) => x.value)).toEqual(["claude-haiku-5"]);
  });

  it("a model of no known family is a series of its own, and stays", () => {
    const { top, more } = splitModels([m("default"), m("my-proxy-model"), m("other-one")]);
    expect(top.map((x) => x.value)).toEqual(["default", "my-proxy-model", "other-one"]);
    expect(more).toEqual([]);
  });

  it("with no ids (the old fixture's shape) the value is read", () => {
    const { top, more } = splitModels([m("default"), m("opus"), m("sonnet"), m("haiku")]);
    expect(top).toHaveLength(4);
    expect(more).toEqual([]);
  });
});
