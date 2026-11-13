// Real Postgres (Digipost decisions/0080-ledger-double-entry-bookkeeping.md): the two rules the
// database enforces on its own, whatever code writes the rows. A booked entry balances (deferred
// constraint trigger, checked at commit), and a booked entry inside a submitted filing period is
// locked (no update, no delete, no booked insert), except for the tenant-deletion cascade and
// entries tied to a draft correcting filing. Plus tenant isolation of the composite keys.
import { randomUUID } from "node:crypto";

import { SKR04_SEED_ACCOUNTS } from "@ledger/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  createDrizzleLedgerRepository,
  createDrizzleRepositories,
  dbErrorOf,
  isDbError,
  journalEntries,
  journalLines,
  ledgerFilings,
  platforms,
  type CreateJournalEntryRow,
  type CreateJournalLineRow,
  type LedgerAccountRow,
} from "../src";
import { newTenant, useTestDb } from "./support/test-database";

const { db } = useTestDb();
const repo = createDrizzleLedgerRepository(db);
const tenants = createDrizzleRepositories(db).tenant;

async function tenantWithChart() {
  const { tenant, scope } = await newTenant(db, { name: `Ledger GmbH ${randomUUID()}` });
  await repo.insertAccountsIfMissing(
    SKR04_SEED_ACCOUNTS.map((seed) => ({
      tenantId: tenant.id,
      number: seed.number,
      name: seed.name,
      kind: seed.kind,
      group: seed.group,
      openItems: seed.openItems,
      ownerType: null,
      ownerBankAccountId: null,
      ownerContactId: null,
      ownerPlatform: null,
      ownerPersonName: null,
      description: seed.description,
    })),
  );
  const accounts = new Map((await repo.listAccounts(tenant.id)).map((account) => [account.number, account]));
  return { tenant, scope, account: (number: string): LedgerAccountRow => accounts.get(number)! };
}

function entryRow(tenantId: string, overrides: Partial<CreateJournalEntryRow> = {}): CreateJournalEntryRow {
  return {
    tenantId,
    bookingDate: "2026-08-15",
    documentDate: null,
    serviceDate: null,
    text: "IONOS",
    status: "booked",
    origin: "manual",
    originReason: null,
    sourceKey: null,
    documentId: null,
    transactionId: null,
    correctionOfEntryId: null,
    filingId: null,
    warnings: [],
    userEditedAt: null,
    bookedAt: new Date(),
    bookedByUserId: null,
    ...overrides,
  };
}

function lines(debit: LedgerAccountRow, credit: LedgerAccountRow, cents = 150): CreateJournalLineRow[] {
  return [
    { position: 1, accountId: debit.id, amountCents: cents, taxCode: null, taxRole: null, generatedFromLinePosition: null, documentId: null, text: null },
    { position: 2, accountId: credit.id, amountCents: -cents, taxCode: null, taxRole: null, generatedFromLinePosition: null, documentId: null, text: null },
  ];
}

/** Inserts an entry with its lines in one transaction (the balance check runs at commit). */
async function insertEntry(tenantId: string, entryLines: CreateJournalLineRow[], overrides: Partial<CreateJournalEntryRow> = {}) {
  return db.transaction(async (tx) => {
    const txRepo = createDrizzleLedgerRepository(tx);
    const entry = await txRepo.insertEntry(entryRow(tenantId, overrides));
    await txRepo.replaceLines(tenantId, entry.id, entryLines);
    return entry;
  });
}

