// Builds the `Repositories` bundle over one executor: the pool, or one open transaction
// (`unit-of-work.ts`).
import type { DbExecutor } from "../../foundation/db-types";
import type { Repositories } from "../contracts";
import { createDrizzleLedgerRepository } from "./ledger-repository";
import { createDrizzleSourceRepository } from "./source-repository";
import { createDrizzleApiKeyRepository, createDrizzleIdempotencyRepository, createDrizzlePlatformRepository, createDrizzleTenantRepository } from "./tenancy-repositories";

export function createDrizzleRepositories(db: DbExecutor): Repositories {
  return {
    ledger: createDrizzleLedgerRepository(db),
    platform: createDrizzlePlatformRepository(db),
    tenant: createDrizzleTenantRepository(db),
    apiKey: createDrizzleApiKeyRepository(db),
    idempotency: createDrizzleIdempotencyRepository(db),
    sources: createDrizzleSourceRepository(db),
  };
}
