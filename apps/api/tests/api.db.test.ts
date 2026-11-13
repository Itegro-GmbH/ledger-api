// End to end through HTTP against a real Postgres (decisions/0001-ledger-api.md): a platform key
// creates a tenant, books, reads balances and the VAT preview, retries a write idempotently,
// cannot reach another platform's tenant, and locks a period only with the `filing` scope.
import { randomUUID } from "node:crypto";

import { createDrizzleRepositories } from "@ledger/db";
import { describe, expect, it } from "vitest";

import { useTestDb } from "../../../packages/db/tests/support/test-database";
import { createApp } from "../src/app";
import { createDatabaseDeps } from "../src/composition";

const { db, pool } = useTestDb();
const app = createApp(createDatabaseDeps(pool));
const repos = createDrizzleRepositories(db);

async function newPlatform(scopes: ("read" | "write" | "filing")[] = ["read", "write"]) {
  const platform = await repos.platform.create({ name: `Plattform ${randomUUID()}` });
  const { secret } = await repos.apiKey.create({ platformId: platform.id, environment: "test", name: "test", scopes });
  return { platform, secret };
}

type Body = { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };

async function call(secret: string, operation: string, input: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Body }> {
  const response = await app.request(`/v1/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "idempotency-key": randomUUID(), "ledger-actor": "erika@muster.example", ...headers },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

async function newTenant(secret: string) {
  const created = await call(secret, "create_tenant", { name: "Muster GmbH", externalRef: `ref-${randomUUID()}`, vatPeriod: "quarter" });
  expect(created.body.ok, JSON.stringify(created.body)).toBe(true);
  return (created.body.data!.tenant as { id: string }).id;
}

describe("the API against the database", () => {
  it("creates a tenant with its chart, books an invoice and reports balances and VAT", async () => {
    const { secret } = await newPlatform();
    const tenantId = await newTenant(secret);
    const asTenant = { "ledger-tenant": tenantId };

    const accounts = await call(secret, "list_accounts", {}, asTenant);
    expect((accounts.body.data!.accounts as { number: string }[]).map((account) => account.number)).toContain("6810");

    // Internet costs 11,90 gross with 19 % input tax, on account (payables 3300).
    const created = await call(
      secret,
      "create_entry",
      {
        entry: { bookingDate: "2026-07-15", text: "Hosting Juli", lines: [{ accountNumber: "6810", amountCents: 1190, taxCode: "vst19" }, { accountNumber: "3300", amountCents: -1190 }] },
        book: true,
      },
      asTenant,
    );
    expect(created.body.ok, JSON.stringify(created.body)).toBe(true);

    const balances = await call(secret, "get_balances", { from: "2026-07-01", to: "2026-07-31" }, asTenant);
    const rows = (balances.body.data!.balances as { rows: { number: string; closingCents: number }[] }).rows;
    expect(rows.find((row) => row.number === "6810")?.closingCents).toBe(1000);
    expect(rows.find((row) => row.number === "1406")?.closingCents).toBe(190);

    const vat = await call(secret, "get_vat_preview", { from: "2026-07-01", to: "2026-09-30" }, asTenant);
    expect(vat.body.ok).toBe(true);
    expect((vat.body.data!.preview as { inputTaxCents: number }).inputTaxCents).toBe(190);

    const entry = await call(secret, "get_entry", { entryId: created.body.data!.entryId }, asTenant);
    expect((entry.body.data!.entry as { revisions: { changedByUserId: string | null }[] }).revisions[0]?.changedByUserId).toBe("erika@muster.example");
  });

  it("refuses an unbalanced entry with the ledger's own code", async () => {
    const { secret } = await newPlatform();
    const tenantId = await newTenant(secret);
    const result = await call(
      secret,
      "create_entry",
      { entry: { bookingDate: "2026-07-15", text: "Falsch", lines: [{ accountNumber: "6810", amountCents: 1000 }, { accountNumber: "3300", amountCents: -900 }] }, book: true },
      { "ledger-tenant": tenantId },
    );
    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe("unbalanced");
  });

  it("replays a retried write instead of booking twice", async () => {
    const { secret } = await newPlatform();
    const tenantId = await newTenant(secret);
    const headers = { "ledger-tenant": tenantId, "idempotency-key": "retry-1" };
    const input = { entry: { bookingDate: "2026-08-01", text: "Einlage", lines: [{ accountNumber: "1800", amountCents: 50000 }, { accountNumber: "2900", amountCents: -50000 }] }, book: true };
    const first = await call(secret, "create_entry", input, headers);
    const second = await call(secret, "create_entry", input, headers);
    expect(second.body).toEqual(first.body);
    const entries = await call(secret, "list_entries", { status: "booked" }, { "ledger-tenant": tenantId });
    expect(entries.body.data!.total).toBe(1);
  });

  it("never lets a platform reach another platform's tenant", async () => {
    const owner = await newPlatform();
    const other = await newPlatform();
    const tenantId = await newTenant(owner.secret);
    const result = await call(other.secret, "list_accounts", {}, { "ledger-tenant": tenantId });
    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("tenant_not_found");
    const listed = await call(other.secret, "list_tenants", {});
    expect(listed.body.data!.tenants).toEqual([]);
  });

  it("locks a period only with the filing scope, and refuses changes afterwards", async () => {
    const { secret } = await newPlatform(["read", "write", "filing"]);
    const writeOnly = await repos.apiKey.create({ platformId: (await repos.apiKey.resolve(secret))!.platformId, environment: "test", name: "write", scopes: ["read", "write"] });
    const tenantId = await newTenant(secret);
    const asTenant = { "ledger-tenant": tenantId };
    const entry = await call(
      secret,
      "create_entry",
      { entry: { bookingDate: "2026-04-10", text: "Einlage", lines: [{ accountNumber: "1800", amountCents: 1000 }, { accountNumber: "2900", amountCents: -1000 }] }, book: true },
      asTenant,
    );
    const filing = await call(secret, "create_filing", { kind: "vat_return", periodFrom: "2026-04-01", periodTo: "2026-06-30" }, asTenant);
    const filingId = (filing.body.data!.filing as { id: string }).id;

    const refused = await call(writeOnly.secret, "submit_filing", { filingId, submittedOn: "2026-07-10" }, asTenant);
    expect(refused.body.error?.code).toBe("forbidden");

    const submitted = await call(secret, "submit_filing", { filingId, submittedOn: "2026-07-10" }, asTenant);
    expect(submitted.body.ok, JSON.stringify(submitted.body)).toBe(true);

    const unbook = await call(secret, "unbook_entry", { entryId: entry.body.data!.entryId, reason: "Test" }, asTenant);
    expect(unbook.body.error?.code).toBe("locked");
  });
});
