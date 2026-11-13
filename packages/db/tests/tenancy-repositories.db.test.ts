// Real Postgres, the tenancy repositories (decisions/0001-ledger-api.md "Tenancy: platform and
// tenant", "Request conventions"): a tenant is only ever found within its platform and
// environment, an API key resolves by the hash of its secret until it is revoked, and an
// idempotency key keeps the first stored answer.
import { createHash, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { API_KEY_PREFIX_LENGTH, apiKeys, createDrizzleRepositories, isDbError, ledgerSettings, platforms } from "../src";
import { newTenant, useTestDb } from "./support/test-database";

const { db } = useTestDb();
const repos = createDrizzleRepositories(db);

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

describe("tenants", () => {
  it("are found only within their platform and environment", async () => {
    const { platform, tenant, scope } = await newTenant(db);
    const other = await newTenant(db);
    const live = await repos.tenant.create({ platformId: platform.id, environment: "live", name: "Muster GmbH live" });

    expect(await repos.tenant.find(scope, tenant.id)).toMatchObject({ id: tenant.id, environment: "test" });
    // Another platform's tenant, or the same platform's tenant in the other environment, is not found.
    expect(await repos.tenant.find(other.scope, tenant.id)).toBeNull();
    expect(await repos.tenant.find(scope, other.tenant.id)).toBeNull();
    expect(await repos.tenant.find({ platformId: platform.id, environment: "live" }, tenant.id)).toBeNull();
    expect(await repos.tenant.find(scope, live.id)).toBeNull();

    expect((await repos.tenant.list(scope)).map((row) => row.id)).toEqual([tenant.id]);
    expect((await repos.tenant.list({ platformId: platform.id, environment: "live" })).map((row) => row.id)).toEqual([live.id]);

    // Writes are scoped the same way.
    expect(await repos.tenant.update(other.scope, tenant.id, { name: "fremd" })).toBeNull();
    expect(await repos.tenant.delete(other.scope, tenant.id)).toBe(false);
    expect(await repos.tenant.update(scope, tenant.id, { name: "Muster GmbH neu" })).toMatchObject({ name: "Muster GmbH neu" });
  });

  it("keep a supplied id, and an external reference unique per platform and environment", async () => {
    const { platform, scope } = await newTenant(db);
    const id = randomUUID();
    const tenant = await repos.tenant.create({ ...scope, id, name: "Beispiel KG", externalRef: "ws-1" });
    expect(tenant).toMatchObject({ id, externalRef: "ws-1" });
    expect(await repos.tenant.findByExternalRef(scope, "ws-1")).toMatchObject({ id });
    expect(await repos.tenant.findByExternalRef({ platformId: platform.id, environment: "live" }, "ws-1")).toBeNull();

    const duplicate = await caught(repos.tenant.create({ ...scope, name: "Doppelt", externalRef: "ws-1" }));
    expect(isDbError(duplicate, "unique")).toBe(true);
    // The same reference in the other environment, or none at all, is fine.
    await repos.tenant.create({ platformId: platform.id, environment: "live", name: "Beispiel KG live", externalRef: "ws-1" });
    await repos.tenant.create({ ...scope, name: "Ohne Referenz 1" });
    await repos.tenant.create({ ...scope, name: "Ohne Referenz 2" });
  });

  it("refuse an unknown environment", async () => {
    const { platform } = await newTenant(db);
    const err = await caught(repos.tenant.create({ platformId: platform.id, environment: "staging" as never, name: "x" }));
    expect(isDbError(err, "check")).toBe(true);
  });

  it("take their books with them when deleted, and go with their platform", async () => {
    const { tenant, scope } = await newTenant(db);
    await repos.ledger.upsertSettings(tenant.id, { enabled: true, vatPeriod: "month", vatBasis: "soll", startDate: null });
    expect(await repos.tenant.delete(scope, tenant.id)).toBe(true);
    expect(await db.select().from(ledgerSettings).where(eq(ledgerSettings.tenantId, tenant.id))).toEqual([]);

    const second = await newTenant(db);
    await db.delete(platforms).where(eq(platforms.id, second.platform.id));
    expect(await repos.tenant.find(second.scope, second.tenant.id)).toBeNull();
  });
});

describe("API keys", () => {
  it("returns the secret once and stores only its sha256", async () => {
    const { platform } = await newTenant(db);
    const { key, secret } = await repos.apiKey.create({ platformId: platform.id, environment: "live", name: "Produktion", scopes: ["read", "write"] });

    expect(secret).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
    expect(key).toMatchObject({ platformId: platform.id, environment: "live", name: "Produktion", scopes: ["read", "write"], lastUsedAt: null, revokedAt: null });
    expect(key.prefix).toBe(secret.slice(0, API_KEY_PREFIX_LENGTH));
    expect(key).not.toHaveProperty("secretHash");

    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(stored!.secretHash).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(secret);

    const test = await repos.apiKey.create({ platformId: platform.id, environment: "test", name: "Test", scopes: ["read"] });
    expect(test.secret).toMatch(/^sk_test_/);
    expect(test.secret).not.toBe(secret);
  });

  it("resolves a presented secret to its key and marks it used; an unknown secret resolves to nothing", async () => {
    const { platform } = await newTenant(db);
    const { key, secret } = await repos.apiKey.create({ platformId: platform.id, environment: "test", name: "CI", scopes: ["read"] });

    const resolved = await repos.apiKey.resolve(secret);
    expect(resolved).toMatchObject({ id: key.id, platformId: platform.id, environment: "test", scopes: ["read"] });
    expect(resolved!.lastUsedAt).toBeInstanceOf(Date);
    expect(resolved).not.toHaveProperty("secretHash");

    expect(await repos.apiKey.resolve(`${secret}x`)).toBeNull();
    expect(await repos.apiKey.resolve(`sk_test_${"A".repeat(43)}`)).toBeNull();
  });

  it("never resolves a revoked key; only the owning platform can revoke it", async () => {
    const { platform } = await newTenant(db);
    const other = await newTenant(db);
    const { key, secret } = await repos.apiKey.create({ platformId: platform.id, environment: "live", name: "Alt", scopes: ["read", "write", "filing"] });

    expect(await repos.apiKey.revoke(other.platform.id, key.id)).toBe(false);
    expect(await repos.apiKey.resolve(secret)).not.toBeNull();

    expect(await repos.apiKey.revoke(platform.id, key.id)).toBe(true);
    expect(await repos.apiKey.revoke(platform.id, key.id)).toBe(false);
    expect(await repos.apiKey.resolve(secret)).toBeNull();

    const listed = await repos.apiKey.list(platform.id);
    expect(listed.map((row) => [row.id, row.revokedAt !== null])).toEqual([[key.id, true]]);
    expect(await repos.apiKey.list(other.platform.id)).toEqual([]);
  });
});

describe("idempotency keys", () => {
  it("stores the first answer per platform, environment and key, and returns it again", async () => {
    const { platform } = await newTenant(db);
    const other = await newTenant(db);
    const scope = { platformId: platform.id, environment: "test" as const, key: `idem-${randomUUID()}` };

    expect(await repos.idempotency.get(scope)).toBeNull();
    const first = await repos.idempotency.put({ ...scope, operation: "create_entry", requestHash: "h1", statusCode: 200, response: { ok: true, data: { entryId: "e1" } } });
    expect(first).toMatchObject({ operation: "create_entry", requestHash: "h1", statusCode: 200, response: { ok: true, data: { entryId: "e1" } } });

    // A second put with the same key keeps (and returns) the first answer.
    const second = await repos.idempotency.put({ ...scope, operation: "create_entry", requestHash: "h2", statusCode: 409, response: { ok: false } });
    expect(second).toMatchObject({ requestHash: "h1", statusCode: 200, response: { ok: true, data: { entryId: "e1" } } });
    expect(await repos.idempotency.get(scope)).toMatchObject({ requestHash: "h1" });

    // The same key in the other environment or of another platform is a different key.
    expect(await repos.idempotency.get({ ...scope, environment: "live" })).toBeNull();
    expect(await repos.idempotency.get({ ...scope, platformId: other.platform.id })).toBeNull();
    await repos.idempotency.put({ ...scope, environment: "live", operation: "create_entry", requestHash: "h3", statusCode: 200, response: { ok: true } });
    expect(await repos.idempotency.get({ ...scope, environment: "live" })).toMatchObject({ requestHash: "h3", response: { ok: true } });
  });

  it("keeps one answer when two requests with the same key store at once", async () => {
    const { platform } = await newTenant(db);
    const scope = { platformId: platform.id, environment: "live" as const, key: `idem-${randomUUID()}` };
    const results = await Promise.all(["a", "b"].map((hash) => repos.idempotency.put({ ...scope, operation: "book_entries", requestHash: hash, statusCode: 200, response: { hash } })));
    expect(results[0]!.requestHash).toBe(results[1]!.requestHash);
  });
});
