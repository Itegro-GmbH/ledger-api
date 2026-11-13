// Shared Drizzle types. Repositories accept a `DbExecutor` so the same repository works whether it
// runs directly against the pool or inside `uow.transaction(...)` (`repositories/drizzle/
// unit-of-work.ts`); use cases never see this type, only repositories.
import type { LedgerDb } from "./client";

/** The transaction handle `LedgerDb["transaction"]`'s callback receives. */
export type DbTx = Parameters<Parameters<LedgerDb["transaction"]>[0]>[0];

/** Whatever a repository runs queries against: the pool, or one open transaction. */
export type DbExecutor = LedgerDb | DbTx;
