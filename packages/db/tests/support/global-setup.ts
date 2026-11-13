// The `db` test project's global setup: a fresh schema state once per run. Drops the schema
// `ledger` of the (local, throwaway) test database and applies every migration, so the run starts
// from exactly what `pnpm db:migrate` builds. Tests then isolate themselves by creating their own
// platform and tenant.
import pg from "pg";

import { runMigrations } from "../../src/migrate";
import { testDatabaseUrl } from "./test-database-url";

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("drop schema if exists ledger cascade");
  } finally {
    await client.end();
  }
  await runMigrations(url);
}
