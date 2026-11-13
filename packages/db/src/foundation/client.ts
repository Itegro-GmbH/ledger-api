// The only module that knows the driver: `pg` + `drizzle-orm/node-postgres`, `casing:
// "snake_case"` (the schema's camelCase columns map to the database's snake_case ones). A real
// pool, not the HTTP driver: the booking use cases need real transactions
// (decisions/0001-ledger-api.md "Stack and hosting").
//
// The pool is the caller's: the API app builds one per instance (and attaches it to its
// platform's lifecycle), tests build their own against `TEST_DATABASE_URL`.
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import * as schema from "../schema";

export function createDb(pool: Pool) {
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type LedgerDb = ReturnType<typeof createDb>;
