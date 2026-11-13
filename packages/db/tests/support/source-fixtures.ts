// One way for a test to set up sources, written either into the in-memory reader
// (`memory-source-reader.ts`) or into this service's source tables (read by
// `createDrizzleSourceReader`), so the same scenario and the same expectations run against both.
// Every builder takes the ids it should use, so a test can also write one scenario into both and
// compare the two readers row by row.
import { randomUUID } from "node:crypto";

import {
  createDrizzleSourceReader,
  createDrizzleSourceRepository,
  normalizeName,
  type LedgerDb,
  type LedgerSourceDocumentRow,
  type LedgerSourceInvoiceRow,
  type LedgerSourceReader,
  type MoneyAccountType,
  type SettlementLineType,
} from "../../src";
import { createMemorySourceReader } from "./memory-source-reader";

export type FixtureContact = { id?: string; name: string; country?: string | null; vatId?: string | null };
export type FixtureAccount = { id?: string; type: MoneyAccountType; name: string; iban?: string | null; platform?: string | null; contactId?: string | null };
export type FixtureTransaction = {
  id?: string;
  accountId: string;
  bookingDate: string;
  amountCents: number;
  counterpartyName?: string | null;
  transferGroupId?: string | null;
  noDocumentNeeded?: boolean;
};
export type FixtureDocument = Partial<Omit<LedgerSourceDocumentRow, "contactName" | "contactVatId" | "contactCountry" | "confirmedTransactions" | "effectiveDate" | "status" | "paymentStatus">> & {
  title: string;
  /** Only the drizzle reader reads it (into the payment status). */
  dueDate?: string | null;
};
export type FixtureSettlementLine = {
  id?: string;
  clearingAccountId: string;
  sourceDocumentId: string;
  transactionId?: string | null;
  type: SettlementLineType;
  grossCents: number | null;
  feeCents: number | null;
  netCents: number | null;
  bookingDate: string | null;
};

export interface SourceFixture {
  readonly name: string;
  readonly reader: LedgerSourceReader;
  contact(tenantId: string, contact: FixtureContact): Promise<{ id: string; name: string }>;
  account(tenantId: string, account: FixtureAccount): Promise<{ id: string }>;
  transaction(tenantId: string, tx: FixtureTransaction): Promise<{ id: string }>;
  document(tenantId: string, doc: FixtureDocument): Promise<{ id: string }>;
  confirm(tenantId: string, documentId: string, transactionId: string, allocatedAmountCents: number): Promise<void>;
  settlementLine(tenantId: string, line: FixtureSettlementLine): Promise<void>;
  openingBalance(tenantId: string, accountId: string, statementFrom: string, openingBalanceCents: number): Promise<void>;
  paymentAlias(tenantId: string, counterpartyNameNormalized: string, contactId: string): Promise<void>;
  noDocumentRule(tenantId: string, counterpartyNameNormalized: string): Promise<void>;
  /** Issued invoices: only the memory reader holds them; the drizzle fixture answers them from an
   * in-memory list too (`listInvoices` is not backed by a table yet). */
  invoice(tenantId: string, invoice: LedgerSourceInvoiceRow): void;
  retitle(tenantId: string, documentId: string, title: string): Promise<void>;
}

