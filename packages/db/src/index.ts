// @ledger/db (decisions/0001-ledger-api.md): the Drizzle schema (Postgres schema `ledger`), the
// migrations and their runner, the repositories behind a unit of work, and the ledger's use cases
// moved from Digipost's `src/persistence` (Digipost decisions/0080).
//
// Wiring, from a `pg` Pool:
//
//   const db = createDb(pool);
//   const repos = createDrizzleRepositories(db);
//   const uow = createDrizzleUnitOfWork(db);
//   const ledger = createLedgerUseCases({ repos, uow, sources: createDrizzleSourceReader(db) });
//   const sources = createSourceUseCases({ repos, uow });
export * from "./schema";
export { createDb, type LedgerDb } from "./foundation/client";
export type { DbExecutor, DbTx } from "./foundation/db-types";
export { dbErrorOf, isDbError, type DbError, type DbErrorKind } from "./foundation/db-errors";
export { UseCaseError } from "./errors";
export { MIGRATIONS_FOLDER, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE, runMigrations } from "./migrate";

export * from "./repositories/contracts";
export { createDrizzleRepositories } from "./repositories/drizzle/create-repositories";
export { createDrizzleUnitOfWork } from "./repositories/drizzle/unit-of-work";
export { createDrizzleLedgerRepository } from "./repositories/drizzle/ledger-repository";
export {
  API_KEY_PREFIX_LENGTH,
  createDrizzleApiKeyRepository,
  createDrizzleIdempotencyRepository,
  createDrizzlePlatformRepository,
  createDrizzleTenantRepository,
  hashApiKeySecret,
} from "./repositories/drizzle/tenancy-repositories";

export * from "./sources/source-reader";
export * from "./sources/contact-resolution";
export { createDrizzleSourceReader } from "./sources/drizzle-source-reader";
export { DOCUMENT_PAYMENT_STATUSES, documentPaymentStatus, type DocumentPaymentStatus } from "./sources/payment-status";
export { createDrizzleSourceRepository } from "./repositories/drizzle/source-repository";

export {
  createLedgerUseCases,
  LEDGER_ERROR,
  MAX_ADVICE_QUESTIONS_PER_SYNC,
  type AdvisorComparisonView,
  type BulkBookResult,
  type LedgerErrorCode,
  type LedgerUseCaseDeps,
  type LedgerUseCases,
  type ProposalOutcome,
} from "./use-cases/ledger-use-cases";
export {
  createSourceUseCases,
  normalizeCode,
  SOURCE_ERROR,
  type CounterpartyInput,
  type DocumentInput,
  type LinkInput,
  type MoneyAccountInput,
  type MoneyAccountPatchInput,
  type MovementInput,
  type MovementUpsertResult,
  type SourceErrorCode,
  type SourceUseCaseDeps,
  type SourceUseCases,
  type StatementImportResult,
  type StatementInput,
} from "./use-cases/source-use-cases";
