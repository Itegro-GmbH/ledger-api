// The `Repositories` bundle and the `UnitOfWork`. Use cases import only from here, never from
// `../drizzle`: that keeps them free of Drizzle types and testable with a typed fake.
import type { LedgerRepository } from "./ledger-repository";
import type { SourceRepository } from "./source-repository";
import type { ApiKeyRepository, IdempotencyRepository, PlatformRepository, TenantRepository } from "./tenancy-repositories";

export type * from "./ledger-repository";
export type * from "./tenancy-repositories";
export type * from "./source-repository";
export { API_KEY_SCOPES } from "./tenancy-repositories";

export type Repositories = {
  ledger: LedgerRepository;
  platform: PlatformRepository;
  tenant: TenantRepository;
  apiKey: ApiKeyRepository;
  idempotency: IdempotencyRepository;
  sources: SourceRepository;
};

export interface UnitOfWork {
  /** Runs `work` in one database transaction with repositories bound to it; commits when it
   * resolves, rolls back when it throws (also when a deferred constraint fails at commit). */
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