export function memoryFixture(): SourceFixture {
  const { reader, state } = createMemorySourceReader();
  return {
    name: "memory reader",
    reader,
    async contact(tenantId, contact) {
      const row = { tenantId, id: contact.id ?? randomUUID(), name: contact.name, country: contact.country ?? "DE", vatId: contact.vatId ?? null };
      state.contacts.push(row);
      return row;
    },
    async account(tenantId, account) {
      const row = { tenantId, id: account.id ?? randomUUID(), type: account.type, name: account.name, iban: account.iban ?? null, currency: "EUR", platform: account.platform ?? null, contactId: account.contactId ?? null };
      state.accounts.push(row);
      return row;
    },
    async transaction(tenantId, tx) {
      const row = {
        tenantId,
        id: tx.id ?? randomUUID(),
        accountId: tx.accountId,
        bookingDate: tx.bookingDate,
        amountCents: tx.amountCents,
        currency: null,
        counterpartyName: tx.counterpartyName === undefined ? "Gegenüber" : tx.counterpartyName,
        counterpartyIban: null,
        remittanceText: null,
        noDocumentNeeded: tx.noDocumentNeeded ?? false,
        transferGroupId: tx.transferGroupId ?? null,
      };
      state.transactions.push(row);
      return row;
    },
    async document(tenantId, doc) {
      const { contactId, dueDate: _dueDate, ...fields } = doc;
      const date = fields.documentDate ?? "2026-07-01";
      const row = {
        tenantId,
        id: randomUUID(),
        kind: "incoming_invoice",
        direction: "incoming" as const,
        status: "done",
        documentDate: date,
        effectiveDate: date,
        sender: null,
        summary: null,
        originalFileName: `${fields.title}.pdf`,
        invoiceNumber: null,
        totalAmountCents: null,
        currency: "EUR",
        platform: null,
        paymentStatus: "open",
        taxBreakdown: null,
        netTotalCents: null,
        taxTotalCents: null,
        passThroughCents: null,
        reverseCharge: null,
        serviceDate: null,
        servicePeriodFrom: null,
        servicePeriodTo: null,
        ...fields,
      };
      state.documents.push(row);
      if (contactId) state.documentContacts.push({ tenantId, documentId: row.id, contactId, role: row.direction === "outgoing" ? "recipient" : "sender" });
      return row;
    },
    async confirm(tenantId, documentId, transactionId, allocatedAmountCents) {
      state.confirmedLinks.push({ tenantId, documentId, transactionId, allocatedAmountCents });
    },
    async settlementLine(tenantId, line) {
      const platform = state.accounts.find((account) => account.id === line.clearingAccountId)?.platform ?? null;
      state.settlementLines.push({
        tenantId,
        id: line.id ?? randomUUID(),
        sourceDocumentId: line.sourceDocumentId,
        transactionId: line.transactionId ?? null,
        platform,
        type: line.type,
        grossCents: line.grossCents,
        feeCents: line.feeCents,
        netCents: line.netCents,
        currency: "EUR",
        bookingDate: line.bookingDate,
      });
    },
    async openingBalance(tenantId, accountId, _statementFrom, openingBalanceCents) {
      if (!state.openingBalances.some((row) => row.accountId === accountId)) state.openingBalances.push({ tenantId, accountId, openingBalanceCents });
    },
    async paymentAlias(tenantId, counterpartyNameNormalized, contactId) {
      state.paymentAliases.push({ tenantId, counterpartyNameNormalized, contactId });
    },
    async noDocumentRule(tenantId, counterpartyNameNormalized) {
      state.noDocumentRules.push({ tenantId, counterpartyNameNormalized });
    },
    invoice(tenantId, invoice) {
      state.invoices.push({ tenantId, ...invoice });
    },
    async retitle(_tenantId, documentId, title) {
      const doc = state.documents.find((candidate) => candidate.id === documentId);
      if (doc) doc.title = title;
    },
  };
}

