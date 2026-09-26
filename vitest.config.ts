import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Fixture tests spawn many short Git processes, which is slow on Windows.
    testTimeout: 30_000,
  },
});
