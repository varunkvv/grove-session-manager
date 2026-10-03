import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const framework = path.join(
  import.meta.dirname,
  "../../node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
);
// a variable, so tsc does not look for types of an .mjs it cannot check
const script = pathToFileURL(path.join(import.meta.dirname, "../../scripts/fuses.mjs")).href;

describe("the RunAsNode fuse", () => {
  it("reads a fuse that is off as off", async () => {
    const { FUSE_SENTINEL, readFuses } = await import(script);
    const wire = Buffer.concat([
      Buffer.from(`xx${FUSE_SENTINEL}`, "latin1"),
      Buffer.from([1, 2]),
      Buffer.from("01"),
    ]);
    expect(readFuses(wire)[0].fuses).toMatchObject({
      RunAsNode: "DISABLE",
      EnableCookieEncryption: "ENABLE",
    });
  });

  // the electron binary is downloaded on first use, so a fresh checkout does not have it
  it.skipIf(!existsSync(framework))(
    "is on in the electron we ship, because the launcher runs Grove as node",
    async () => {
      const { readFuses } = await import(script);
      const wires = readFuses(readFileSync(framework));
      expect(wires.length).toBeGreaterThan(0);
      for (const w of wires) expect(w.fuses.RunAsNode).toBe("ENABLE");
    },
  );
});
