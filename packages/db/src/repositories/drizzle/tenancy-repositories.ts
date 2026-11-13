// Platforms, tenants, API keys and stored idempotent answers (decisions/0001-ledger-api.md).
// Encapsulates access only. Every tenant read and write filters on the platform and environment
// as well as the id, so another platform's tenant is never found.
import { createHash, randomBytes } from "node:crypto";

import { and, asc, desc, eq, isNull } from "drizzle-orm";

import type { DbExecutor } from "../../foundation/db-types";
import { apiKeys, idempotencyKeys, platforms, tenants } from "../../schema/platforms";
import type { ApiKeyRepository, ApiKeyRow, IdempotencyRepository, PlatformRepository, TenantRepository, TenantScope } from "../contracts/tenancy-repositories";

function first<T>(rows: T[], table: string): T {
  const [row] = rows;
  if (!row) throw new Error(`insert into ${table} returned no row`);
  return row;
}

function inScope(scope: TenantScope) {
  return and(eq(tenants.platformId, scope.platformId), eq(tenants.environment, scope.environment));
}

/** Lowercase hex sha256: how a secret is stored and looked up. */
export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** How many leading characters of a secret are kept for display (`sk_live_` and four more). */
export const API_KEY_PREFIX_LENGTH = 12;

/** Every column but the hash. */
const keyColumns = {
  id: apiKeys.id,
  platformId: apiKeys.platformId,
  environment: apiKeys.environment,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
};

export function createDrizzlePlatformRepository(db: DbExecutor): PlatformRepository {
  return {
    async create(input) {
      return first(await db.insert(platforms).values(input).returning(), "platforms");
    },

    async findById(id) {
      const [row] = await db.select().from(platforms).where(eq(platforms.id, id)).limit(1);
      return row ?? null;
    },
  };
}

export function createDrizzleTenantRepository(db: DbExecutor): TenantRepository {
  return {
    async create(input) {
      return first(await db.insert(tenants).values(input).returning(), "tenants");
    },

    list: (scope) => db.select().from(tenants).where(inScope(scope)).orderBy(asc(tenants.createdAt), asc(tenants.id)),

    async find(scope, id) {
      const [row] = await db
        .select()
        .from(tenants)
        .where(and(inScope(scope), eq(tenants.id, id)))
        .limit(1);
      return row ?? null;
    },

    async findByExternalRef(scope, externalRef) {
      const [row] = await db
        .select()
        .from(tenants)
        .where(and(inScope(scope), eq(tenants.externalRef, externalRef)))
        .limit(1);
      return row ?? null;
    },

    async update(scope, id, patch) {
      const [row] = await db
        .update(tenants)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(inScope(scope), eq(tenants.id, id)))
        .returning();
      return row ?? null;
    },

    async delete(scope, id) {
      const rows = await db
        .delete(tenants)
        .where(and(inScope(scope), eq(tenants.id, id)))
        .returning({ id: tenants.id });
      return rows.length > 0;
    },

    async lockForUpdate(id) {
      const [row] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1).for("update");
      return row ?? null;
    },
  };
}

export function createDrizzleApiKeyRepository(db: DbExecutor): ApiKeyRepository {
  return {
    async create(input) {
      const secret = `sk_${input.environment}_${randomBytes(32).toString("base64url")}`;
      const key: ApiKeyRow = first(
        await db
          .insert(apiKeys)
          .values({
            platformId: input.platformId,
            environment: input.environment,
            name: input.name,
            prefix: secret.slice(0, API_KEY_PREFIX_LENGTH),
            secretHash: hashApiKeySecret(secret),
            scopes: [...input.scopes],
          })
          .returning(keyColumns),
        "api_keys",
      );
      return { key, secret };
    },

    async resolve(secret) {
      const [row] = await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(apiKeys.secretHash, hashApiKeySecret(secret)), isNull(apiKeys.revokedAt)))
        .returning(keyColumns);
      return row ?? null;
    },

    list: (platformId) => db.select(keyColumns).from(apiKeys).where(eq(apiKeys.platformId, platformId)).orderBy(desc(apiKeys.createdAt), asc(apiKeys.id)),

    async revoke(platformId, id) {
      const rows = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.platformId, platformId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      return rows.length > 0;
    },
  };
}

export function createDrizzleIdempotencyRepository(db: DbExecutor): IdempotencyRepository {
  async function get(input: { platformId: string; environment: TenantScope["environment"]; key: string }) {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.platformId, input.platformId), eq(idempotencyKeys.environment, input.environment), eq(idempotencyKeys.key, input.key)))
      .limit(1);
    return row ?? null;
  }

  return {
    get,

    async put(input) {
      const [inserted] = await db.insert(idempotencyKeys).values(input).onConflictDoNothing().returning();
      if (inserted) return inserted;
      const stored = await get(input);
      if (!stored) throw new Error("idempotency key neither inserted nor found");
      return stored;
    },
  };
}
