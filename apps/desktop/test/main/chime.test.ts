import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHIME, chimeWav, installChime } from "../../src/main/chime.ts";

describe("the notification chime", () => {
  it("is a short, quiet, 16-bit mono wav that starts and ends on nothing", () => {
    const wav = chimeWav();
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.toString("latin1", 8, 16)).toBe("WAVEfmt ");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    // PCM, one channel, 44.1kHz, 16 bits
    expect([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24)]).toEqual([
      1, 1, 44_100,
    ]);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);

    const samples = (wav.length - 44) / 2;
    expect(samples / 44_100).toBeLessThan(0.5);
    let peak = 0;
    for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(wav.readInt16LE(44 + i * 2)));
    // it is heard, and it is not louder than the system's own alerts
    expect(peak / 32768).toBeGreaterThan(0.2);
    expect(peak / 32768).toBeLessThanOrEqual(0.3);
    expect(wav.readInt16LE(44)).toBe(0);
    expect(wav.readInt16LE(wav.length - 2)).toBe(0);
  });

  it("is written to ~/Library/Sounds once, and again only when the file is not grove's chime", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "grove-chime-"));
    const file = path.join(home, "Library", "Sounds", CHIME);
    await installChime(home);
    expect(readFileSync(file).equals(chimeWav())).toBe(true);

    // the same bytes are left alone
    const then = new Date(2020, 0, 1);
    utimesSync(file, then, then);
    await installChime(home);
    expect(statSync(file).mtimeMs).toBe(then.getTime());

    // an older version's chime is replaced
    writeFileSync(file, "not the chime");
    await installChime(home);
    expect(readFileSync(file).equals(chimeWav())).toBe(true);
  });
});
