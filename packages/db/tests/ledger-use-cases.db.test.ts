// Real Postgres, the ledger use cases end to end (Digipost
// decisions/0080-ledger-double-entry-bookkeeping.md) on the cases of the original brief, with
// invented data and the sources in memory (`support/memory-source-reader.ts`): enabling seeds the chart and the owned accounts, manual
// entries with revisions, booking rules for reasons and balance, the filing lock and the
// correction path, proposals keyed by source, open-item matches, controls against the real bank
// account, the period overview, handovers and the tax advisor's balance list.
import { randomUUID } from "node:crypto";

import { MAX_ADVISOR_FILE_BYTES, type EntryInput } from "@ledger/core";
import { describe, expect, it } from "vitest";

import { createDrizzleRepositories, createDrizzleUnitOfWork, createLedgerUseCases, UseCaseError } from "../src";
import { createMemorySourceReader } from "./support/memory-source-reader";
import { newTenant, useTestDb } from "./support/test-database";

const { db } = useTestDb();
const { reader: sources, add } = createMemorySourceReader();
const ledger = createLedgerUseCases({ repos: createDrizzleRepositories(db), uow: createDrizzleUnitOfWork(db), sources });
const USER = randomUUID();

const SETTINGS = { enabled: true, vatPeriod: "month" as const, vatBasis: "soll" as const, startDate: "2026-06-01" };

async function enabledTenant() {
  const { tenant } = await newTenant(db);
  const bank = add.account(tenant.id, { type: "bank", name: "Hausbank", iban: `DE${randomUUID().slice(0, 8)}` });
  await ledger.setSettings({ tenantId: tenant.id, settings: SETTINGS });
  return { tenantId: tenant.id, bankAccountId: bank.id };
}

async function code(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (err: unknown) => {
      if (err instanceof UseCaseError) return err.code;
      throw err;
    },
  );
}

async function bankTransaction(tenantId: string, accountId: string, bookingDate: string, amountCents: number, counterpartyName = "Gegenüber") {
  return add.transaction(tenantId, accountId, bookingDate, amountCents, counterpartyName);
}

async function invoiceDocument(tenantId: string, documentDate: string, title = "Rechnung") {
  return add.document(tenantId, { title, documentDate });
}

const ionos = (overrides: Partial<EntryInput> = {}): EntryInput => ({
  bookingDate: "2026-07-01",
  text: "IONOS Rechnung Juli",
  lines: [
    { accountNumber: "6810", amountCents: 150, taxCode: "vst19" },
    { accountNumber: "1800", amountCents: -150 },
  ],
  ...overrides,
});

