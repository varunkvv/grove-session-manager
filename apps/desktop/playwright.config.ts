import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // these tests drive a real window: two at once fight over focus
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "test-results",
});
