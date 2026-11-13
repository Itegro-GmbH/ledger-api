// pnpm db:migrate
//
// Applies the pending migrations to `DATABASE_URL` (src/migrate.ts). Never run this against a
// shared or production database without the owner's explicit approval for that specific run
// (AGENTS.md "Migrations"); local development and tests use a throwaway Postgres.
import { runMigrations } from "../src/migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}

const host = (() => {
  try {
    return new URL(url).host;
  } catch {
    return "(unparsable)";
  }
})();

try {
  console.log(`db:migrate -> ${host}`);
  await runMigrations(url);
  console.log("  up to date");
} catch (err) {
  console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
