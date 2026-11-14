// End to end through HTTP against a real Postgres (decisions/0001-ledger-api.md, "What the service
// owns, and what platforms send"): a platform pushes a bank account, a supplier, the supplier's
// invoice and the bank movement paying it, links the two, and the proposal engine reads them
// through the drizzle source reader: one proposal books the invoice, one the payment, and booked
// they leave the bank and the payables where they belong. Pushing the movement again adds nothing.
import { randomUUID } from "node:crypto";

import { createDrizzleRepositories } from "@ledger/db";
import { describe, expect, it } from "vitest";

import { camt053, entry } from "../../../packages/core/tests/fixtures/camt053";
import { useTestDb } from "../../../packages/db/tests/support/test-database";
import { createApp } from "../src/app";
import { createDatabaseDeps } from "../src/composition";

const { db, pool } = useTestDb();
const app = createApp(createDatabaseDeps(pool));
const repos = createDrizzleRepositories(db);

type Body = { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };
type Line = { accountNumber: string; amountCents: number; taxCode: string | null; documentId: string | null };
type Entry = { id: string; sourceKey: string | null; status: string; lines: Line[] };

async function platformKey() {
  const platform = await repos.platform.create({ name: `Plattform ${randomUUID()}` });
  const { secret } = await repos.apiKey.create({ platformId: platform.id, environment: "test", name: "test", scopes: ["read", "write"] });
  return secret;
}

