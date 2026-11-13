// Real Postgres: the sources' use cases and their repository (decisions/0001-ledger-api.md, "What
// the service owns, and what platforms send"): counterparties upserted by id with only the given
// fields changed, money accounts with exactly one clearing owner, movements idempotent by their
// external id per account, documents replaced by id, links that never over-allocate or pay in the
// wrong direction, standing no-document rules, payment aliases, and no write ever reaching another
// tenant's row.
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { camt053, entry, IBAN } from "../../core/tests/fixtures/camt053";
import { createDrizzleRepositories, createDrizzleUnitOfWork, createSourceUseCases, type MovementInput } from "../src";
import { newTenant, useTestDb } from "./support/test-database";

const { db } = useTestDb();
const repos = createDrizzleRepositories(db);
const sources = createSourceUseCases({ repos, uow: createDrizzleUnitOfWork(db) });
const ACTOR = randomUUID();
const page = { offset: 0, limit: 50 };

const movement = (externalId: string, amountCents: number, fields: Partial<MovementInput> = {}): MovementInput => ({ externalId, bookingDate: "2026-03-15", amountCents, counterpartyName: "Muster Hosting GmbH", ...fields });

async function bankOf(tenantId: string) {
  return sources.createMoneyAccount({ tenantId, account: { type: "bank", name: "Hausbank", iban: "de02 1203 0000 0000 2020 51" } });
}

