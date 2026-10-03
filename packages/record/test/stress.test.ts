// runs the race proof (stress.ts) as a child process: 3 rounds of 30 contenders, 20 under STRESS=1.
// then each broken publish for one round, which must fail, so the checks are known to catch one.
//
//   pnpm vitest run packages/record/test/stress.test.ts
//   STRESS=1 pnpm vitest run packages/record/test/stress.test.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { PKG } from "./lib.ts";

const STRESS = path.join(PKG, "test", "stress.ts");
const ROUNDS = process.env.STRESS === "1" ? "20" : "3";

function stress(...args: string[]): Promise<{ code: number; out: string }> {
  return promisify(execFile)(process.execPath, [STRESS, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  }).then(
    (r) => ({ code: 0, out: r.stdout }),
    (e: { code?: number; stdout?: string; message: string }) => ({
      code: e.code ?? -1,
      out: e.stdout ?? e.message,
    }),
  );
}

test(`${ROUNDS} rounds of 30 contenders: 0 failed checks`, async () => {
  const r = await stress(ROUNDS, "30");
  console.log(r.out.trimEnd().split("\n").at(-1));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`TOTAL: ${ROUNDS} rounds, 0 failed checks`));
}, 1_200_000);

for (const broken of ["naive", "rename"]) {
  test(`control: a ${broken} publish fails the checks`, async () => {
    const r = await stress("1", "30", "--broken", broken);
    console.log(r.out.trimEnd().split("\n").at(-1));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /TOTAL: 1 rounds, [1-9]\d* failed checks/);
  }, 300_000);
}
