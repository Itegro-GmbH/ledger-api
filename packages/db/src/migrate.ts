// Applies packages/db/migrations (drizzle-kit generated, plus the trigger SQL as custom
// migrations) with drizzle-orm's own migrator. The migrations table is `ledger.__migrations`,
// inside the schema this service owns (decisions/0001-ledger-api.md), the same one
// drizzle.config.ts names.
//
// One `pg.Client` (one session, not a pool) holds a `pg_advisory_lock` for the whole run, so only
// one migrator runs against a database at a time; the lock is released when the connection
// closes. Used by scripts/migrate.ts (`pnpm db:migrate`) and by the database tests' global setup.
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));
export const MIGRATIONS_SCHEMA = "ledger";
export const MIGRATIONS_TABLE = "__migrations";
const LOCK_KEY = "ledger-api.db-migrate";

export async function runMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString, application_name: "ledger-api db:migrate" });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [LOCK_KEY]);
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: MIGRATIONS_SCHEMA, migrationsTable: MIGRATIONS_TABLE });
  } finally {
    await client.end();
  }
}