export function drizzleFixture(db: LedgerDb): SourceFixture {
  const repo = createDrizzleSourceRepository(db);
  const invoices = createMemorySourceReader();
  const drizzleReader = createDrizzleSourceReader(db);
  const documents = new Map<string, Parameters<typeof repo.upsertDocument>[1]>();
  return {
    name: "drizzle reader",
    reader: { ...drizzleReader, listInvoices: invoices.reader.listInvoices },
    async contact(tenantId, contact) {
      const written = await repo.upsertContact(
        tenantId,
        { id: contact.id ?? randomUUID(), name: contact.name, nameNormalized: normalizeName(contact.name), country: contact.country ?? "DE", vatId: contact.vatId ?? null, vatIdNormalized: contact.vatId ?? null, source: "manual" },
        {},
      );
      return written!.row;
    },
    async account(tenantId, account) {
      return repo.insertMoneyAccount(tenantId, {
        id: account.id ?? randomUUID(),
        type: account.type,
        name: account.name,
        iban: account.iban ?? null,
        platform: account.platform ?? null,
        contactId: account.contactId ?? null,
      });
    },
    async transaction(tenantId, tx) {
      const [written] = await repo.upsertTransactions(tenantId, tx.accountId, [
        {
          id: tx.id ?? randomUUID(),
          idempotencyKey: randomUUID(),
          bookingDate: tx.bookingDate,
          amountCents: tx.amountCents,
          creditDebit: tx.amountCents < 0 ? "debit" : "credit",
          counterpartyName: tx.counterpartyName === undefined ? "Gegenüber" : tx.counterpartyName,
          transferGroupId: tx.transferGroupId ?? null,
        },
      ]);
      const row = written!.row;
      if (tx.noDocumentNeeded) await repo.setNoDocumentNeeded(tenantId, [row.id], true);
      return { id: row.id };
    },
    async document(tenantId, doc) {
      const { contactId, ...fields } = doc;
      const row = {
        id: doc.id ?? randomUUID(),
        kind: (fields.kind ?? "incoming_invoice") as "incoming_invoice",
        direction: fields.direction === undefined ? ("incoming" as const) : fields.direction,
        title: fields.title,
        sender: fields.sender ?? null,
        summary: fields.summary ?? null,
        originalFileName: fields.originalFileName ?? `${fields.title}.pdf`,
        invoiceNumber: fields.invoiceNumber ?? null,
        documentDate: fields.documentDate === undefined ? "2026-07-01" : fields.documentDate,
        dueDate: fields.dueDate ?? null,
        currency: fields.currency === undefined ? "EUR" : fields.currency,
        totalAmountCents: fields.totalAmountCents ?? null,
        netTotalCents: fields.netTotalCents ?? null,
        taxTotalCents: fields.taxTotalCents ?? null,
        passThroughCents: fields.passThroughCents ?? null,
        taxBreakdown: fields.taxBreakdown ?? null,
        reverseCharge: fields.reverseCharge ?? null,
        serviceDate: fields.serviceDate ?? null,
        servicePeriodFrom: fields.servicePeriodFrom ?? null,
        servicePeriodTo: fields.servicePeriodTo ?? null,
        platform: fields.platform ?? null,
        contactId: contactId ?? null,
      };
      await repo.upsertDocument(tenantId, row);
      documents.set(row.id, row);
      return row;
    },
    async confirm(tenantId, documentId, transactionId, allocatedAmountCents) {
      await repo.confirmLink(tenantId, { documentId, transactionId, allocatedAmountCents, matchedBy: "user", decidedByUserId: null });
    },
    async settlementLine(tenantId, line) {
      await repo.upsertSettlementLines(tenantId, [
        {
          id: line.id ?? randomUUID(),
          clearingAccountId: line.clearingAccountId,
          sourceDocumentId: line.sourceDocumentId,
          transactionId: line.transactionId ?? null,
          type: line.type,
          externalLineId: randomUUID(),
          grossCents: line.grossCents,
          feeCents: line.feeCents,
          netCents: line.netCents,
          currency: "EUR",
          bookingDate: line.bookingDate,
        },
      ]);
    },
    async openingBalance(tenantId, accountId, statementFrom, openingBalanceCents) {
      await repo.upsertImportBatch(tenantId, { accountId, statementFrom, openingBalanceCents, rowsTotal: 0, rowsImported: 0, rowsDuplicate: 0 });
    },
    async paymentAlias(tenantId, counterpartyNameNormalized, contactId) {
      await repo.upsertPaymentAlias(tenantId, { counterpartyNameNormalized, contactId, learnedFromUserId: null });
    },
    async noDocumentRule(tenantId, counterpartyNameNormalized) {
      await repo.upsertNoDocumentRule(tenantId, { counterpartyNameNormalized, createdByUserId: null });
    },
    invoice(tenantId, invoice) {
      invoices.state.invoices.push({ tenantId, ...invoice });
    },
    async retitle(tenantId, documentId, title) {
      const row = documents.get(documentId);
      if (!row) throw new Error(`unknown document ${documentId}`);
      row.title = title;
      await repo.upsertDocument(tenantId, row);
    },
  };
}