function caller(secret: string, tenantId?: string) {
  return async (operation: string, input: unknown): Promise<{ status: number; body: Body }> => {
    const response = await app.request(`/v1/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        "idempotency-key": randomUUID(),
        "ledger-actor": "erika@muster.example",
        ...(tenantId ? { "ledger-tenant": tenantId } : {}),
      },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as Body };
  };
}

async function ok(call: Promise<{ status: number; body: Body }>): Promise<Record<string, unknown>> {
  const { body } = await call;
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return body.data!;
}

describe("sources through the API", () => {
  it("books a supplier invoice and its bank payment from pushed sources; a movement pushed twice stays one", async () => {
    const secret = await platformKey();
    const tenant = (await ok(caller(secret)("create_tenant", { name: "Muster GmbH", externalRef: `ref-${randomUUID()}`, vatPeriod: "quarter" }))).tenant as { id: string };
    const call = caller(secret, tenant.id);

    const bank = (await ok(call("create_money_account", { type: "bank", name: "Hausbank", iban: "DE02 1203 0000 0000 2020 51" }))).account as { id: string; iban: string };
    expect(bank.iban).toBe("DE02120300000000202051");
    const [supplier] = (await ok(call("upsert_counterparties", { counterparties: [{ name: "Muster Hosting GmbH", vatId: "DE123456789", city: "Musterstadt" }] }))).counterparties as {
      id: string;
      created: boolean;
    }[];
    expect(supplier!.created).toBe(true);

    // The supplier's invoice: 11,90 gross with 19 % (10,00 net, 1,90 VAT).
    const invoiceId = randomUUID();
    await ok(
      call("upsert_documents", {
        documents: [
          {
            id: invoiceId,
            kind: "incoming_invoice",
            direction: "incoming",
            title: "Hosting Juli",
            sender: "Muster Hosting GmbH",
            invoiceNumber: "MH-2026-0007",
            documentDate: "2026-07-10",
            dueDate: "2026-07-24",
            currency: "EUR",
            totalAmountCents: 1190,
            netTotalCents: 1000,
            taxTotalCents: 190,
            taxBreakdown: [{ ratePercent: 19, netCents: 1000, taxCents: 190 }],
            reverseCharge: false,
            counterpartyId: supplier!.id,
            fileUrl: "https://plattform.example/belege/mh-2026-0007.pdf",
          },
        ],
      }),
    );

    const payment = { externalId: "E2E-MH-2026-0007", bookingDate: "2026-07-20", amountCents: -1190, counterpartyName: "Muster Hosting GmbH", remittanceText: "MH-2026-0007" };
    const pushed = await ok(call("upsert_money_movements", { accountId: bank.id, movements: [payment] }));
    expect(pushed).toMatchObject({ created: 1, existing: 0 });
    const movementId = (pushed.movements as { id: string }[])[0]!.id;
    const again = await ok(call("upsert_money_movements", { accountId: bank.id, movements: [payment] }));
    expect(again).toMatchObject({ created: 0, existing: 1, conflicts: [], movements: [{ id: movementId, externalId: "E2E-MH-2026-0007", created: false }] });
    expect((await ok(call("list_money_movements", { accountId: bank.id }))).total).toBe(1);

    await ok(call("link_movement_documents", { links: [{ movementId, documentId: invoiceId }] }));
    const documents = (await ok(call("list_documents", {}))).items as { id: string; paymentStatus: string; counterpartyId: string }[];
    expect(documents).toMatchObject([{ id: invoiceId, paymentStatus: "paid", counterpartyId: supplier!.id }]);

    const sync = await ok(call("sync_proposals", {}));
    expect(sync).toMatchObject({ created: 2, failed: 0 });
    const proposals = (await ok(call("list_entries", { status: "proposed" }))).items as Entry[];
    const bySource = new Map(proposals.map((entry) => [entry.sourceKey, entry]));
    expect([...bySource.keys()].sort()).toEqual([`doc:${invoiceId}`, `tx:${movementId}`].sort());

    const invoiceEntry = bySource.get(`doc:${invoiceId}`)!;
    const expense = invoiceEntry.lines.find((line) => line.taxCode === "vst19" && line.amountCents === 1000);
    expect(expense, JSON.stringify(invoiceEntry.lines)).toBeDefined();
    expect(invoiceEntry.lines.map((line) => [line.accountNumber, line.amountCents, line.taxCode, line.documentId])).toEqual([
      [expense!.accountNumber, 1000, "vst19", null],
      ["1406", 190, "vst19", null],
      ["3300", -1190, null, invoiceId],
    ]);
    expect(bySource.get(`tx:${movementId}`)!.lines.map((line) => [line.accountNumber, line.amountCents, line.documentId])).toEqual([
      ["1800", -1190, null],
      ["3300", 1190, invoiceId],
    ]);

    const booked = await ok(call("book_entries", { entryIds: proposals.map((entry) => entry.id) }));
    expect(booked).toMatchObject({ failed: [] });
    expect((booked.booked as string[]).length).toBe(2);

    const balances = (await ok(call("get_balances", { from: "2026-07-01", to: "2026-07-31" }))).balances as { rows: { number: string; closingCents: number }[] };
    const closing = (number: string) => balances.rows.find((row) => row.number === number)?.closingCents ?? 0;
    expect(closing("1800")).toBe(-1190);
    expect(closing("3300")).toBe(0);
    expect(closing("1406")).toBe(190);
    expect(closing(expense!.accountNumber)).toBe(1000);

    // Nothing left to propose; the bank account is the tenant's 1800.
    expect(await ok(call("sync_proposals", {}))).toMatchObject({ created: 0 });
    const accounts = (await ok(call("list_accounts", {}))).accounts as { number: string; ownerBankAccountId: string | null }[];
    expect(accounts.find((account) => account.number === "1800")?.ownerBankAccountId).toBe(bank.id);
  });

  it("upserts a platform report's settlement lines idempotently, only on a clearing account", async () => {
    const secret = await platformKey();
    const tenant = (await ok(caller(secret)("create_tenant", { name: "Muster GmbH", externalRef: `ref-${randomUUID()}` }))).tenant as { id: string };
    const call = caller(secret, tenant.id);
    const clearing = (await ok(call("create_money_account", { type: "clearing", name: "App Store", platform: "apple" }))).account as { id: string };
    const bank = (await ok(call("create_money_account", { type: "bank", name: "Hausbank" }))).account as { id: string };
    const report = randomUUID();
    const line = { clearingAccountId: clearing.id, sourceDocumentId: report, externalLineId: "row-1", type: "revenue", grossCents: 199, feeCents: -30, netCents: 169, currency: "EUR", bookingDate: "2026-07-31" };

    const first = (await ok(call("upsert_settlement_lines", { lines: [line] }))).lines as { id: string }[];
    const second = (await ok(call("upsert_settlement_lines", { lines: [{ ...line, type: "fee", grossCents: null, netCents: -30 }] }))).lines as { id: string }[];
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));

    const onBank = await call("upsert_settlement_lines", { lines: [{ ...line, clearingAccountId: bank.id, externalLineId: "row-2" }] });
    expect(onBank.body.error?.code).toBe("invalid_money_account_owner");
  });

  it("keeps a caller's own ids for new money accounts and movements, and refuses one already in use", async () => {
    const secret = await platformKey();
    const tenantOf = async () => ((await ok(caller(secret)("create_tenant", { name: "Muster GmbH", externalRef: `ref-${randomUUID()}` }))).tenant as { id: string }).id;
    const [call, other] = [caller(secret, await tenantOf()), caller(secret, await tenantOf())];
    const accountId = randomUUID();
    const movementId = randomUUID();

    const bank = (await ok(call("create_money_account", { id: accountId, type: "bank", name: "Hausbank" }))).account as { id: string };
    expect(bank.id).toBe(accountId);
    const movement = { id: movementId, externalId: "tx-1", bookingDate: "2026-07-01", amountCents: 2500 };
    const first = await ok(call("upsert_money_movements", { accountId, movements: [movement] }));
    expect((first.movements as { id: string }[]).map((row) => row.id)).toEqual([movementId]);
    // Pushed again under another id: still the stored movement with its first id.
    const again = await ok(call("upsert_money_movements", { accountId, movements: [{ ...movement, id: randomUUID() }] }));
    expect((again.movements as { id: string }[]).map((row) => row.id)).toEqual([movementId]);

    const otherBank = (await ok(other("create_money_account", { type: "bank", name: "Hausbank" }))).account as { id: string };
    expect((await other("create_money_account", { id: accountId, type: "bank", name: "Zweitbank" })).body.error?.code).toBe("money_account_id_taken");
    expect((await other("upsert_money_movements", { accountId: otherBank.id, movements: [{ ...movement, externalId: "tx-2" }] })).body.error?.code).toBe("movement_id_taken");
  });

  it("never lets a tenant reach another tenant's sources", async () => {
    const secret = await platformKey();
    const tenantOf = async () => ((await ok(caller(secret)("create_tenant", { name: "Muster GmbH", externalRef: `ref-${randomUUID()}` }))).tenant as { id: string }).id;
    const [owner, other] = [caller(secret, await tenantOf()), caller(secret, await tenantOf())];
    const bank = (await ok(owner("create_money_account", { type: "bank", name: "Hausbank" }))).account as { id: string };

    const refused = await other("upsert_money_movements", { accountId: bank.id, movements: [{ externalId: "x", bookingDate: "2026-07-01", amountCents: 100 }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe("money_account_not_found");
    expect((await ok(other("list_money_accounts", {}))).accounts).toEqual([]);
    const invalid = await owner("upsert_money_movements", { accountId: bank.id, movements: [{ externalId: "x", bookingDate: "2026-07-01", amountCents: 0 }] });
    expect(invalid.body.error?.code).toBe("invalid_input");
  });

  it("imports a camt.053 statement onto the bank account with its IBAN, once", async () => {
    const secret = await platformKey();
    const tenant = (await ok(caller(secret)("create_tenant", { name: "Muster GmbH", externalRef: `ref-${randomUUID()}` }))).tenant as { id: string };
    const call = caller(secret, tenant.id);
    const bank = (await ok(call("create_money_account", { type: "bank", name: "Hausbank", iban: "DE02120300000000202051" }))).account as { id: string };
    const xml = camt053("02", [entry({ amount: "11.90", indicator: "DBIT", date: "2026-07-20", name: "Muster Hosting GmbH", iban: "DE89370400440532013000", e2e: "MH-2026-0007" })]);

    expect(await ok(call("import_bank_statement", { xml }))).toMatchObject({ version: "02", statements: [{ accountId: bank.id, reconciles: true, created: 1, existing: 0 }] });
    expect(await ok(call("import_bank_statement", { xml }))).toMatchObject({ statements: [{ created: 0, existing: 1 }] });
    expect((await ok(call("list_money_movements", {}))).total).toBe(1);
    const invalid = await call("import_bank_statement", { xml: "<!DOCTYPE x><Document/>" });
    expect(invalid.body.error?.code).toBe("statement_invalid");
  });
});
