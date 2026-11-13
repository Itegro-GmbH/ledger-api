// Real Postgres: `createDrizzleSourceReader` answers exactly what the in-memory reader the ledger's
// tests use answers (`support/memory-source-reader.ts`, itself a copy of Digipost's reads), for
// one scenario written into both with the same ids; never another tenant's row; and the payment
// status a document's confirmed links give.
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { drizzleFixture, memoryFixture, type SourceFixture } from "./support/source-fixtures";
import { newTenant, useTestDb } from "./support/test-database";

const { db } = useTestDb();

/** One scenario: a bank account with an opening balance, a platform and a supplier clearing
 * account, a payout pair with its report, invoices linked to payments, aliases and rules. */
async function scenario(fixture: SourceFixture, tenantId: string, ids: Record<string, string>) {
  const supplier = await fixture.contact(tenantId, { id: ids.supplier, name: "Muster Hosting GmbH", vatId: "DE123456789" });
  await fixture.contact(tenantId, { id: ids.customer, name: "Beispiel AG", country: "AT" });
  const bank = await fixture.account(tenantId, { id: ids.bank, type: "bank", name: "Hausbank", iban: "DE02120300000000202051" });
  const stripe = await fixture.account(tenantId, { id: ids.stripe, type: "clearing", name: "Stripe", platform: "stripe" });
  await fixture.account(tenantId, { id: ids.supplierClearing, type: "clearing", name: "Muster Hosting", contactId: supplier.id });
  await fixture.openingBalance(tenantId, bank.id, "2026-01-01", 12_345);

  const invoice = await fixture.document(tenantId, {
    id: ids.invoice,
    title: "Rechnung 4711",
    kind: "incoming_invoice",
    direction: "incoming",
    documentDate: "2026-03-10",
    invoiceNumber: "4711",
    totalAmountCents: 1190,
    netTotalCents: 1000,
    taxTotalCents: 190,
    taxBreakdown: [{ ratePercent: 19, netCents: 1000, taxCents: 190 }],
    serviceDate: "2026-03-01",
    contactId: supplier.id,
  });
  const report = await fixture.document(tenantId, { id: ids.report, title: "Stripe März", kind: "payout_report", direction: "unknown", platform: "stripe", documentDate: "2026-03-31" });
  const letter = await fixture.document(tenantId, { id: ids.letter, title: "Brief", kind: "letter", direction: null, documentDate: "2026-02-01" });
  void letter;

  const payment = await fixture.transaction(tenantId, { id: ids.payment, accountId: bank.id, bookingDate: "2026-03-15", amountCents: -1190, counterpartyName: "Muster Hosting GmbH" });
  await fixture.confirm(tenantId, invoice.id, payment.id, 1190);
  const group = randomUUID();
  const clearingPayout = await fixture.transaction(tenantId, { id: ids.clearingPayout, accountId: stripe.id, bookingDate: "2026-04-02", amountCents: -4000, counterpartyName: "Stripe", transferGroupId: group });
  await fixture.transaction(tenantId, { id: ids.deposit, accountId: bank.id, bookingDate: "2026-04-02", amountCents: 4000, counterpartyName: "Stripe Payments Europe", transferGroupId: group });
  await fixture.transaction(tenantId, { id: ids.fee, accountId: bank.id, bookingDate: "2026-04-30", amountCents: -500, counterpartyName: "Hausbank", noDocumentNeeded: true });
  await fixture.settlementLine(tenantId, { id: ids.line1, clearingAccountId: stripe.id, sourceDocumentId: report.id, type: "revenue", grossCents: 4200, feeCents: 200, netCents: 4000, bookingDate: "2026-03-20" });
  await fixture.settlementLine(tenantId, { id: ids.line2, clearingAccountId: stripe.id, sourceDocumentId: report.id, transactionId: clearingPayout.id, type: "payout", grossCents: null, feeCents: null, netCents: 4000, bookingDate: "2026-03-31" });
  await fixture.paymentAlias(tenantId, "muster hosting", supplier.id);
  await fixture.noDocumentRule(tenantId, "hausbank");
}

const KEYS = ["supplier", "customer", "bank", "stripe", "supplierClearing", "invoice", "report", "letter", "payment", "clearingPayout", "deposit", "fee", "line1", "line2"];

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

