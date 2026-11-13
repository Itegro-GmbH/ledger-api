import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"], exclude: ["**/*.db.test.ts", "**/node_modules/**"] } },
      {
        // Real Postgres at `TEST_DATABASE_URL` (local hosts only). The global setup rebuilds the
        // schema `ledger` from the migrations once per run; tests isolate by their own tenants.
        test: {
          name: "db",
          include: ["packages/*/tests/**/*.db.test.ts", "apps/*/tests/**/*.db.test.ts"],
          fileParallelism: false,
          globalSetup: ["packages/db/tests/support/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
