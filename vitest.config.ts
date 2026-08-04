import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: [
        "src/**/*.ts",
        "web/assets/scripts/**/*.js",
      ],
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        branches: 29,
        functions: 35.4,
        lines: 35.4,
        statements: 35.5,
        "src/chat/retrieval-question.ts": {
          branches: 94,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "src/documents/catalog/query-scope.ts": {
          branches: 87,
          functions: 100,
          lines: 98,
          statements: 98,
        },
      },
    },
  },
});