describe("ledger settings and the chart", () => {
  it("is disabled until an admin enables it; every other use case refuses", async () => {
    const { tenant } = await newTenant(db, { name: `Aus GmbH ${randomUUID()}` });
    expect(await ledger.getSettings(tenant.id)).toMatchObject({ enabled: false, vatPeriod: "month", vatBasis: "soll" });
    expect(await ledger.isEnabled(tenant.id)).toBe(false);
    expect(await code(ledger.listAccounts(tenant.id))).toBe("disabled");
    expect(await code(ledger.createEntry({ tenantId: tenant.id, userId: USER, entry: ionos(), book: true }))).toBe("disabled");
    expect(await code(ledger.getBalances(tenant.id, { from: "2026-01-01", to: "2026-12-31" }))).toBe("disabled");
  });

  it("enabling seeds SKR 04 and one account per bank, platform and contact clearing account, idempotently", async () => {
    const { tenant } = await newTenant(db);
    const meta = add.contact(tenant.id, "Meta Platforms Ireland");
    const main = add.account(tenant.id, { type: "bank", name: "Hausbank", iban: "DE001" });
    const second = add.account(tenant.id, { type: "bank", name: "Hausbank Rücklage", iban: "DE002" });
    add.account(tenant.id, { type: "clearing", name: "Apple", platform: "apple" });
    add.account(tenant.id, { type: "clearing", name: "Google Play", platform: "google" });
    add.account(tenant.id, { type: "clearing", name: "Meta", contactId: meta.id });

    await ledger.setSettings({ tenantId: tenant.id, settings: SETTINGS });
    const first = await ledger.listAccounts(tenant.id);
    const byNumber = new Map(first.map((account) => [account.number, account]));
    expect(byNumber.get("1800")).toMatchObject({ name: "Bank Hausbank", ownerType: "bank_account", ownerBankAccountId: main.id });
    expect(byNumber.get("1810")).toMatchObject({ name: "Bank Hausbank Rücklage", ownerBankAccountId: second.id, group: "bank" });
    expect(byNumber.get("1370")).toMatchObject({ name: "Forderung Apple", ownerPlatform: "apple", openItems: true });
    expect(byNumber.get("1371")).toMatchObject({ name: "Forderung Google Play", ownerPlatform: "google" });
    expect(byNumber.get("1461")).toMatchObject({ name: "Verrechnungskonto Meta Platforms Ireland", ownerType: "contact", ownerContactId: meta.id, kind: "asset" });
    expect(byNumber.get("6810")?.name).toBe("Internetkosten");

    await ledger.setSettings({ tenantId: tenant.id, settings: { ...SETTINGS, vatPeriod: "quarter" } });
    await ledger.syncChart(tenant.id);
    expect(await ledger.listAccounts(tenant.id)).toHaveLength(first.length);
    expect((await ledger.getSettings(tenant.id)).vatPeriod).toBe("quarter");
  });

  it("creates, renames and archives accounts; an archived account takes no new lines", async () => {
    const { tenantId } = await enabledTenant();
    const erika = await ledger.createAccount({
      tenantId,
      account: { number: "3511", name: "Auslagen Erika", kind: "liability", group: "open_items", openItems: true, ownerType: "person", ownerPersonName: "Erika" },
    });
    expect(erika).toMatchObject({ number: "3511", ownerType: "person", ownerPersonName: "Erika", archived: false });
    expect(await code(ledger.createAccount({ tenantId, account: { number: "3511", name: "Doppelt", kind: "liability", group: "other", openItems: false, ownerType: null } }))).toBe("account_number_taken");
    expect(await code(ledger.createAccount({ tenantId, account: { number: "1462", name: "Fremd", kind: "asset", group: "open_items", openItems: true, ownerType: "contact", ownerContactId: randomUUID() } }))).toBe("owner_not_found");

    expect(await ledger.updateAccount({ tenantId, account: { accountId: erika.id, name: "Auslagen Erika M.", group: "open_items", openItems: true } })).toMatchObject({ name: "Auslagen Erika M." });
    await ledger.setAccountArchived({ tenantId, accountId: erika.id, archived: true });
    const entry = ionos({ lines: [{ accountNumber: "6825", amountCents: 100 }, { accountNumber: "3511", amountCents: -100 }] });
    expect(await code(ledger.createEntry({ tenantId, userId: USER, entry, book: false }))).toBe("account_archived");
    expect(await code(ledger.createEntry({ tenantId, userId: USER, entry: ionos({ lines: [{ accountNumber: "9999", amountCents: 1 }, { accountNumber: "1800", amountCents: -1 }] }), book: false }))).toBe("account_not_found");
  });
});

