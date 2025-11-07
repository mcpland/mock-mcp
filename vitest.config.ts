import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/**/*.test.{js,ts,jsx,tsx}",
      "test/**/*.spec.{js,ts,jsx,tsx}",
    ],
    exclude: [],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.{js,ts,jsx,tsx}"],
      exclude: [],
    },
  },
});