describe("source use cases", () => {
  it("upserts counterparties by id, changing only the given fields; refuses a foreign id and a taken VAT id", async () => {
    const { tenant } = await newTenant(db);
    const [created] = await sources.upsertCounterparties({
      tenantId: tenant.id,
      actor: ACTOR,
      counterparties: [{ name: "Muster Hosting GmbH", vatId: "de 123456789", iban: "DE02 1203 0000 0000 2020 51", city: "Musterstadt" }],
    });
    expect(created).toMatchObject({ created: true, row: { name: "Muster Hosting GmbH", nameNormalized: "muster hosting", vatIdNormalized: "DE123456789", ibanNormalized: "DE02120300000000202051", source: "auto", verifiedAt: null } });

    const [updated] = await sources.upsertCounterparties({ tenantId: tenant.id, actor: ACTOR, counterparties: [{ id: created!.row.id, name: "Muster Hosting AG", verified: true }] });
    expect(updated).toMatchObject({ created: false, row: { id: created!.row.id, name: "Muster Hosting AG", nameNormalized: "muster hosting", city: "Musterstadt", vatId: "de 123456789", verifiedByUserId: ACTOR } });
    expect(updated!.row.verifiedAt).toBeInstanceOf(Date);

    // A new id is kept as given.
    const ownId = randomUUID();
    const [kept] = await sources.upsertCounterparties({ tenantId: tenant.id, actor: "erika@muster.example", counterparties: [{ id: ownId, name: "Beispiel AG", verified: true }] });
    expect(kept).toMatchObject({ created: true, row: { id: ownId, verifiedByUserId: null } });

    await expect(sources.upsertCounterparties({ tenantId: tenant.id, actor: ACTOR, counterparties: [{ name: "Doppelt GmbH", vatId: "DE123456789" }] })).rejects.toMatchObject({ code: "vat_id_taken" });

    const other = await newTenant(db);
    await expect(sources.upsertCounterparties({ tenantId: other.tenant.id, actor: ACTOR, counterparties: [{ id: ownId, name: "Fremd GmbH" }] })).rejects.toMatchObject({ code: "counterparty_id_taken" });
    expect((await sources.listCounterparties(tenant.id, {}, page)).items.map((row) => row.name)).toEqual(["Beispiel AG", "Muster Hosting AG"]);
    expect((await sources.listCounterparties(tenant.id, { search: "hosting" }, page)).total).toBe(1);
    expect((await sources.listCounterparties(other.tenant.id, {}, page)).total).toBe(0);
  });

  it("gives a clearing account exactly one owner and a bank account none; one per platform and IBAN", async () => {
    const { tenant } = await newTenant(db);
    const tenantId = tenant.id;
    const bank = await bankOf(tenantId);
    expect(bank).toMatchObject({ type: "bank", iban: "DE02120300000000202051", currency: "EUR" });
    await expect(bankOf(tenantId)).rejects.toMatchObject({ code: "iban_taken" });
    await expect(sources.createMoneyAccount({ tenantId, account: { type: "bank", name: "Falsch", platform: "stripe" } })).rejects.toMatchObject({ code: "invalid_money_account_owner" });
    await expect(sources.createMoneyAccount({ tenantId, account: { type: "clearing", name: "Niemand" } })).rejects.toMatchObject({ code: "invalid_money_account_owner" });
    await sources.createMoneyAccount({ tenantId, account: { type: "clearing", name: "Stripe", platform: "stripe" } });
    await expect(sources.createMoneyAccount({ tenantId, account: { type: "clearing", name: "Stripe 2", platform: "stripe" } })).rejects.toMatchObject({ code: "clearing_owner_taken" });
    await expect(sources.createMoneyAccount({ tenantId, account: { type: "clearing", name: "Fremd", contactId: randomUUID() } })).rejects.toMatchObject({ code: "counterparty_not_found" });

    expect(await sources.updateMoneyAccount({ tenantId, accountId: bank.id, patch: { name: "Hausbank Giro" } })).toMatchObject({ name: "Hausbank Giro", iban: "DE02120300000000202051" });
    const other = await newTenant(db);
    await expect(sources.updateMoneyAccount({ tenantId: other.tenant.id, accountId: bank.id, patch: { name: "Gekapert" } })).rejects.toMatchObject({ code: "money_account_not_found" });
  });

  it("adds a movement once per external id; keeps its amount; records a statement", async () => {
    const { tenant } = await newTenant(db);
    const tenantId = tenant.id;
    const bank = await bankOf(tenantId);
    const first = await sources.upsertMovements({
      tenantId,
      accountId: bank.id,
      movements: [movement("e2e-1", -1190), movement("e2e-2", 5000, { counterpartyName: "Beispiel AG", remittanceText: "RE-1" })],
      statement: { from: "2026-03-01", to: "2026-03-31", openingBalanceCents: 10_000, closingBalanceCents: 13_810 },
    });
    expect(first).toMatchObject({ created: 2, existing: 0, conflicts: [] });
    expect(first.importBatchId).not.toBeNull();

    const again = await sources.upsertMovements({
      tenantId,
      accountId: bank.id,
      movements: [movement("e2e-1", -1190, { remittanceText: "Rechnung 4711" }), movement("e2e-2", 4999), movement("e2e-3", -10)],
    });
    expect(again).toMatchObject({ created: 1, existing: 2, conflicts: [{ id: first.movements[1]!.id, externalId: "e2e-2" }] });
    expect(again.movements.map((row) => row.id).slice(0, 2)).toEqual(first.movements.map((row) => row.id));

    const listed = await sources.listMovements(tenantId, { accountId: bank.id }, page);
    expect(listed.total).toBe(3);
    const byKey = new Map(listed.items.map((row) => [row.idempotencyKey, row]));
    expect(byKey.get("e2e-1")).toMatchObject({ amountCents: -1190, creditDebit: "debit", remittanceText: "Rechnung 4711", importBatchId: first.importBatchId, links: [] });
    expect(byKey.get("e2e-2")).toMatchObject({ amountCents: 5000, creditDebit: "credit" });
    expect((await sources.listMovements(tenantId, { search: "rechnung" }, page)).total).toBe(1);
    expect((await sources.listMovements(tenantId, { from: "2026-03-16" }, page)).total).toBe(0);

    await expect(sources.upsertMovements({ tenantId, accountId: bank.id, movements: [movement("x", 1), movement("x", 2)] })).rejects.toMatchObject({ code: "duplicate_external_id" });
    const other = await newTenant(db);
    await expect(sources.upsertMovements({ tenantId: other.tenant.id, accountId: bank.id, movements: [movement("y", 1)] })).rejects.toMatchObject({ code: "money_account_not_found" });
  });

  it("links movements to documents within their open amounts and in the right direction", async () => {
    const { tenant } = await newTenant(db);
    const tenantId = tenant.id;
    const bank = await bankOf(tenantId);
    const [supplier] = await sources.upsertCounterparties({ tenantId, actor: ACTOR, counterparties: [{ name: "Muster Hosting GmbH" }] });
    const invoiceId = randomUUID();
    const otherInvoiceId = randomUUID();
    await sources.upsertDocuments({
      tenantId,
      documents: [
        { id: invoiceId, kind: "incoming_invoice", direction: "incoming", documentDate: "2026-03-10", totalAmountCents: 1190, contactId: supplier!.row.id },
        { id: otherInvoiceId, kind: "incoming_invoice", direction: "incoming", documentDate: "2026-03-11", totalAmountCents: 2000 },
      ],
    });
    const { movements } = await sources.upsertMovements({ tenantId, accountId: bank.id, movements: [movement("pay", -1500), movement("refund", 300)] });
    const [pay, refund] = movements;

    await expect(sources.linkMovementDocuments({ tenantId, actor: ACTOR, links: [{ documentId: invoiceId, transactionId: refund!.id }] })).rejects.toMatchObject({ code: "direction_mismatch" });
    await expect(sources.linkMovementDocuments({ tenantId, actor: ACTOR, links: [{ documentId: invoiceId, transactionId: pay!.id, allocatedAmountCents: 1200 }] })).rejects.toMatchObject({
      code: "allocation_exceeds_document",
    });

    // Default allocation: as much as both have open (11,90 of 15,00); the rest pays the other one.
    const [link] = await sources.linkMovementDocuments({ tenantId, actor: ACTOR, links: [{ documentId: invoiceId, transactionId: pay!.id }] });
    expect(link).toMatchObject({ status: "confirmed", kind: "manual", matchedBy: "user", allocatedAmountCents: 1190, decidedByUserId: ACTOR });
    await expect(sources.linkMovementDocuments({ tenantId, actor: ACTOR, links: [{ documentId: otherInvoiceId, transactionId: pay!.id, allocatedAmountCents: 400 }] })).rejects.toMatchObject({
      code: "allocation_exceeds_movement",
    });
    const [rest] = await sources.linkMovementDocuments({ tenantId, actor: ACTOR, links: [{ documentId: otherInvoiceId, transactionId: pay!.id }] });
    expect(rest!.allocatedAmountCents).toBe(310);
    // Linking the same pair again replaces its allocation instead of adding to it.
    const [relinked] = await sources.linkMovementDocuments({ tenantId, actor: ACTOR, links: [{ documentId: invoiceId, transactionId: pay!.id, allocatedAmountCents: 1190 }] });
    expect(relinked!.id).toBe(link!.id);

    const documents = await sources.listDocuments(tenantId, {}, page);
    expect(documents.items.map((doc) => [doc.id, doc.paymentStatus, doc.links])).toEqual([
      [otherInvoiceId, "partially_paid", [{ transactionId: pay!.id, allocatedAmountCents: 310 }]],
      [invoiceId, "paid", [{ transactionId: pay!.id, allocatedAmountCents: 1190 }]],
    ]);
    expect((await sources.listMovements(tenantId, { unlinked: true }, page)).items.map((row) => row.id)).toEqual([refund!.id]);

    await sources.unlinkMovementDocument({ tenantId, documentId: otherInvoiceId, transactionId: pay!.id });
    await expect(sources.unlinkMovementDocument({ tenantId, documentId: otherInvoiceId, transactionId: pay!.id })).rejects.toMatchObject({ code: "link_not_found" });
    expect((await sources.listDocuments(tenantId, { contactId: supplier!.row.id }, page)).items.map((doc) => doc.id)).toEqual([invoiceId]);

    const other = await newTenant(db);
    await expect(sources.linkMovementDocuments({ tenantId: other.tenant.id, actor: ACTOR, links: [{ documentId: invoiceId, transactionId: pay!.id }] })).rejects.toMatchObject({ code: "document_not_found" });
    await expect(sources.unlinkMovementDocument({ tenantId: other.tenant.id, documentId: invoiceId, transactionId: pay!.id })).rejects.toMatchObject({ code: "link_not_found" });
  });

  it("replaces a document by id, refuses another tenant's id and an unknown counterparty", async () => {
    const { tenant } = await newTenant(db);
    const id = randomUUID();
    const [created] = await sources.upsertDocuments({ tenantId: tenant.id, documents: [{ id, kind: "receipt", title: "Quittung", totalAmountCents: 500, externalRef: "beleg-1" }] });
    expect(created).toMatchObject({ created: true, row: { id, kind: "receipt", title: "Quittung", totalAmountCents: 500 } });
    const [replaced] = await sources.upsertDocuments({ tenantId: tenant.id, documents: [{ id, kind: "incoming_invoice", invoiceNumber: "4711" }] });
    expect(replaced).toMatchObject({ created: false, row: { id, kind: "incoming_invoice", title: null, totalAmountCents: null, invoiceNumber: "4711", externalRef: null } });

    await expect(sources.upsertDocuments({ tenantId: tenant.id, documents: [{ id: randomUUID(), kind: "receipt", contactId: randomUUID() }] })).rejects.toMatchObject({ code: "counterparty_not_found" });
    await expect(sources.upsertDocuments({ tenantId: tenant.id, documents: [{ id, kind: "receipt" }, { id, kind: "receipt" }] })).rejects.toMatchObject({ code: "duplicate_document_id" });
    const other = await newTenant(db);
    await expect(sources.upsertDocuments({ tenantId: other.tenant.id, documents: [{ id, kind: "receipt" }] })).rejects.toMatchObject({ code: "document_id_taken" });
    // All or nothing: the refused batch wrote nothing.
    expect((await sources.listDocuments(tenant.id, {}, page)).total).toBe(1);
  });

  it("marks movements as needing no document, with a standing rule for the counterparty", async () => {
    const { tenant } = await newTenant(db);
    const tenantId = tenant.id;
    const bank = await bankOf(tenantId);
    const { movements } = await sources.upsertMovements({
      tenantId,
      accountId: bank.id,
      movements: [movement("fee-1", -500, { counterpartyName: "Hausbank" }), movement("fee-2", -450, { counterpartyName: "HAUSBANK" }), movement("other", -100)],
    });
    const result = await sources.setNoDocumentNeeded({ tenantId, actor: ACTOR, transactionIds: [movements[0]!.id], noDocumentNeeded: true, forCounterparty: true });
    expect(result).toEqual({ updated: 1, rule: "hausbank", alsoMarked: [movements[1]!.id] });
    expect(await repos.sources.findTransactions(tenantId, [movements[1]!.id])).toMatchObject([{ noDocumentNeeded: true }]);
    expect((await sources.listMovements(tenantId, { unlinked: true }, page)).items.map((row) => row.idempotencyKey)).toEqual(["other"]);

    expect(await sources.setNoDocumentNeeded({ tenantId, actor: ACTOR, transactionIds: [movements[0]!.id], noDocumentNeeded: false })).toEqual({ updated: 1, rule: null, alsoMarked: [] });
    await expect(sources.setNoDocumentNeeded({ tenantId, actor: ACTOR, transactionIds: [randomUUID()], noDocumentNeeded: true })).rejects.toMatchObject({ code: "movement_not_found" });
  });

  it("learns payment aliases by the merchant key; the latest wins", async () => {
    const { tenant } = await newTenant(db);
    const tenantId = tenant.id;
    const written = await sources.upsertCounterparties({ tenantId, actor: ACTOR, counterparties: [{ name: "Muster Shop GmbH" }, { name: "Beispiel Shop GmbH" }] });
    const [shop, other] = written.map((item) => item.row.id);
    expect(await sources.upsertPaymentAliases({ tenantId, actor: ACTOR, aliases: [{ counterpartyName: "MUSTERSHOP *AB12CD34,mustershop.example", contactId: shop! }] })).toEqual([
      { counterpartyNameNormalized: "mustershop", contactId: shop },
    ]);
    await sources.upsertPaymentAliases({ tenantId, actor: ACTOR, aliases: [{ counterpartyName: "Mustershop", contactId: other! }] });
    await expect(sources.upsertPaymentAliases({ tenantId, actor: ACTOR, aliases: [{ counterpartyName: "X", contactId: randomUUID() }] })).rejects.toMatchObject({ code: "counterparty_not_found" });
  });

  it("imports a camt.053 statement onto the account with its IBAN, once; refuses a foreign or unknown account", async () => {
    const { tenant } = await newTenant(db);
    const tenantId = tenant.id;
    const bank = await bankOf(tenantId);
    const xml = camt053("08", [
      entry({ amount: "11.90", indicator: "DBIT", date: "2026-07-20", name: "Muster Hosting GmbH", iban: "DE89370400440532013000", e2e: "MH-2026-0007", text: "Rechnung MH-2026-0007", v8: true }),
    ]);
    const sourceDocumentId = randomUUID();
    const first = await sources.importBankStatement({ tenantId, xml, sourceDocumentId });
    expect(first).toMatchObject({ version: "08", statements: [{ accountId: bank.id, statementId: "STMT-2026-07", reconciles: true, created: 1, existing: 0 }] });
    const again = await sources.importBankStatement({ tenantId, xml, accountId: bank.id, sourceDocumentId });
    expect(again.statements[0]).toMatchObject({ created: 0, existing: 1, importBatchId: first.statements[0]!.importBatchId });

    const [movement] = (await sources.listMovements(tenantId, {}, page)).items;
    expect(movement).toMatchObject({ amountCents: -1190, counterpartyName: "Muster Hosting GmbH", counterpartyIban: "DE89370400440532013000", remittanceText: "Rechnung MH-2026-0007", bankTxCode: "PMNT/RCDT/ESCT" });
    expect(await repos.sources.findMoneyAccountByIban(tenantId, IBAN)).toMatchObject({ id: bank.id });

    const other = await newTenant(db);
    await expect(sources.importBankStatement({ tenantId: other.tenant.id, xml })).rejects.toMatchObject({ code: "money_account_not_found" });
    const otherBank = await sources.createMoneyAccount({ tenantId: other.tenant.id, account: { type: "bank", name: "Zweitbank", iban: "DE89370400440532013000" } });
    await expect(sources.importBankStatement({ tenantId: other.tenant.id, xml, accountId: otherBank.id })).rejects.toMatchObject({ code: "statement_account_mismatch" });
    await expect(sources.importBankStatement({ tenantId, xml: "<Document/>" })).rejects.toMatchObject({ code: "statement_invalid" });
    await expect(sources.importBankStatement({ tenantId, xml: "kein xml" })).rejects.toMatchObject({ code: "statement_invalid" });
  });
});