describe("ledger entries and revisions", () => {
  it("books IONOS with generated input tax and summarizes it", async () => {
    const { tenantId } = await enabledTenant();
    const { entryId } = await ledger.createEntry({ tenantId, userId: USER, entry: ionos(), book: true });
    const entry = await ledger.getEntry(tenantId, entryId);
    expect(entry).toMatchObject({ status: "booked", origin: "manual", totalCents: 150, differenceCents: 0, lockedBy: null, revision: 1 });
    expect(entry!.lines.map((line) => [line.accountNumber, line.amountCents, line.taxRole])).toEqual([
      ["6810", 126, "base"],
      ["1406", 24, "tax"],
      ["1800", -150, null],
    ]);
    expect(entry!.summary).toEqual({ key: "summaries.expensePaidByBank", params: { amount: 1.5, account: "Internetkosten", counter: "Bank Hausbank" } });
    expect(entry!.revisions.map((revision) => revision.changeKind)).toEqual(["created"]);

    const balances = await ledger.getBalances(tenantId, { from: "2026-07-01", to: "2026-07-31" });
    expect(balances.rows.map((row) => [row.number, row.closingCents])).toEqual([
      ["1406", 24],
      ["1800", -150],
      ["6810", 126],
    ]);
    const vat = await ledger.getVatPreview(tenantId, { from: "2026-07-01", to: "2026-07-31" });
    expect(vat.payableCents).toBe(-24);
  });

  it("refuses to book an unbalanced entry, keeps it as a proposal", async () => {
    const { tenantId } = await enabledTenant();
    const unbalanced = ionos({ lines: [{ accountNumber: "6810", amountCents: 150, taxCode: "vst19" }, { accountNumber: "1800", amountCents: -140 }] });
    expect(await code(ledger.createEntry({ tenantId, userId: USER, entry: unbalanced, book: true }))).toBe("unbalanced");
    const { entryId } = await ledger.createEntry({ tenantId, userId: USER, entry: unbalanced, book: false });
    expect(await code(ledger.bookEntry({ tenantId, userId: USER, entryId }))).toBe("unbalanced");
    expect((await ledger.getEntry(tenantId, entryId))?.differenceCents).toBe(10);
  });

  it("editing a booked entry needs a reason and writes a revision with the previous state", async () => {
    const { tenantId } = await enabledTenant();
    const { entryId } = await ledger.createEntry({ tenantId, userId: USER, entry: ionos(), book: true });
    const corrected = ionos({ lines: [{ accountNumber: "6837", amountCents: 150, taxCode: "vst19" }, { accountNumber: "1800", amountCents: -150 }] });

    expect(await code(ledger.updateEntry({ tenantId, userId: USER, entryId, entry: corrected }))).toBe("reason_required");
    expect(await code(ledger.updateEntry({ tenantId, userId: USER, entryId, entry: corrected, reason: "Lizenz", expectedRevision: 7 }))).toBe("stale_revision");
    expect(await ledger.updateEntry({ tenantId, userId: USER, entryId, entry: corrected, reason: "Ist eine Lizenz", expectedRevision: 1 })).toEqual({ entryId, revision: 2 });

    const entry = await ledger.getEntry(tenantId, entryId);
    expect(entry!.status).toBe("booked");
    expect(entry!.lines[0]!.accountNumber).toBe("6837");
    const edited = entry!.revisions[1]!;
    expect(edited).toMatchObject({ revision: 2, changeKind: "edited", reason: "Ist eine Lizenz", changedByUserId: USER });
    expect(edited.snapshot!.lines[0]).toMatchObject({ accountNumber: "6810", amountCents: 126 });

    // A booked entry stays balanced through an edit.
    const broken = ionos({ lines: [{ accountNumber: "6837", amountCents: 150 }, { accountNumber: "1800", amountCents: -100 }] });
    expect(await code(ledger.updateEntry({ tenantId, userId: USER, entryId, entry: broken, reason: "x" }))).toBe("unbalanced");
  });

  it("unbooks and deletes with a reason; the deletion stays visible as a revision", async () => {
    const { tenantId } = await enabledTenant();
    const { entryId } = await ledger.createEntry({ tenantId, userId: USER, entry: ionos(), book: true });
    expect(await code(ledger.unbookEntry({ tenantId, userId: USER, entryId }))).toBe("reason_required");
    expect(await code(ledger.deleteEntry({ tenantId, userId: USER, entryId }))).toBe("reason_required");
    await ledger.unbookEntry({ tenantId, userId: USER, entryId, reason: "Doppelt" });
    expect((await ledger.getEntry(tenantId, entryId))?.status).toBe("proposed");
    await ledger.deleteEntry({ tenantId, userId: USER, entryId });
    expect(await ledger.getEntry(tenantId, entryId)).toBeNull();
    const repos = createDrizzleRepositories(db);
    expect((await repos.ledger.listRevisions(tenantId, entryId)).map((revision) => [revision.changeKind, revision.entryId])).toEqual([
      ["created", null],
      ["unbooked", null],
      ["deleted", null],
    ]);
  });

  it("dismisses and restores a proposal; bulk booking books what balances and reports the rest", async () => {
    const { tenantId } = await enabledTenant();
    const good = await ledger.createEntry({ tenantId, userId: USER, entry: ionos(), book: false });
    const bad = await ledger.createEntry({ tenantId, userId: USER, entry: ionos({ lines: [{ accountNumber: "6810", amountCents: 1 }, { accountNumber: "1800", amountCents: -2 }] }), book: false });
    const dismissed = await ledger.createEntry({ tenantId, userId: USER, entry: ionos(), book: false });
    await ledger.dismissProposal({ tenantId, userId: USER, entryId: dismissed.entryId });
    expect(await code(ledger.dismissProposal({ tenantId, userId: USER, entryId: dismissed.entryId }))).toBe("not_proposed");
    expect((await ledger.listEntries(tenantId)).map((entry) => entry.id)).not.toContain(dismissed.entryId);
    expect((await ledger.listEntries(tenantId, { dismissed: "only" })).map((entry) => entry.id)).toEqual([dismissed.entryId]);

    const result = await ledger.bulkBook({ tenantId, userId: USER, entryIds: [good.entryId, bad.entryId, dismissed.entryId, randomUUID()] });
    expect(result.booked).toEqual([good.entryId]);
    expect(result.failed.map((failure) => failure.errorCode)).toEqual(["unbalanced", "not_proposed", "not_found"]);

    await ledger.restoreProposal({ tenantId, userId: USER, entryId: dismissed.entryId });
    await ledger.bookEntry({ tenantId, userId: USER, entryId: dismissed.entryId });
    expect(await code(ledger.bookEntry({ tenantId, userId: USER, entryId: dismissed.entryId }))).toBe("already_booked");
    expect(await code(ledger.dismissProposal({ tenantId, userId: USER, entryId: dismissed.entryId }))).toBe("already_booked");
  });

  it("refuses references to another tenant's document or transaction", async () => {
    const a = await enabledTenant();
    const b = await enabledTenant();
    const foreignDoc = await invoiceDocument(b.tenantId, "2026-07-01");
    const foreignTx = await bankTransaction(b.tenantId, b.bankAccountId, "2026-07-01", -150);
    expect(await code(ledger.createEntry({ tenantId: a.tenantId, userId: USER, entry: ionos({ documentId: foreignDoc.id }), book: false }))).toBe("source_not_found");
    expect(await code(ledger.createEntry({ tenantId: a.tenantId, userId: USER, entry: ionos({ transactionId: foreignTx.id }), book: false }))).toBe("source_not_found");

    const own = await ledger.createEntry({ tenantId: a.tenantId, userId: USER, entry: ionos(), book: true });
    expect(await ledger.getEntry(b.tenantId, own.entryId)).toBeNull();
    expect(await code(ledger.deleteEntry({ tenantId: b.tenantId, userId: USER, entryId: own.entryId, reason: "x" }))).toBe("not_found");
  });
});

