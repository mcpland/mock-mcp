import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/**/*.test.{js,ts,jsx,tsx}",
      "test/**/*.spec.{js,ts,jsx,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Exclude inspector tests by default as they can timeout
      // Run them separately with: yarn test:inspector
      "test/inspector-integration.test.ts",
    ],
    testTimeout: 60000, // 60 seconds per test
    hookTimeout: 30000, // 30 seconds for hooks
    teardownTimeout: 30000, // 30 seconds for teardown
    maxConcurrency: 1, // Run tests sequentially within each file
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.{js,ts,jsx,tsx}"],
      exclude: [],
    },
  },
});
