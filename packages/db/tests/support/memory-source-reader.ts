// An in-memory `LedgerSourceReader` for tests: documents, money accounts and movements,
// settlement lines, issued invoices and counterparties held in plain arrays, tenant-scoped like a
// real reader. Its reads mirror Digipost's SQL reads the ledger used to call: a document's contact
// is the link in the role its direction implies, a bank movement is paired with the clearing
// movement of the same transfer group, the bookable documents are the done ones of a bookable
// kind in the period.
import { randomUUID } from "node:crypto";

import { LEDGER_BOOKABLE_DOCUMENT_KINDS } from "@ledger/core";

import type {
  LedgerSourceDocumentRow,
  LedgerSourceInvoiceRow,
  LedgerSourceReader,
  LedgerSourceSettlementLineRow,
  MoneyAccountType,
} from "../../src";

type Owned<T> = T & { tenantId: string };

export type MemoryContact = Owned<{ id: string; name: string; country: string | null; vatId: string | null }>;
export type MemoryMoneyAccount = Owned<{ id: string; type: MoneyAccountType; name: string; iban: string | null; currency: string; platform: string | null; contactId: string | null }>;
export type MemoryTransaction = Owned<{
  id: string;
  accountId: string;
  bookingDate: string;
  amountCents: number;
  currency: string | null;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  remittanceText: string | null;
  noDocumentNeeded: boolean;
  transferGroupId: string | null;
}>;
export type MemoryDocument = Owned<Omit<LedgerSourceDocumentRow, "contactId" | "contactName" | "contactVatId" | "contactCountry" | "confirmedTransactions">>;
export type MemorySettlementLine = Owned<LedgerSourceSettlementLineRow & { transactionId: string | null }>;

export type MemorySources = {
  contacts: MemoryContact[];
  accounts: MemoryMoneyAccount[];
  transactions: MemoryTransaction[];
  documents: MemoryDocument[];
  documentContacts: { tenantId: string; documentId: string; contactId: string; role: "sender" | "recipient" | "mentioned" }[];
  confirmedLinks: { tenantId: string; documentId: string; transactionId: string; allocatedAmountCents: number }[];
  settlementLines: MemorySettlementLine[];
  invoices: Owned<LedgerSourceInvoiceRow>[];
  paymentAliases: { tenantId: string; counterpartyNameNormalized: string; contactId: string }[];
  noDocumentRules: { tenantId: string; counterpartyNameNormalized: string }[];
  /** Per bank account: the opening balance of its first statement. */
  openingBalances: { tenantId: string; accountId: string; openingBalanceCents: number }[];
};

const BOOKABLE = new Set<string>(LEDGER_BOOKABLE_DOCUMENT_KINDS);