describe("ledger filings and the lock", () => {
  it("locks Q3 after submitting the USt-VA; a correction filing reopens what is tied to it", async () => {
    const { tenantId } = await enabledTenant();
    const { entryId } = await ledger.createEntry({ tenantId, userId: USER, entry: ionos({ bookingDate: "2026-08-15" }), book: true });
    const filing = await ledger.createFiling({ tenantId, userId: USER, filing: { kind: "vat_return", periodFrom: "2026-07-01", periodTo: "2026-09-30", status: "draft" } });
    expect(await code(ledger.createFiling({ tenantId, userId: USER, filing: { kind: "vat_return", periodFrom: "2026-09-01", periodTo: "2026-09-30", status: "draft" } }))).toBe("filing_overlaps");
    await ledger.submitFiling({ tenantId, filingId: filing.id, submittedOn: "2026-10-10", amountCents: -24 });
    expect(await code(ledger.submitFiling({ tenantId, filingId: filing.id, submittedOn: "2026-10-10" }))).toBe("filing_not_draft");

    expect((await ledger.getEntry(tenantId, entryId))?.lockedBy).toMatchObject({ id: filing.id, kind: "vat_return" });
    expect(await code(ledger.updateEntry({ tenantId, userId: USER, entryId, entry: ionos({ bookingDate: "2026-08-15", text: "neu" }), reason: "x" }))).toBe("locked");
    expect(await code(ledger.deleteEntry({ tenantId, userId: USER, entryId, reason: "x" }))).toBe("locked");
    expect(await code(ledger.unbookEntry({ tenantId, userId: USER, entryId, reason: "x" }))).toBe("locked");
    expect(await code(ledger.createEntry({ tenantId, userId: USER, entry: ionos({ bookingDate: "2026-09-01" }), book: true }))).toBe("locked");
    // A correction in the first open period is fine.
    await ledger.createEntry({ tenantId, userId: USER, entry: ionos({ bookingDate: "2026-10-01", text: "Korrektur IONOS" }), book: true });

    expect(await code(ledger.createCorrectionFiling({ tenantId, userId: USER, filingId: randomUUID() }))).toBe("not_found");
    const correction = await ledger.createCorrectionFiling({ tenantId, userId: USER, filingId: filing.id });
    expect(correction).toMatchObject({ status: "draft", correctsFilingId: filing.id, periodFrom: "2026-07-01" });
    expect(await code(ledger.createCorrectionFiling({ tenantId, userId: USER, filingId: filing.id }))).toBe("correction_exists");
    expect(await code(ledger.createCorrectionFiling({ tenantId, userId: USER, filingId: correction.id }))).toBe("filing_not_submitted");
    expect(await code(ledger.createEntry({ tenantId, userId: USER, entry: ionos({ bookingDate: "2026-12-01", filingId: correction.id }), book: true }))).toBe("invalid_filing");

    await ledger.updateEntry({ tenantId, userId: USER, entryId, entry: ionos({ bookingDate: "2026-08-15", text: "berichtigt", filingId: correction.id }), reason: "Berichtigung Q3" });
    expect((await ledger.getEntry(tenantId, entryId))?.text).toBe("berichtigt");
    await ledger.submitFiling({ tenantId, filingId: correction.id, submittedOn: "2026-11-05" });
    expect(await code(ledger.updateEntry({ tenantId, userId: USER, entryId, entry: ionos({ bookingDate: "2026-08-15" }), reason: "x" }))).toBe("locked");
    // A submitted correction no longer opens anything.
    expect(await code(ledger.updateEntry({ tenantId, userId: USER, entryId, entry: ionos({ bookingDate: "2026-08-15", filingId: correction.id }), reason: "x" }))).toBe("invalid_filing");
  });

  it("an annual statement is stored for the whole year", async () => {
    const { tenantId } = await enabledTenant();
    const filing = await ledger.createFiling({ tenantId, userId: USER, filing: { kind: "annual_statement", periodFrom: "2026-06-01", periodTo: "2026-06-01", status: "submitted", submittedOn: "2027-05-31" } });
    expect(filing).toMatchObject({ periodFrom: "2026-01-01", periodTo: "2026-12-31", status: "submitted" });
    expect(await code(ledger.createEntry({ tenantId, userId: USER, entry: ionos({ bookingDate: "2026-12-31" }), book: true }))).toBe("locked");
  });
});

