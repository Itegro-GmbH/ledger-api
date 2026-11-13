// The composition root (decisions/0001-ledger-api.md): binds the app's ports to the database
// when `DATABASE_URL` is set. One pool per serverless instance, kept small: Neon's pooler
// multiplexes, and the booking use cases hold a connection only for their own transaction.
import {
  createDb,
  createDrizzleRepositories,
  createDrizzleUnitOfWork,
  createDrizzleSourceReader,
  createLedgerUseCases,
  createSourceUseCases,
  type Repositories,
} from "@ledger/db";
import { KEY_SCOPES, type KeyScope, type OperationOutcome } from "@ledger/operations";
import { Pool } from "pg";

import type { AppDeps } from "./app";
import type { CallerStore } from "./caller";
import type { IdempotencyStore } from "./execute";
import { httpStatusOf } from "./http-status";

export function createDatabaseDeps(pool: Pool): Pick<AppDeps, "callers" | "idempotency" | "bindServices"> {
  const db = createDb(pool);
  const repos = createDrizzleRepositories(db);
  const uow = createDrizzleUnitOfWork(db);
  const ledger = createLedgerUseCases({ repos, uow, sources: createDrizzleSourceReader(db) });
  const sources = createSourceUseCases({ repos, uow });
  const services = { ledger, tenants: repos.tenant, sources };
  return { callers: callerStore(repos), idempotency: idempotencyStore(repos), bindServices: (ctx) => ({ ...ctx, services }) };
}

export function callerStore(repos: Repositories): CallerStore {
  return {
    async resolveKey(secret) {
      const key = await repos.apiKey.resolve(secret);
      if (!key) return null;
      const platform = await repos.platform.findById(key.platformId);
      if (!platform) return null;
      const scopes = key.scopes.filter((scope): scope is KeyScope => (KEY_SCOPES as readonly string[]).includes(scope));
      return { platform: { id: platform.id, name: platform.name }, environment: key.environment, scopes };
    },
    async findTenant(platformId, environment, tenantId) {
      if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return null;
      const tenant = await repos.tenant.find({ platformId, environment }, tenantId);
      return tenant ? { id: tenant.id, name: tenant.name } : null;
    },
  };
}

export function idempotencyStore(repos: Repositories): IdempotencyStore {
  return {
    async get(platformId, environment, key) {
      const row = await repos.idempotency.get({ platformId, environment, key });
      return row ? { operation: row.operation, requestHash: row.requestHash, outcome: row.response as OperationOutcome } : null;
    },
    async put(platformId, environment, key, record) {
      const statusCode = record.outcome.ok ? 200 : httpStatusOf(record.outcome.code);
      await repos.idempotency.put({ platformId, environment, key, operation: record.operation, requestHash: record.requestHash, statusCode, response: record.outcome });
    },
  };
}

export function poolFor(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 3, idleTimeoutMillis: 10_000 });
}
