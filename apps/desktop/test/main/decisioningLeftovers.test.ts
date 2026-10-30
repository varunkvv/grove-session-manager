import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeDecisioningLeftovers } from "../../src/main/services/decisioningLeftovers.ts";

const MODEL = "8a12b976e7d2ea60.gguf";

function layout() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grove-leftovers-"));
  const scoresDir = path.join(root, ".grove", "decisioning");
  const modelsDir = path.join(root, "Application Support", "Grove", "models");
  mkdirSync(scoresDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  return { root, scoresDir, modelsDir };
}

describe("removeDecisioningLeftovers", () => {
  it("removes the model, its part and checksum, and the empty models folder", async () => {
    const { modelsDir, scoresDir } = layout();
    for (const f of [MODEL, `${MODEL}.part`, `${MODEL}.sha256`])
      writeFileSync(path.join(modelsDir, f), "x");
    const removed = await removeDecisioningLeftovers({ scoresDir, modelsDir });
    expect(removed).toHaveLength(3);
    expect(existsSync(modelsDir)).toBe(false);
  });

  it("keeps a models folder that holds something else, and the other file", async () => {
    const { modelsDir, scoresDir } = layout();
    writeFileSync(path.join(modelsDir, MODEL), "x");
    writeFileSync(path.join(modelsDir, "other.gguf"), "keep");
    await removeDecisioningLeftovers({ scoresDir, modelsDir });
    expect(readdirSync(modelsDir)).toEqual(["other.gguf"]);
  });

  it("removes the score files and the decisioning folder when nothing is left in it", async () => {
    const { scoresDir } = layout();
    writeFileSync(path.join(scoresDir, "scores.abc123.v3.json"), "{}");
    writeFileSync(path.join(scoresDir, "scores.abc123.v3.json.1234.beef.tmp"), "{}");
    const removed = await removeDecisioningLeftovers({ scoresDir });
    expect(removed).toHaveLength(2);
    expect(existsSync(scoresDir)).toBe(false);
  });

  it("leaves a file that is not a score file in place", async () => {
    const { scoresDir } = layout();
    writeFileSync(path.join(scoresDir, "scores.abc.v3.json"), "{}");
    writeFileSync(path.join(scoresDir, "notes.txt"), "keep");
    await removeDecisioningLeftovers({ scoresDir });
    expect(readdirSync(scoresDir)).toEqual(["notes.txt"]);
  });

  it("never touches the model when no models folder is given (a test root)", async () => {
    const { modelsDir, scoresDir } = layout();
    writeFileSync(path.join(modelsDir, MODEL), "x");
    await removeDecisioningLeftovers({ scoresDir });
    expect(existsSync(path.join(modelsDir, MODEL))).toBe(true);
  });

  it("does nothing, and does not throw, on a second run or when the folders never existed", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grove-leftovers-none-"));
    const scoresDir = path.join(root, "decisioning");
    const modelsDir = path.join(root, "models");
    expect(await removeDecisioningLeftovers({ scoresDir, modelsDir })).toEqual([]);
    expect(await removeDecisioningLeftovers({ scoresDir, modelsDir })).toEqual([]);
  });
});
