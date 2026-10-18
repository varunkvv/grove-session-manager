import { defineConfig } from "@playwright/test";

// grove chat's speed, measured against the plan's budgets. never part of `test:e2e`
export default defineConfig({
  testDir: ".",
  testMatch: "*.perf.ts",
  workers: 1,
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "../test-results/perf",
});
