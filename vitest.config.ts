import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"], exclude: ["**/*.db.test.ts", "**/node_modules/**"] } },
      { test: { name: "db", include: ["packages/*/tests/**/*.db.test.ts", "apps/*/tests/**/*.db.test.ts"], fileParallelism: false } },
    ],
  },
});