export function createMemorySourceReader(): { reader: LedgerSourceReader; state: MemorySources; add: ReturnType<typeof adders> } {
  const state: MemorySources = {
    contacts: [],
    accounts: [],
    transactions: [],
    documents: [],
    documentContacts: [],
    confirmedLinks: [],
    settlementLines: [],
    invoices: [],
    paymentAliases: [],
    noDocumentRules: [],
    openingBalances: [],
  };
  const of = <T extends { tenantId: string }>(rows: T[], tenantId: string) => rows.filter((row) => row.tenantId === tenantId);
  const accountType = (id: string) => state.accounts.find((account) => account.id === id)?.type;
  const bankTransactions = (tenantId: string) =>
    of(state.transactions, tenantId)
      .filter((tx) => accountType(tx.accountId) === "bank")
      .sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id));

  function documentRow(doc: MemoryDocument): LedgerSourceDocumentRow {
    const role = doc.direction === "outgoing" ? "recipient" : "sender";
    const link = state.documentContacts.find((candidate) => candidate.documentId === doc.id && candidate.role === role);
    const contact = link ? state.contacts.find((candidate) => candidate.id === link.contactId && candidate.tenantId === doc.tenantId) : undefined;
    const { tenantId: _tenantId, ...rest } = doc;
    return {
      ...rest,
      contactId: contact?.id ?? null,
      contactName: contact?.name ?? null,
      contactVatId: contact?.vatId ?? null,
      contactCountry: contact?.country ?? null,
      confirmedTransactions: state.confirmedLinks
        .filter((confirmed) => confirmed.documentId === doc.id)
        .map((confirmed) => ({ link: confirmed, date: state.transactions.find((tx) => tx.id === confirmed.transactionId)?.bookingDate ?? "" }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(({ link: confirmed }) => ({ transactionId: confirmed.transactionId, allocatedAmountCents: confirmed.allocatedAmountCents })),
    };
  }

  const reader: LedgerSourceReader = {
    async listDocumentsForLedger(tenantId) {
      return of(state.documents, tenantId)
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id))
        .map(documentRow);
    },
    documentExists: async (tenantId, documentId) => of(state.documents, tenantId).some((doc) => doc.id === documentId),
    async listDocumentContacts(tenantId, documentId) {
      if (!of(state.documents, tenantId).some((doc) => doc.id === documentId)) return [];
      return state.documentContacts
        .filter((link) => link.documentId === documentId)
        .map((link) => ({ documentId, contactId: link.contactId, role: link.role, contactName: state.contacts.find((contact) => contact.id === link.contactId)?.name ?? "" }));
    },
    async listBookableDocumentIds(tenantId, period) {
      return of(state.documents, tenantId)
        .filter((doc) => doc.status === "done" && BOOKABLE.has(doc.kind) && doc.effectiveDate >= period.from && doc.effectiveDate <= period.to)
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
        .map((doc) => doc.id);
    },
    async listMoneyAccounts(tenantId) {
      return of(state.accounts, tenantId).map(({ id, type, name, iban, platform, contactId }) => ({ id, type, name, iban, platform, contactId }));
    },
    async listSourceAccounts(tenantId) {
      return of(state.accounts, tenantId).map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        platform: account.platform,
        contactId: account.contactId,
        contactName: state.contacts.find((contact) => contact.id === account.contactId && contact.tenantId === tenantId)?.name ?? null,
      }));
    },
    async listTransactionsForLedger(tenantId) {
      return bankTransactions(tenantId).map((tx) => {
        const partner = tx.transferGroupId
          ? of(state.transactions, tenantId).find((other) => other.id !== tx.id && other.transferGroupId === tx.transferGroupId && accountType(other.accountId) === "clearing")
          : undefined;
        const clearing = partner ? state.accounts.find((account) => account.id === partner.accountId) : undefined;
        return {
          id: tx.id,
          accountId: tx.accountId,
          bookingDate: tx.bookingDate,
          amountCents: tx.amountCents,
          currency: tx.currency ?? state.accounts.find((account) => account.id === tx.accountId)?.currency ?? "EUR",
          counterpartyName: tx.counterpartyName,
          counterpartyIban: tx.counterpartyIban,
          remittanceText: tx.remittanceText,
          noDocumentNeeded: tx.noDocumentNeeded,
          pairedClearing:
            partner && clearing
              ? {
                  accountId: clearing.id,
                  platform: clearing.platform,
                  contactId: clearing.contactId,
                  reportDocumentIds: [...new Set(state.settlementLines.filter((line) => line.transactionId === partner.id && line.type === "payout").map((line) => line.sourceDocumentId))],
                }
              : null,
        };
      });
    },
    async findTransactionById(tenantId, transactionId) {
      const tx = of(state.transactions, tenantId).find((candidate) => candidate.id === transactionId);
      return tx ? { id: tx.id, accountId: tx.accountId, bookingDate: tx.bookingDate, amountCents: tx.amountCents, counterpartyName: tx.counterpartyName } : null;
    },
    transactionExists: async (tenantId, transactionId) => of(state.transactions, tenantId).some((tx) => tx.id === transactionId),
    async listBankMovements(tenantId, to) {
      return bankTransactions(tenantId)
        .filter((tx) => tx.bookingDate <= to)
        .map((tx) => ({ transactionId: tx.id, accountId: tx.accountId, bookingDate: tx.bookingDate, amountCents: tx.amountCents }));
    },
    async listBankOpeningBalances(tenantId) {
      return new Map(of(state.openingBalances, tenantId).map((row) => [row.accountId, row.openingBalanceCents]));
    },
    async listBankTransactionIds(tenantId, period) {
      return bankTransactions(tenantId)
        .filter((tx) => tx.bookingDate >= period.from && tx.bookingDate <= period.to)
        .map((tx) => tx.id);
    },
    async listSettlementLinesForLedger(tenantId) {
      return of(state.settlementLines, tenantId).map(({ tenantId: _tenantId, transactionId: _transactionId, ...line }) => line);
    },
    async listInvoices(tenantId, limit) {
      return of(state.invoices, tenantId)
        .sort((a, b) => b.issueDate.localeCompare(a.issueDate))
        .slice(0, limit)
        .map(({ tenantId: _tenantId, ...invoice }) => invoice);
    },
    async listContacts(tenantId) {
      return of(state.contacts, tenantId).map(({ id, name }) => ({ id, name }));
    },
    async findContactById(tenantId, contactId) {
      const contact = of(state.contacts, tenantId).find((candidate) => candidate.id === contactId);
      return contact ? { id: contact.id, name: contact.name } : null;
    },
    async listPaymentAliases(tenantId) {
      return of(state.paymentAliases, tenantId).map(({ counterpartyNameNormalized, contactId }) => ({ counterpartyNameNormalized, contactId }));
    },
    async listNoDocumentRules(tenantId) {
      return of(state.noDocumentRules, tenantId).map(({ counterpartyNameNormalized }) => ({ counterpartyNameNormalized }));
    },
  };

  return { reader, state, add: adders(state) };
}

/** Builders with the defaults a test does not care about. */
function adders(state: MemorySources) {
  return {
    contact(tenantId: string, name: string, fields: { country?: string | null; vatId?: string | null } = {}): MemoryContact {
      const row = { tenantId, id: randomUUID(), name, country: fields.country ?? "DE", vatId: fields.vatId ?? null };
      state.contacts.push(row);
      return row;
    },
    account(tenantId: string, fields: { type: MoneyAccountType; name: string; iban?: string | null; platform?: string | null; contactId?: string | null }): MemoryMoneyAccount {
      const row = { tenantId, id: randomUUID(), iban: null, platform: null, contactId: null, currency: "EUR", ...fields };
      state.accounts.push(row);
      return row;
    },
    transaction(tenantId: string, accountId: string, bookingDate: string, amountCents: number, counterpartyName: string | null = "Gegenüber", transferGroupId: string | null = null): MemoryTransaction {
      const row = { tenantId, id: randomUUID(), accountId, bookingDate, amountCents, currency: null, counterpartyName, counterpartyIban: null, remittanceText: null, noDocumentNeeded: false, transferGroupId };
      state.transactions.push(row);
      return row;
    },
    document(tenantId: string, fields: Partial<Omit<MemoryDocument, "tenantId">> & { title: string }, contact?: { contactId: string; role: "sender" | "recipient" }): MemoryDocument {
      const date = fields.documentDate ?? "2026-07-01";
      const row: MemoryDocument = {
        tenantId,
        id: randomUUID(),
        kind: "incoming_invoice",
        direction: "incoming",
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
      if (contact) state.documentContacts.push({ tenantId, documentId: row.id, contactId: contact.contactId, role: contact.role });
      return row;
    },
  };
}
