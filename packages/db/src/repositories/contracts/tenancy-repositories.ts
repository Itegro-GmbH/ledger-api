// Platforms, tenants, API keys and stored idempotent answers (decisions/0001-ledger-api.md
// "Tenancy: platform and tenant", "Request conventions"). Contracts only.
//
// A tenant is always looked up within a platform and environment: a foreign or unknown tenant is
// simply not found (the API answers `tenant_not_found`), never another platform's row. The only
// lookup by bare id is `lockForUpdate`, for use cases that already hold a resolved tenant id.
import type { InferSelectModel } from "drizzle-orm";

import type { apiKeys, Environment, idempotencyKeys, platforms, tenants } from "../../schema/platforms";

export type PlatformRow = InferSelectModel<typeof platforms>;
export type TenantRow = InferSelectModel<typeof tenants>;
/** A key as listed: never the hash. */
export type ApiKeyRow = Omit<InferSelectModel<typeof apiKeys>, "secretHash">;
export type IdempotencyKeyRow = InferSelectModel<typeof idempotencyKeys>;

export const API_KEY_SCOPES = ["read", "write", "filing"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface PlatformRepository {
  create(input: { id?: string; name: string }): Promise<PlatformRow>;
  findById(id: string): Promise<PlatformRow | null>;
}

export type TenantScope = { platformId: string; environment: Environment };

export interface TenantRepository {
  /** `id` may be supplied by the caller (the adoption migration keeps workspace ids). */
  create(input: TenantScope & { id?: string; name: string; externalRef?: string | null }): Promise<TenantRow>;
  /** Oldest first. */
  list(scope: TenantScope): Promise<TenantRow[]>;
  find(scope: TenantScope, id: string): Promise<TenantRow | null>;
  findByExternalRef(scope: TenantScope, externalRef: string): Promise<TenantRow | null>;
  update(scope: TenantScope, id: string, patch: { name?: string; externalRef?: string | null }): Promise<TenantRow | null>;
  /** Deletes the tenant and, by cascade, all of its books (submitted filings included: the
   * filing-lock trigger lets the cascade through). */
  delete(scope: TenantScope, id: string): Promise<boolean>;
  /** Locks the tenant row until the transaction ends (`SELECT ... FOR UPDATE`): serializes
   * seeding the chart. For a tenant id already resolved by the caller. */
  lockForUpdate(id: string): Promise<TenantRow | null>;
}

export interface ApiKeyRepository {
  /** Creates a key and returns its plain secret ONCE (`sk_test_...`/`sk_live_...` and 32 random
   * bytes, base64url); only its sha256 is stored. */
  create(input: TenantScope & { name: string; scopes: readonly ApiKeyScope[] }): Promise<{ key: ApiKeyRow; secret: string }>;
  /** The key for a presented secret, unless revoked or unknown; marks it used (`last_used_at`). */
  resolve(secret: string): Promise<ApiKeyRow | null>;
  /** Newest first, revoked keys included. */
  list(platformId: string): Promise<ApiKeyRow[]>;
  /** `false` when no such unrevoked key exists for the platform. */
  revoke(platformId: string, id: string): Promise<boolean>;
}

export interface IdempotencyRepository {
  get(input: { platformId: string; environment: Environment; key: string }): Promise<IdempotencyKeyRow | null>;
  /** Stores the answer unless the key already holds one; returns what is stored either way, so
   * of two concurrent requests with one key only the first answer is kept. */
  put(input: { platformId: string; environment: Environment; key: string; operation: string; requestHash: string; statusCode: number; response: unknown }): Promise<IdempotencyKeyRow>;
}