async function submittedVatReturn(tenantId: string, from = "2026-07-01", to = "2026-09-30") {
  return repo.insertFiling({ tenantId, kind: "vat_return", status: "submitted", periodFrom: from, periodTo: to, submittedOn: "2026-10-10", amountCents: 1876, correctsFilingId: null, note: null, createdByUserId: null });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

function expectRaised(err: unknown, message: string) {
  expect(err).not.toBeNull();
  expect(isDbError(err, "raised")).toBe(true);
  expect(dbErrorOf(err).message).toBe(message);
}

describe("ledger: a booked entry balances (deferred constraint trigger)", () => {
  it("accepts a balanced booked entry", async () => {
    const { tenant, account } = await tenantWithChart();
    const entry = await insertEntry(tenant.id, lines(account("6810"), account("1800")));
    expect(await repo.listLines(tenant.id, [entry.id])).toHaveLength(2);
  });

  it("refuses an unbalanced booked entry at commit", async () => {
    const { tenant, account } = await tenantWithChart();
    const bad = lines(account("6810"), account("1800"));
    bad[1]!.amountCents = -149;
    expectRaised(await caught(insertEntry(tenant.id, bad)), "ledger_unbalanced");
    expect(await db.select().from(journalEntries).where(eq(journalEntries.tenantId, tenant.id))).toHaveLength(0);
  });

  it("refuses a booked entry with a single line, or none", async () => {
    const { tenant, account } = await tenantWithChart();
    expectRaised(await caught(insertEntry(tenant.id, [])), "ledger_unbalanced");
    expectRaised(await caught(db.insert(journalEntries).values(entryRow(tenant.id))), "ledger_unbalanced");
    expectRaised(await caught(insertEntry(tenant.id, lines(account("6810"), account("1800")).slice(0, 1))), "ledger_unbalanced");
  });

  it("lets a proposal be unbalanced, but not be booked that way", async () => {
    const { tenant, account } = await tenantWithChart();
    const bad = lines(account("6810"), account("1800"));
    bad[1]!.amountCents = -100;
    const entry = await insertEntry(tenant.id, bad, { status: "proposed", bookedAt: null });
    expectRaised(await caught(repo.updateEntry(tenant.id, entry.id, { status: "booked", bookedAt: new Date() })), "ledger_unbalanced");
    // Fixing the lines and booking in the same transaction passes.
    await db.transaction(async (tx) => {
      const txRepo = createDrizzleLedgerRepository(tx);
      await txRepo.updateEntry(tenant.id, entry.id, { status: "booked", bookedAt: new Date() });
      await txRepo.replaceLines(tenant.id, entry.id, lines(account("6810"), account("1800"), 100));
    });
    expect((await repo.findEntry(tenant.id, entry.id))?.status).toBe("booked");
  });

  it("refuses changing one line of a booked entry so it no longer balances", async () => {
    const { tenant, account } = await tenantWithChart();
    const entry = await insertEntry(tenant.id, lines(account("6810"), account("1800")));
    const err = await caught(db.update(journalLines).set({ amountCents: 151 }).where(eq(journalLines.entryId, entry.id)).execute());
    expectRaised(err, "ledger_unbalanced");
  });
});

describe("ledger: a submitted filing locks its period (trigger)", () => {
  it("refuses update and delete of a booked entry inside a submitted USt-VA period, and of its lines", async () => {
    const { tenant, account } = await tenantWithChart();
    const entry = await insertEntry(tenant.id, lines(account("6810"), account("1800")));
    await submittedVatReturn(tenant.id);

    expectRaised(await caught(repo.updateEntry(tenant.id, entry.id, { text: "geändert" })), "ledger_locked");
    expectRaised(await caught(repo.updateEntry(tenant.id, entry.id, { bookingDate: "2026-10-01" })), "ledger_locked");
    expectRaised(await caught(repo.updateEntry(tenant.id, entry.id, { status: "proposed", bookedAt: null })), "ledger_locked");
    expectRaised(await caught(repo.deleteEntry(tenant.id, entry.id)), "ledger_locked");
    expectRaised(await caught(db.delete(journalLines).where(eq(journalLines.entryId, entry.id)).execute()), "ledger_locked");
    expectRaised(await caught(db.update(journalLines).set({ text: "x" }).where(eq(journalLines.entryId, entry.id)).execute()), "ledger_locked");
    const extra = await caught(
      db.insert(journalLines).values({ tenantId: tenant.id, entryId: entry.id, position: 3, accountId: account("6810").id, amountCents: 1 }).execute(),
    );
    expectRaised(extra, "ledger_locked");
    expect(await repo.findEntry(tenant.id, entry.id)).toMatchObject({ text: "IONOS", bookingDate: "2026-08-15" });
  });

  it("refuses booking into a locked period, and moving an entry into it", async () => {
    const { tenant, account } = await tenantWithChart();
    await submittedVatReturn(tenant.id);
    expectRaised(await caught(insertEntry(tenant.id, lines(account("6810"), account("1800")))), "ledger_locked");

    const proposal = await insertEntry(tenant.id, lines(account("6810"), account("1800")), { status: "proposed", bookedAt: null });
    expectRaised(await caught(repo.updateEntry(tenant.id, proposal.id, { status: "booked", bookedAt: new Date() })), "ledger_locked");

    const october = await insertEntry(tenant.id, lines(account("6810"), account("1800")), { bookingDate: "2026-10-02" });
    expectRaised(await caught(repo.updateEntry(tenant.id, october.id, { bookingDate: "2026-09-30" })), "ledger_locked");
  });

  it("leaves proposals and entries outside the period editable", async () => {
    const { tenant, account } = await tenantWithChart();
    await submittedVatReturn(tenant.id);
    const proposal = await insertEntry(tenant.id, lines(account("6810"), account("1800")), { status: "proposed", bookedAt: null });
    expect(await repo.updateEntry(tenant.id, proposal.id, { text: "neu" })).toMatchObject({ text: "neu" });
    expect(await repo.deleteEntry(tenant.id, proposal.id)).toBe(true);

    const october = await insertEntry(tenant.id, lines(account("6810"), account("1800")), { bookingDate: "2026-10-01" });
    expect(await repo.updateEntry(tenant.id, october.id, { text: "neu" })).toMatchObject({ text: "neu" });
    expect(await repo.deleteEntry(tenant.id, october.id)).toBe(true);
  });

  it("a draft filing locks nothing", async () => {
    const { tenant, account } = await tenantWithChart();
    const entry = await insertEntry(tenant.id, lines(account("6810"), account("1800")));
    await repo.insertFiling({ tenantId: tenant.id, kind: "vat_return", status: "draft", periodFrom: "2026-07-01", periodTo: "2026-09-30", submittedOn: null, amountCents: null, correctsFilingId: null, note: null, createdByUserId: null });
    expect(await repo.updateEntry(tenant.id, entry.id, { text: "neu" })).toMatchObject({ text: "neu" });
  });

  it("a submitted annual statement locks every day of its year", async () => {
    const { tenant, account } = await tenantWithChart();
    const march = await insertEntry(tenant.id, lines(account("6810"), account("1800")), { bookingDate: "2026-03-01" });
    await repo.insertFiling({ tenantId: tenant.id, kind: "annual_statement", status: "submitted", periodFrom: "2026-01-01", periodTo: "2026-12-31", submittedOn: "2027-05-01", amountCents: null, correctsFilingId: null, note: null, createdByUserId: null });
    expectRaised(await caught(repo.deleteEntry(tenant.id, march.id)), "ledger_locked");
    expect(await repo.findLockingFiling(tenant.id, "2026-12-31", null)).toMatchObject({ kind: "annual_statement" });
    expect(await repo.findLockingFiling(tenant.id, "2027-01-01", null)).toBeNull();
  });

  it("an entry tied to a draft correcting filing may change; once the correction is submitted it is locked again", async () => {
    const { tenant, account } = await tenantWithChart();
    const entry = await insertEntry(tenant.id, lines(account("6810"), account("1800")));
    const original = await submittedVatReturn(tenant.id);
    const correction = await repo.insertFiling({
      tenantId: tenant.id,
      kind: "vat_return",
      status: "draft",
      periodFrom: original.periodFrom,
      periodTo: original.periodTo,
      submittedOn: null,
      amountCents: null,
      correctsFilingId: original.id,
      note: null,
      createdByUserId: null,
    });

    expect(await repo.findLockingFiling(tenant.id, "2026-08-15", null)).toMatchObject({ id: original.id });
    expect(await repo.findLockingFiling(tenant.id, "2026-08-15", correction.id)).toBeNull();

    // Tying the entry to the draft correction is what opens it.
    await db.transaction(async (tx) => {
      const txRepo = createDrizzleLedgerRepository(tx);
      await txRepo.updateEntry(tenant.id, entry.id, { filingId: correction.id, text: "korrigiert" });
      await txRepo.replaceLines(tenant.id, entry.id, lines(account("6815"), account("1800")));
    });
    // A new booked entry inside the period, tied to the correction, is allowed too.
    const added = await insertEntry(tenant.id, lines(account("6300"), account("1800"), 500), { filingId: correction.id });

    await repo.updateFiling(tenant.id, correction.id, { status: "submitted", submittedOn: "2026-11-01" });
    expectRaised(await caught(repo.updateEntry(tenant.id, entry.id, { text: "nochmal" })), "ledger_locked");
    expectRaised(await caught(repo.deleteEntry(tenant.id, added.id)), "ledger_locked");
  });

  it("a correction of a USt-VA does not open a period an annual statement locks", async () => {
    const { tenant, account } = await tenantWithChart();
    const entry = await insertEntry(tenant.id, lines(account("6810"), account("1800")));
    const original = await submittedVatReturn(tenant.id);
    await repo.insertFiling({ tenantId: tenant.id, kind: "annual_statement", status: "submitted", periodFrom: "2026-01-01", periodTo: "2026-12-31", submittedOn: "2027-05-01", amountCents: null, correctsFilingId: null, note: null, createdByUserId: null });
    const correction = await repo.insertFiling({ tenantId: tenant.id, kind: "vat_return", status: "draft", periodFrom: original.periodFrom, periodTo: original.periodTo, submittedOn: null, amountCents: null, correctsFilingId: original.id, note: null, createdByUserId: null });
    expectRaised(await caught(repo.updateEntry(tenant.id, entry.id, { filingId: correction.id })), "ledger_locked");
  });

  it("a submitted filing itself can be neither changed nor deleted", async () => {
    const { tenant } = await tenantWithChart();
    const filing = await submittedVatReturn(tenant.id);
    expectRaised(await caught(repo.updateFiling(tenant.id, filing.id, { amountCents: 0 })), "ledger_locked");
    expectRaised(await caught(db.delete(ledgerFilings).where(eq(ledgerFilings.id, filing.id)).execute()), "ledger_locked");
  });

  it("deleting the tenant removes locked entries and submitted filings (the cascade exception)", async () => {
    const { tenant, scope, account } = await tenantWithChart();
    await insertEntry(tenant.id, lines(account("6810"), account("1800")));
    await submittedVatReturn(tenant.id);
    expect(await tenants.delete(scope, tenant.id)).toBe(true);
    expect(await db.select().from(journalEntries).where(eq(journalEntries.tenantId, tenant.id))).toHaveLength(0);
    expect(await db.select().from(journalLines).where(eq(journalLines.tenantId, tenant.id))).toHaveLength(0);
    expect(await db.select().from(ledgerFilings).where(eq(ledgerFilings.tenantId, tenant.id))).toHaveLength(0);
  });

  it("deleting the platform removes its tenants' books the same way", async () => {
    const { tenant, scope, account } = await tenantWithChart();
    await insertEntry(tenant.id, lines(account("6810"), account("1800")));
    await submittedVatReturn(tenant.id);
    await db.delete(platforms).where(eq(platforms.id, scope.platformId));
    expect(await tenants.lockForUpdate(tenant.id)).toBeNull();
    expect(await db.select().from(journalEntries).where(eq(journalEntries.tenantId, tenant.id))).toHaveLength(0);
    expect(await db.select().from(ledgerFilings).where(eq(ledgerFilings.tenantId, tenant.id))).toHaveLength(0);
  });
});

describe("ledger: tenant isolation", () => {
  it("a line cannot point at another tenant's account or entry (composite foreign keys)", async () => {
    const a = await tenantWithChart();
    const b = await tenantWithChart();
    const err = await caught(insertEntry(a.tenant.id, lines(b.account("6810"), a.account("1800"))));
    expect(isDbError(err, "foreign_key")).toBe(true);

    const entry = await insertEntry(a.tenant.id, lines(a.account("6810"), a.account("1800")), { status: "proposed", bookedAt: null });
    const crossEntry = await caught(
      db.insert(journalLines).values({ tenantId: b.tenant.id, entryId: entry.id, position: 9, accountId: b.account("6810").id, amountCents: 1 }).execute(),
    );
    expect(isDbError(crossEntry, "foreign_key")).toBe(true);
  });

  it("reads and writes stay inside the tenant", async () => {
    const a = await tenantWithChart();
    const b = await tenantWithChart();
    const entry = await insertEntry(a.tenant.id, lines(a.account("6810"), a.account("1800")));
    expect(await repo.findEntry(b.tenant.id, entry.id)).toBeNull();
    expect(await repo.updateEntry(b.tenant.id, entry.id, { text: "fremd" })).toBeNull();
    expect(await repo.deleteEntry(b.tenant.id, entry.id)).toBe(false);
    expect(await repo.listLines(b.tenant.id, [entry.id])).toEqual([]);
    expect(await repo.listReportLines(b.tenant.id, {})).toEqual([]);
    expect(await repo.findAccountById(b.tenant.id, a.account("1800").id)).toBeNull();
    // A submitted filing of tenant B does not lock tenant A.
    await submittedVatReturn(b.tenant.id);
    expect(await repo.findLockingFiling(a.tenant.id, "2026-08-15", null)).toBeNull();
    expect(await repo.updateEntry(a.tenant.id, entry.id, { text: "eigen" })).toMatchObject({ text: "eigen" });
  });
});

describe("ledger: open-item matches", () => {
  it("dissolves a match when one of its lines is replaced, and refuses a line in two matches", async () => {
    const { tenant, account } = await tenantWithChart();
    const invoice = await insertEntry(tenant.id, lines(account("6300"), account("3300"), 1000));
    const payment = await insertEntry(tenant.id, lines(account("3300"), account("1800"), 1000));
    const all = await repo.listLines(tenant.id, [invoice.id, payment.id]);
    const payables = all.filter((line) => line.accountNumber === "3300").map((line) => line.id);
    const match = await repo.insertMatch({ tenantId: tenant.id, accountId: account("3300").id, kind: "match", note: null, createdByUserId: null }, payables);
    expect(await repo.findMatchedLineIds(tenant.id, payables)).toHaveLength(2);

    const second = await caught(repo.insertMatch({ tenantId: tenant.id, accountId: account("3300").id, kind: "match", note: null, createdByUserId: null }, [payables[0]!]));
    expect(isDbError(second, "unique")).toBe(true);

    // The same lines again: nothing is replaced, the match stays.
    const same = await db.transaction(async (tx) => createDrizzleLedgerRepository(tx).replaceLines(tenant.id, payment.id, lines(account("3300"), account("1800"), 1000)));
    expect(same.dissolvedMatches).toBe(0);
    expect(await repo.findMatch(tenant.id, match.id)).not.toBeNull();

    // A changed amount on the matched line: the match is dissolved.
    const changed = await db.transaction(async (tx) => createDrizzleLedgerRepository(tx).replaceLines(tenant.id, payment.id, lines(account("3300"), account("1800"), 900)));
    expect(changed.dissolvedMatches).toBe(1);
    expect(await repo.findMatch(tenant.id, match.id)).toBeNull();
    expect(await repo.findMatchedLineIds(tenant.id, payables)).toEqual([]);
  });
});

describe("ledger: what the entries reference", () => {
  it("lists the transactions booked entries reference and the documents booked or dismissed ones reference, per tenant", async () => {
    const a = await tenantWithChart();
    const b = await tenantWithChart();
    const [bookedTx, proposedTx, bookedDoc, dismissedDoc, proposedDoc] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await insertEntry(a.tenant.id, lines(a.account("6810"), a.account("1800")), { transactionId: bookedTx, documentId: bookedDoc });
    await insertEntry(a.tenant.id, lines(a.account("6810"), a.account("1800")), { status: "proposed", bookedAt: null, transactionId: proposedTx, documentId: proposedDoc });
    const dismissed = await insertEntry(a.tenant.id, lines(a.account("6810"), a.account("1800")), { status: "proposed", bookedAt: null, documentId: dismissedDoc });
    await repo.updateEntry(a.tenant.id, dismissed.id, { dismissedAt: new Date() });

    expect([...(await repo.listBookedTransactionIds(a.tenant.id))]).toEqual([bookedTx]);
    expect([...(await repo.listDecidedDocumentIds(a.tenant.id))].sort()).toEqual([bookedDoc, dismissedDoc].sort());
    expect(await repo.listBookedTransactionIds(b.tenant.id)).toEqual(new Set());
    expect(await repo.listDecidedDocumentIds(b.tenant.id)).toEqual(new Set());
  });
});