describe("ledger proposals (the seam for the proposal engine)", () => {
  it("creates, keeps an unchanged, updates a changed proposal; never touches a booked, dismissed or edited one", async () => {
    const { tenantId } = await enabledTenant();
    const doc = await invoiceDocument(tenantId, "2026-07-01", "IONOS");
    const proposal = { sourceKey: `doc:${doc.id}`, entry: ionos({ documentId: doc.id }), origin: "template" as const, warnings: [] };

    const created = await ledger.upsertProposal({ tenantId, proposal });
    expect(created.outcome).toBe("created");
    expect(await ledger.upsertProposal({ tenantId, proposal })).toEqual({ entryId: created.entryId, outcome: "kept" });

    const changed = { ...proposal, entry: ionos({ documentId: doc.id, lines: [{ accountNumber: "6837", amountCents: 150, taxCode: "vst19" as const }, { accountNumber: "1800", amountCents: -150 }] }), warnings: ["no_tax_breakdown" as const] };
    expect(await ledger.upsertProposal({ tenantId, proposal: changed })).toEqual({ entryId: created.entryId, outcome: "updated" });
    const entry = await ledger.getEntry(tenantId, created.entryId);
    expect(entry).toMatchObject({ origin: "template", warnings: ["no_tax_breakdown"], revision: 2, sourceKey: `doc:${doc.id}` });
    expect(entry!.revisions.map((revision) => [revision.changeKind, revision.changedByUserId])).toEqual([
      ["created", null],
      ["edited", null],
    ]);

    await ledger.bookEntry({ tenantId, userId: USER, entryId: created.entryId });
    expect((await ledger.upsertProposal({ tenantId, proposal })).outcome).toBe("kept");
    expect((await ledger.getEntry(tenantId, created.entryId))?.lines[0]?.accountNumber).toBe("6837");

    const other = { ...proposal, sourceKey: "tx:dismissed" };
    const second = await ledger.upsertProposal({ tenantId, proposal: other });
    await ledger.dismissProposal({ tenantId, userId: USER, entryId: second.entryId });
    expect((await ledger.upsertProposal({ tenantId, proposal: { ...changed, sourceKey: "tx:dismissed" } })).outcome).toBe("kept");

    const third = await ledger.upsertProposal({ tenantId, proposal: { ...proposal, sourceKey: "tx:edited" } });
    await ledger.updateEntry({ tenantId, userId: USER, entryId: third.entryId, entry: ionos({ text: "von Hand" }) });
    expect((await ledger.upsertProposal({ tenantId, proposal: { ...changed, sourceKey: "tx:edited" } })).outcome).toBe("kept");

    expect(await ledger.listSourceKeys(tenantId, "tx:")).toEqual([
      { sourceKey: "tx:dismissed", entryId: second.entryId, status: "proposed", dismissed: true, userEdited: false },
      { sourceKey: "tx:edited", entryId: third.entryId, status: "proposed", dismissed: false, userEdited: true },
    ]);
    expect((await ledger.listSourceKeys(tenantId)).map((row) => row.sourceKey)).toHaveLength(3);
  });

  it("two concurrent syncs proposing the same source end with one entry", async () => {
    const { tenantId } = await enabledTenant();
    const proposal = { sourceKey: "tx:race", entry: ionos(), origin: "rule" as const, warnings: [] };
    const results = await Promise.all([ledger.upsertProposal({ tenantId, proposal }), ledger.upsertProposal({ tenantId, proposal })]);
    expect(new Set(results.map((result) => result.entryId)).size).toBe(1);
    expect(results.map((result) => result.outcome).sort()).toEqual(["created", "kept"]);
  });
});