describe("createDrizzleSourceReader", () => {
  it("answers every read like the in-memory reader for the same sources", async () => {
    const ids = Object.fromEntries(KEYS.map((key) => [key, randomUUID()]));
    const { tenant } = await newTenant(db);
    const memory = memoryFixture();
    const drizzle = drizzleFixture(db);
    await scenario(memory, tenant.id, ids);
    await scenario(drizzle, tenant.id, ids);
    const [m, d] = [memory.reader, drizzle.reader];
    const t = tenant.id;

    const withoutPaymentStatus = (rows: Awaited<ReturnType<typeof m.listDocumentsForLedger>>) => rows.map(({ paymentStatus: _status, ...row }) => row);
    expect(withoutPaymentStatus(await d.listDocumentsForLedger(t))).toEqual(withoutPaymentStatus(await m.listDocumentsForLedger(t)));
    expect(await d.documentExists(t, ids.invoice!)).toBe(true);
    expect(await d.documentExists(t, randomUUID())).toBe(false);
    expect(await d.listDocumentContacts(t, ids.invoice!)).toEqual(await m.listDocumentContacts(t, ids.invoice!));
    expect(await d.listDocumentContacts(t, ids.letter!)).toEqual([]);
    const period = { from: "2026-01-01", to: "2026-12-31" };
    expect(await d.listBookableDocumentIds(t, period)).toEqual(await m.listBookableDocumentIds(t, period));
    expect(await d.listBookableDocumentIds(t, period)).toEqual([ids.invoice, ids.report]);

    expect(byId(await d.listMoneyAccounts(t))).toEqual(byId(await m.listMoneyAccounts(t)));
    expect(await d.listSourceAccounts(t)).toEqual(await m.listSourceAccounts(t));
    expect(await d.listTransactionsForLedger(t)).toEqual(await m.listTransactionsForLedger(t));
    const deposit = (await d.listTransactionsForLedger(t)).find((tx) => tx.id === ids.deposit);
    expect(deposit?.pairedClearing).toEqual({ accountId: ids.stripe, platform: "stripe", contactId: null, reportDocumentIds: [ids.report] });
    expect(await d.findTransactionById(t, ids.payment!)).toEqual(await m.findTransactionById(t, ids.payment!));
    expect(await d.findTransactionById(t, ids.clearingPayout!)).toEqual(await m.findTransactionById(t, ids.clearingPayout!));
    expect(await d.transactionExists(t, ids.fee!)).toBe(true);
    expect(await d.listBankMovements(t, "2026-04-02")).toEqual(await m.listBankMovements(t, "2026-04-02"));
    expect(await d.listBankOpeningBalances(t)).toEqual(await m.listBankOpeningBalances(t));
    expect(await d.listBankTransactionIds(t, { from: "2026-04-01", to: "2026-04-30" })).toEqual(await m.listBankTransactionIds(t, { from: "2026-04-01", to: "2026-04-30" }));
    expect(byId(await d.listSettlementLinesForLedger(t))).toEqual(byId(await m.listSettlementLinesForLedger(t)));

    expect(byId(await d.listContacts(t))).toEqual(byId(await m.listContacts(t)));
    expect(await d.findContactById(t, ids.supplier!)).toEqual(await m.findContactById(t, ids.supplier!));
    expect(await d.listPaymentAliases(t)).toEqual(await m.listPaymentAliases(t));
    expect(await d.listNoDocumentRules(t)).toEqual(await m.listNoDocumentRules(t));
    expect(await d.listInvoices(t, 10)).toEqual([]);
  });

  it("derives the payment status from the confirmed links", async () => {
    const { tenant } = await newTenant(db);
    const fixture = drizzleFixture(db);
    const bank = await fixture.account(tenant.id, { type: "bank", name: "Hausbank" });
    const paid = await fixture.document(tenant.id, { title: "Bezahlt", totalAmountCents: 1190 });
    const partly = await fixture.document(tenant.id, { title: "Teilweise", totalAmountCents: 1190 });
    const overdue = await fixture.document(tenant.id, { title: "Überfällig", totalAmountCents: 500, dueDate: "2020-01-31" });
    const none = await fixture.document(tenant.id, { title: "Ohne Betrag", kind: "receipt" });
    const tx = await fixture.transaction(tenant.id, { accountId: bank.id, bookingDate: "2026-03-01", amountCents: -1690 });
    await fixture.confirm(tenant.id, paid.id, tx.id, 1190);
    await fixture.confirm(tenant.id, partly.id, tx.id, 500);

    const statuses = new Map((await fixture.reader.listDocumentsForLedger(tenant.id)).map((doc) => [doc.id, doc.paymentStatus]));
    expect(statuses.get(paid.id)).toBe("paid");
    expect(statuses.get(partly.id)).toBe("partially_paid");
    expect(statuses.get(none.id)).toBe("not_applicable");
    expect(statuses.get(overdue.id)).toBe("overdue");
  });

  it("never returns another tenant's sources", async () => {
    const owner = await newTenant(db);
    const other = await newTenant(db);
    const ids = Object.fromEntries(KEYS.map((key) => [key, randomUUID()]));
    const fixture = drizzleFixture(db);
    await scenario(fixture, owner.tenant.id, ids);
    const reader = fixture.reader;
    const t = other.tenant.id;

    expect(await reader.listDocumentsForLedger(t)).toEqual([]);
    expect(await reader.documentExists(t, ids.invoice!)).toBe(false);
    expect(await reader.listDocumentContacts(t, ids.invoice!)).toEqual([]);
    expect(await reader.listBookableDocumentIds(t, { from: "2026-01-01", to: "2026-12-31" })).toEqual([]);
    expect(await reader.listMoneyAccounts(t)).toEqual([]);
    expect(await reader.listSourceAccounts(t)).toEqual([]);
    expect(await reader.listTransactionsForLedger(t)).toEqual([]);
    expect(await reader.findTransactionById(t, ids.payment!)).toBeNull();
    expect(await reader.transactionExists(t, ids.payment!)).toBe(false);
    expect(await reader.listBankMovements(t, "2026-12-31")).toEqual([]);
    expect(await reader.listBankOpeningBalances(t)).toEqual(new Map());
    expect(await reader.listBankTransactionIds(t, { from: "2026-01-01", to: "2026-12-31" })).toEqual([]);
    expect(await reader.listSettlementLinesForLedger(t)).toEqual([]);
    expect(await reader.listContacts(t)).toEqual([]);
    expect(await reader.findContactById(t, ids.supplier!)).toBeNull();
    expect(await reader.listPaymentAliases(t)).toEqual([]);
    expect(await reader.listNoDocumentRules(t)).toEqual([]);
  });
});
