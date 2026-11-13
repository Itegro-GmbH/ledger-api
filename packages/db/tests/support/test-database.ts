// The database tests' connection (`./test-database-url.ts`) and their isolation: each test
// creates its own platform and tenant.
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll } from "vitest";

import { createDb, createDrizzleRepositories, type Environment, type LedgerDb } from "../../src";
import { testDatabaseUrl } from "./test-database-url";

/** A pool for this test file, closed after it. */
export function useTestDb(): { db: LedgerDb; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
  afterAll(() => pool.end());
  return { db: createDb(pool), pool };
}

/** A fresh platform with one tenant: every test works in its own books. */
export async function newTenant(db: LedgerDb, options: { environment?: Environment; name?: string } = {}) {
  const repos = createDrizzleRepositories(db);
  const platform = await repos.platform.create({ name: `Plattform ${randomUUID()}` });
  const tenant = await repos.tenant.create({ platformId: platform.id, environment: options.environment ?? "test", name: options.name ?? `Muster GmbH ${randomUUID()}` });
  return { platform, tenant, scope: { platformId: platform.id, environment: tenant.environment } };
}