describe("ledger open items: Google Ads charged first, invoiced later", () => {
  it("matches charges against the invoice to zero; refuses a match that does not sum to zero", async () => {
    const { tenantId } = await enabledTenant();
    await ledger.createAccount({ tenantId, account: { number: "1462", name: "Verrechnungskonto Google Ads", kind: "asset", group: "open_items", openItems: true, ownerType: null } });
    for (const [date, cents] of [["2026-08-10", 1000], ["2026-08-19", 5000], ["2026-09-02", 3657]] as const) {
      await ledger.createEntry({ tenantId, userId: USER, entry: { bookingDate: date, text: "Google Ads Abbuchung", lines: [{ accountNumber: "1462", amountCents: cents }, { accountNumber: "1800", amountCents: -cents }] }, book: true });
    }
    await ledger.createEntry({
      tenantId,
      userId: USER,
      entry: { bookingDate: "2026-09-03", text: "Google Ads Rechnung", lines: [{ accountNumber: "6600", amountCents: 9657, taxCode: "rc13b" }, { accountNumber: "1462", amountCents: -9657 }] },
      book: true,
    });

    const items = await ledger.getOpenItems(tenantId, { accountNumber: "1462", asOf: "2026-09-30" });
    expect(items).toMatchObject({ balanceCents: 0, status: "zero" });
    const ids = items!.unmatched.map((line) => line.lineId);
    expect(ids).toHaveLength(4);

    expect(await code(ledger.createMatch({ tenantId, userId: USER, match: { accountNumber: "1462", kind: "match", lineIds: ids.slice(0, 2) } }))).toBe("match_not_zero");
    expect(await code(ledger.createMatch({ tenantId, userId: USER, match: { accountNumber: "1800", kind: "match", lineIds: ids } }))).toBe("account_not_open_items");
    const { matchId } = await ledger.createMatch({ tenantId, userId: USER, match: { accountNumber: "1462", kind: "match", lineIds: ids } });
    expect(await code(ledger.createMatch({ tenantId, userId: USER, match: { accountNumber: "1462", kind: "explained", lineIds: ids.slice(0, 1), note: "x" } }))).toBe("line_already_matched");
    expect((await ledger.getOpenItems(tenantId, { accountNumber: "1462", asOf: "2026-09-30" }))?.unmatched).toEqual([]);

    // As of August, before the invoice, the account is open: what was charged but not invoiced.
    expect((await ledger.listOpenItemAccounts(tenantId, "2026-08-31")).find((summary) => summary.account.number === "1462")).toMatchObject({ balanceCents: 6000 });

    // As of August the match is not complete yet (the invoice is from September): still open.
    expect((await ledger.getOpenItems(tenantId, { accountNumber: "1462", asOf: "2026-08-31" }))?.unmatched).toHaveLength(2);

    await ledger.deleteMatch({ tenantId, matchId });
    expect(await code(ledger.deleteMatch({ tenantId, matchId }))).toBe("not_found");
  });
});

