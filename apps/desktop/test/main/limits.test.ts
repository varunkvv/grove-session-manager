import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageLimits } from "@grove/core";
import { describe, expect, it, vi } from "vitest";
import { claudeStateFile, LimitsService } from "../../src/main/services/limits.ts";

const FETCHED = 1_793_462_991_265;

/** a metered account's cache, `used` of a $2,000 cap, in cents */
const metered = (used: number) => ({
  numStartups: 3,
  cachedUsageUtilization: {
    fetchedAtMs: FETCHED,
    utilization: {
      five_hour: null,
      spend: {
        used: { amount_minor: used, currency: "USD", exponent: 2 },
        limit: { amount_minor: 200000, currency: "USD", exponent: 2 },
        percent: Math.round(used / 2000),
        severity: "normal",
        enabled: true,
      },
    },
  },
});

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grove-limits-"));
  const file = path.join(dir, ".claude.json");
  const seen: Array<UsageLimits | null> = [];
  const service = new LimitsService({ file, onChange: (l) => seen.push(l) });
  /** written with an mtime of its own: two writes in the same millisecond still differ */
  let tick = 0;
  const write = (body: unknown, n = ++tick) => {
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    const at = new Date(FETCHED + n * 1000);
    utimesSync(file, at, at);
    return n;
  };
  return { dir, file, seen, service, write };
}

describe("claudeStateFile", () => {
  it("beside the default config folder, inside any other, as Claude Code picks it", () => {
    expect(claudeStateFile("/Users/me/.claude", "/Users/me")).toBe("/Users/me/.claude.json");
    expect(claudeStateFile("/Users/me/.claude/", "/Users/me")).toBe("/Users/me/.claude.json");
    expect(claudeStateFile("/tmp/fixture/claude", "/Users/me")).toBe(
      "/tmp/fixture/claude/.claude.json",
    );
  });
});

describe("LimitsService", () => {
  it("reads the limits, and tells only when they moved", async () => {
    const { service, seen, write } = setup();
    write(metered(41031));
    await service.read();
    expect(service.current()?.spend).toMatchObject({ used: 410.31, limit: 2000, percent: 21 });
    expect(seen).toHaveLength(1);

    // the same file looked at again: nothing read, nothing told
    await service.read();
    expect(seen).toHaveLength(1);

    // claude code wrote something else in the file: read again, and the limits did not move
    write({ ...metered(41031), numStartups: 4 });
    await service.read();
    expect(seen).toHaveLength(1);

    write(metered(50000));
    await service.read();
    expect(seen).toHaveLength(2);
    expect(service.current()?.spend?.used).toBe(500);
  });

  it("a file caught mid-write keeps what was read last, and is read again next time", async () => {
    const { service, seen, write } = setup();
    write(metered(41031));
    await service.read();
    const torn = write('{"cachedUsageUtilization": {"fetchedAt');
    await service.read();
    expect(service.current()?.spend?.used).toBe(410.31);
    expect(seen).toHaveLength(1);
    // finished, with the same mtime it had when it was torn: still read
    write(metered(60000), torn);
    await service.read();
    expect(service.current()?.spend?.used).toBe(600);
  });

  it("no file, or one with no limits in it, is nothing", async () => {
    const { service, seen, write, file } = setup();
    await service.read();
    expect(service.current()).toBeNull();
    // null to begin with: nothing to tell
    expect(seen).toEqual([]);

    write(metered(41031));
    await service.read();
    rmSync(file);
    await service.read();
    expect(service.current()).toBeNull();
    expect(seen.at(-1)).toBeNull();

    write({ numStartups: 1 });
    await service.read();
    expect(service.current()).toBeNull();
  });

  it("a listener that throws is logged, and the next look still runs", async () => {
    const { file, write } = setup();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const service = new LimitsService({
      file,
      onChange: () => {
        calls++;
        throw new Error("boom");
      },
    });
    write(metered(41031));
    await expect(service.read()).resolves.toBeUndefined();
    expect(service.current()?.spend?.used).toBe(410.31);
    write(metered(50000));
    await service.read();
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("two looks at once read the file once", async () => {
    const { service, seen, write } = setup();
    write(metered(41031));
    const a = service.read();
    const b = service.read();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(seen).toHaveLength(1);
  });
});
