import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "record",
    include: ["test/**/*.test.ts"],
    // the liveness, protocol and state tests run real processes, many per case
    testTimeout: 120_000,
  },
});