describe("ledger controls and the period overview", () => {
  it("finds the unbooked Google Ads debit of 19.08.: bank diverges from that day, the transaction is unbooked", async () => {
    const { tenantId, bankAccountId } = await enabledTenant();
    const capital = await bankTransaction(tenantId, bankAccountId, "2026-06-10", 2500000, "Gesellschafter");
    const charge1 = await bankTransaction(tenantId, bankAccountId, "2026-08-10", -1000, "Google Ads");
    const charge2 = await bankTransaction(tenantId, bankAccountId, "2026-08-19", -5000, "Google Ads");
    const doc = await invoiceDocument(tenantId, "2026-08-31", "Google Ads Rechnung");

    await ledger.createEntry({ tenantId, userId: USER, entry: { bookingDate: "2026-06-10", text: "Stammkapital", transactionId: capital.id, lines: [{ accountNumber: "1800", amountCents: 2500000 }, { accountNumber: "2900", amountCents: -2500000 }] }, book: true });
    await ledger.createEntry({ tenantId, userId: USER, entry: { bookingDate: "2026-08-10", text: "Google Ads", transactionId: charge1.id, lines: [{ accountNumber: "6600", amountCents: 1000 }, { accountNumber: "1800", amountCents: -1000 }] }, book: true });
    await ledger.createEntry({ tenantId, userId: USER, entry: ionos({ bookingDate: "2026-08-20" }), book: false });

    const controls = await ledger.getControls(tenantId, { from: "2026-08-01", to: "2026-08-31" });
    const byId = new Map(controls.map((control) => [control.id, control]));
    expect(byId.get("bank_matches_statement")).toMatchObject({ status: "failed", message: { params: { account: "1800", date: "2026-08-19", differenceCents: 5000 } } });
    expect(byId.get("unbooked_bank_transactions")).toMatchObject({ status: "failed", subjects: [charge2.id] });
    expect(byId.get("unbooked_documents")).toMatchObject({ status: "warning", subjects: [doc.id] });
    expect(byId.get("proposals_waiting")).toMatchObject({ status: "warning", count: 1 });
    expect(byId.get("advisor_differences")?.status).toBe("not_applicable");

    // June is clean.
    const june = await ledger.getControls(tenantId, { from: "2026-06-01", to: "2026-06-30" });
    expect(june.find((control) => control.id === "bank_matches_statement")?.status).toBe("ok");
    expect(june.find((control) => control.id === "unbooked_bank_transactions")?.status).toBe("ok");

    const overview = await ledger.getPeriodOverview(tenantId, 2026);
    expect(overview).toHaveLength(12);
    expect(overview.find((row) => row.key === "2026-06")).toMatchObject({ status: "ready", bookedCount: 1 });
    expect(overview.find((row) => row.key === "2026-08")).toMatchObject({ status: "in_progress", bookedCount: 1, proposedCount: 1 });
    expect(overview.find((row) => row.key === "2026-08")?.failingControls).toEqual(expect.arrayContaining(["bank_matches_statement", "unbooked_bank_transactions"]));
    expect(overview.find((row) => row.key === "2026-11")).toMatchObject({ status: "open" });
  });

  it("counts changes since a handover and shows the period as handed over", async () => {
    const { tenantId } = await enabledTenant();
    const { entryId } = await ledger.createEntry({ tenantId, userId: USER, entry: ionos(), book: true });
    const handover = await ledger.createHandover({ tenantId, userId: USER, periodFrom: "2026-07-01", periodTo: "2026-07-31", note: "Juli an Frau Steuer" });
    expect(handover.changesSince).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await ledger.updateEntry({ tenantId, userId: USER, entryId, entry: ionos({ text: "IONOS korrigiert" }), reason: "Text" });
    expect((await ledger.listHandovers(tenantId))[0]?.changesSince).toBe(1);
    expect((await ledger.listEntries(tenantId, { changedSince: handover.createdAt })).map((entry) => entry.id)).toEqual([entryId]);
    const july = (await ledger.getPeriodOverview(tenantId, 2026)).find((row) => row.key === "2026-07");
    expect(july).toMatchObject({ status: "handed_over", changesSince: 1 });
  });

  it("compares with the tax advisor's Summen- und Saldenliste", async () => {
    const { tenantId } = await enabledTenant();
    await ledger.createEntry({ tenantId, userId: USER, entry: ionos(), book: true });
    expect(await code(ledger.uploadAdvisorBalances({ tenantId, userId: USER, periodFrom: "2026-07-01", periodTo: "2026-07-31", csvText: "Datum;Betrag" }))).toBe("advisor_file_invalid");
    const tooLarge = `Konto;Saldo\n1800;1,00\n${"x".repeat(MAX_ADVISOR_FILE_BYTES)}`;
    expect(await code(ledger.uploadAdvisorBalances({ tenantId, userId: USER, periodFrom: "2026-07-01", periodTo: "2026-07-31", csvText: tooLarge }))).toBe("advisor_file_invalid");
    expect(await code(ledger.uploadAdvisorBalances({ tenantId, userId: USER, periodFrom: "2026-07-01", periodTo: "2026-07-31", csvText: "Konto;Saldo\n1800;99999999999,00" }))).toBe("advisor_file_invalid");
    const csv = "Konto;Beschriftung;Saldo;S/H\n1406;Vorsteuer;0,24;S\n1800;Bank;1,50;H\n6810;Internet;1,26;S\n6855;Geldverkehr;0,00;S";
    const upload = await ledger.uploadAdvisorBalances({ tenantId, userId: USER, periodFrom: "2026-07-01", periodTo: "2026-07-31", fileName: "SuSa_07.csv", csvText: csv });
    expect(upload).toMatchObject({ lineCount: 4, fileName: "SuSa_07.csv" });
    expect((await ledger.getAdvisorComparison(tenantId, upload.id))?.comparison.differenceCount).toBe(0);

    const off = "Konto;Saldo\n1406;0,00\n1800;1,50 H\n6810;1,50 S";
    const second = await ledger.uploadAdvisorBalances({ tenantId, userId: USER, periodFrom: "2026-07-01", periodTo: "2026-07-31", csvText: off });
    const comparison = await ledger.getAdvisorComparison(tenantId, second.id);
    expect(comparison?.comparison.rows.filter((row) => row.differenceCents !== 0).map((row) => [row.accountNumber, row.differenceCents])).toEqual([
      ["1406", 24],
      ["6810", -24],
    ]);
    expect((await ledger.listAdvisorUploads(tenantId)).map((row) => row.id)).toEqual([second.id, upload.id]);
    await ledger.deleteAdvisorUpload({ tenantId, uploadId: second.id });
    expect(await ledger.getAdvisorComparison(tenantId, second.id)).toBeNull();
  });
});

describe("ledger across a year boundary", () => {
  it("opens 2027 with the 2026 result on 2970, in the list, the Kontenblatt and the advisor comparison", async () => {
    const { tenantId } = await enabledTenant();
    await ledger.createEntry({ tenantId, userId: USER, entry: { bookingDate: "2026-07-15", text: "Erlös", lines: [{ accountNumber: "1800", amountCents: 50_000 }, { accountNumber: "4400", amountCents: -50_000 }] }, book: true });
    await ledger.createEntry({ tenantId, userId: USER, entry: ionos({ bookingDate: "2026-08-01" }), book: true });
    await ledger.createEntry({ tenantId, userId: USER, entry: ionos({ bookingDate: "2027-01-05" }), book: true });

    const balances = await ledger.getBalances(tenantId, { from: "2027-01-01", to: "2027-01-31" });
    const byNumber = new Map(balances.rows.map((row) => [row.number, row]));
    expect(byNumber.get("2970")).toMatchObject({ openingCents: -49_874, closingCents: -49_874 });
    expect(byNumber.get("4400")).toBeUndefined();
    expect(balances.totals.openingCents).toBe(0);
    expect(balances.totals.closingCents).toBe(0);
    expect((await ledger.getAccountSheet(tenantId, { accountNumber: "2970", from: "2027-01-01", to: "2027-01-31" }))?.openingCents).toBe(-49_874);

    const csv = "Konto;Beschriftung;Saldo;S/H\n1406;Vorsteuer;0,48;S\n1800;Bank;497,00;S\n2970;Gewinnvortrag;498,74;H\n6810;Internet;1,26;S";
    const upload = await ledger.uploadAdvisorBalances({ tenantId, userId: USER, periodFrom: "2027-01-01", periodTo: "2027-01-31", csvText: csv });
    expect((await ledger.getAdvisorComparison(tenantId, upload.id))?.comparison.differenceCount).toBe(0);
  });
});

