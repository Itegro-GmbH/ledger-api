// The tenancy model (decisions/0001-ledger-api.md "Tenancy: platform and tenant"): a platform is
// an API customer (a software product such as Digipost), a tenant is one set of books it keeps
// for one of its own customers. Test and live are separate by key and by the `environment`
// column, not by another level. Every bookkeeping table (`./ledger.ts`) carries `tenant_id` and
// cascades from `tenants.id`; a platform's deletion cascades into its tenants, keys and stored
// idempotent answers.
//
// Everything lives in the Postgres schema `ledger` (decisions/0001 "One database instance shared
// with Digipost, two schemas"): this service never touches `public`.
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** The Postgres schema this service owns. */
export const ledgerSchema = pgSchema("ledger");

export const ENVIRONMENTS = ["test", "live"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const platforms = ledgerSchema.table("platforms", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** One set of books ("Mandant"). The id has a default, but a caller may supply it: the adoption
 * migration keeps Digipost's workspace ids as tenant ids (decisions/0001 "Moving Digipost's
 * ledger here"). `external_ref` is the platform's own id for it, unique per platform and
 * environment when set. */
export const tenants = ledgerSchema.table(
  "tenants",
  {
    id: uuid().primaryKey().defaultRandom(),
    platformId: uuid()
      .notNull()
      .references(() => platforms.id, { onDelete: "cascade" }),
    environment: text({ enum: ENVIRONMENTS }).notNull(),
    name: text().notNull(),
    externalRef: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tenants_platform_environment_idx").on(t.platformId, t.environment),
    uniqueIndex("tenants_platform_environment_external_ref_key").on(t.platformId, t.environment, t.externalRef).where(sql`${t.externalRef} is not null`),
    check("tenants_environment_check", sql`${t.environment} in ('test', 'live')`),
  ],
);

/** A platform's API key. Only the sha256 of the secret is stored; `prefix` (the first 12
 * characters, `sk_live_xxxx`) is kept for display. A revoked key never resolves again. */
export const apiKeys = ledgerSchema.table(
  "api_keys",
  {
    id: uuid().primaryKey().defaultRandom(),
    platformId: uuid()
      .notNull()
      .references(() => platforms.id, { onDelete: "cascade" }),
    environment: text({ enum: ENVIRONMENTS }).notNull(),
    name: text().notNull(),
    prefix: text().notNull(),
    /** Lowercase hex sha256 of the full secret. */
    secretHash: text().notNull().unique("api_keys_secret_hash_key"),
    scopes: text().array().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("api_keys_platform_idx").on(t.platformId, t.environment), check("api_keys_environment_check", sql`${t.environment} in ('test', 'live')`)],
);

/** The stored answer of a `write` or `destructive` operation per `Idempotency-Key`
 * (decisions/0001 "Request conventions"): the same key with the same body (`request_hash`)
 * returns it again, a different body is `idempotency_conflict`. */
export const idempotencyKeys = ledgerSchema.table(
  "idempotency_keys",
  {
    platformId: uuid()
      .notNull()
      .references(() => platforms.id, { onDelete: "cascade" }),
    environment: text({ enum: ENVIRONMENTS }).notNull(),
    key: text().notNull(),
    operation: text().notNull(),
    requestHash: text().notNull(),
    statusCode: integer().notNull(),
    response: jsonb().$type<unknown>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.platformId, t.environment, t.key] }), check("idempotency_keys_environment_check", sql`${t.environment} in ('test', 'live')`)],
);