describe("ledger booking rules", () => {
  it("creates, updates and deletes a no-document rule for the share capital", async () => {
    const { tenantId } = await enabledTenant();
    const rule = await ledger.createRule({
      tenantId,
      rule: { contactId: null, counterpartyPattern: "  Stammkapital ", direction: "incoming", accountNumber: "2900", taxCode: "not_taxable", paymentAccountNumber: null, noDocument: true, active: true },
    });
    expect(rule).toMatchObject({ counterpartyPattern: "stammkapital", accountNumber: "2900", noDocument: true, hits: 0 });
    expect(await code(ledger.createRule({ tenantId, rule: { contactId: randomUUID(), direction: "any", accountNumber: "6600", taxCode: "rc13b", paymentAccountNumber: null, noDocument: false, active: true } }))).toBe("owner_not_found");
    const updated = await ledger.updateRule({ tenantId, ruleId: rule.id, rule: { contactId: null, counterpartyPattern: "stammkapital", direction: "incoming", accountNumber: "2900", taxCode: "not_taxable", paymentAccountNumber: "1360", noDocument: true, active: false } });
    expect(updated).toMatchObject({ active: false, paymentAccountNumber: "1360" });
    expect(await ledger.listRules(tenantId)).toHaveLength(1);
    await ledger.deleteRule({ tenantId, ruleId: rule.id });
    expect(await code(ledger.deleteRule({ tenantId, ruleId: rule.id }))).toBe("not_found");
  });
});

describe("ledger reads of the second UI stage (accounts page, Kontenblatt, document card)", () => {
  it("lists proposals on the account sheet, counted only on request; compares each bank account; finds a document's entries", async () => {
    const { tenantId, bankAccountId } = await enabledTenant();
    const capital = await bankTransaction(tenantId, bankAccountId, "2026-06-10", 2500000, "Gesellschafter");
    await bankTransaction(tenantId, bankAccountId, "2026-07-01", -150, "IONOS");
    const doc = await invoiceDocument(tenantId, "2026-07-01", "IONOS Rechnung");
    await ledger.createEntry({ tenantId, userId: USER, entry: { bookingDate: "2026-06-10", text: "Stammkapital", transactionId: capital.id, lines: [{ accountNumber: "1800", amountCents: 2500000 }, { accountNumber: "2900", amountCents: -2500000 }] }, book: true });
    const proposal = await ledger.createEntry({ tenantId, userId: USER, entry: ionos({ documentId: doc.id }), book: false });

    const booked = await ledger.getAccountSheet(tenantId, { accountNumber: "1800", from: "2026-06-01", to: "2026-07-31" });
    expect(booked?.rows.map((row) => [row.proposed, row.runningBalanceCents])).toEqual([
      [false, 2500000],
      [true, 2500000],
    ]);
    expect(booked?.closingCents).toBe(2500000);
    const counted = await ledger.getAccountSheet(tenantId, { accountNumber: "1800", from: "2026-06-01", to: "2026-07-31", countProposals: true });
    expect(counted?.closingCents).toBe(2499850);

    // Booked only: the bank diverges from 01.07. until the proposal is booked.
    const [bank] = await ledger.getBankComparisons(tenantId, { from: "2026-06-01", to: "2026-07-31" });
    expect(bank).toMatchObject({ accountNumber: "1800", ok: false, firstDivergenceDate: "2026-07-01" });
    await ledger.bookEntry({ tenantId, userId: USER, entryId: proposal.entryId });
    expect((await ledger.getBankComparisons(tenantId, { from: "2026-06-01", to: "2026-07-31" }))[0]).toMatchObject({ ok: true, firstDivergenceDate: null });

    const sheets = await ledger.getAccountSheets(tenantId, { accountNumbers: ["2900", "6810", "9999"], from: "2026-06-01", to: "2026-07-31" });
    expect(sheets.map((sheet) => [sheet.account.number, sheet.closingCents])).toEqual([
      ["2900", -2500000],
      ["6810", 126],
    ]);

    const forDocument = await ledger.listEntries(tenantId, { documentId: doc.id, dismissed: "include" });
    expect(forDocument.map((entry) => entry.id)).toEqual([proposal.entryId]);
    const other = await enabledTenant();
    expect(await ledger.listEntries(other.tenantId, { documentId: doc.id, dismissed: "include" })).toEqual([]);
  });
});
