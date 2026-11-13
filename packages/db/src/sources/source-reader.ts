// The ledger's sources (decisions/0001-ledger-api.md "What the service owns, and what platforms
// send"): documents, money accounts and their movements, settlement lines, issued invoices,
// counterparties with their learned payment names and no-document rules. In Digipost the ledger
// read these from other owners' tables (`repos.document.listForLedger`,
// `repos.transaction.listForLedger`, ...); here they sit behind this port, one method per read
// the use cases made, with the rows those reads returned copied as plain types (narrowed to the
// fields the ledger reads).
//
// Phase 1 has no sources of its own yet: `emptySourceReader` answers every read with nothing. A
// later phase backs this port with the counterparty, money and document tables of this service
// (or, during the switch, with Digipost's own reads).
//
// Every method takes the caller's resolved `tenantId` and must never return another tenant's row.
// Nothing here is ever written by the ledger.
import type { ProposalTaxBreakdownEntry } from "@ledger/core";

/** A document as the proposal engine books it (Digipost's `LedgerDocumentRow`). */
export type LedgerSourceDocumentRow = {
  id: string;
  /** The effective kind (a human's correction over the classified one). */
  kind: string;
  direction: "incoming" | "outgoing" | "unknown" | null;
  status: string;
  /** ISO `YYYY-MM-DD`; `null` when the document prints none. */
  documentDate: string | null;
  /** ISO `YYYY-MM-DD`: the document date, else the day it arrived. */
  effectiveDate: string;
  title: string | null;
  sender: string | null;
  /** A one-paragraph summary (never the OCR text): what the AI advisor may be told. */
  summary: string | null;
  originalFileName: string;
  invoiceNumber: string | null;
  totalAmountCents: number | null;
  currency: string | null;
  /** The payment platform a settlement report comes from (`apple`, `google`, ...). */
  platform: string | null;
  /** The effective payment status (an open document past its due date reads `overdue`). */
  paymentStatus: string;
  /** One entry per printed VAT rate; `null` when no breakdown is printed. */
  taxBreakdown: ProposalTaxBreakdownEntry[] | null;
  netTotalCents: number | null;
  taxTotalCents: number | null;
  /** "Durchlaufende Posten" / "Auslagen ohne USt". */
  passThroughCents: number | null;
  reverseCharge: boolean | null;
  serviceDate: string | null;
  servicePeriodFrom: string | null;
  servicePeriodTo: string | null;
  /** The counterparty the direction implies: the sender of an incoming document, the recipient
   * of an outgoing one. */
  contactId: string | null;
  contactName: string | null;
  contactVatId: string | null;
  contactCountry: string | null;
  /** Confirmed payments, oldest booking first; `[]` when nothing is confirmed. */
  confirmedTransactions: { transactionId: string; allocatedAmountCents: number }[];
};

/** A movement on a BANK money account, with the clearing account it is paired with (Digipost's
 * `LedgerTransactionRow`). */
export type LedgerSourceTransactionRow = {
  id: string;
  /** The bank money account. */
  accountId: string;
  bookingDate: string;
  /** Signed, in cents: positive is money in. */
  amountCents: number;
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  remittanceText: string | null;
  noDocumentNeeded: boolean;
  /** The clearing account this bank movement is tied to (a platform payout, a supplier charge),
   * with the report documents whose payout line is the partner movement; `null` when unpaired. */
  pairedClearing: { accountId: string; platform: string | null; contactId: string | null; reportDocumentIds: string[] } | null;
};

/** One movement found by id (Digipost's `TransactionRow`, the fields the ledger reads). */
export type LedgerSourceTransactionDetail = { id: string; accountId: string; bookingDate: string; amountCents: number; counterpartyName: string | null };

export const SETTLEMENT_LINE_TYPES = ["revenue", "fee", "refund", "payout", "adjustment"] as const;
export type SettlementLineType = (typeof SETTLEMENT_LINE_TYPES)[number];

/** One line of a platform's settlement report with its clearing account's platform (Digipost's
 * `LedgerSettlementLineRow`). */
export type LedgerSourceSettlementLineRow = {
  id: string;
  sourceDocumentId: string;
  platform: string | null;
  type: SettlementLineType;
  grossCents: number | null;
  feeCents: number | null;
  netCents: number | null;
  currency: string | null;
  bookingDate: string | null;
};

/** The parts of a stored e-invoice the ledger reads (lines with their VAT, buyer country, service
 * date). */
export type LedgerSourceEinvoiceInput = {
  deliveryDate?: string | null;
  periodEnd?: string | null;
  buyer?: { address?: { country?: string | null } | null } | null;
  lines?: { quantity: string | number; unitPrice: string | number; vat: { category: string; rate?: string | number | null } }[] | null;
};

/** An invoice the platform issued (Digipost's `InvoiceWithCounterpart`, the fields the ledger
 * reads). */
export type LedgerSourceInvoiceRow = {
  id: string;
  number: string;
  type: "invoice" | "cancellation";
  issueDate: string;
  contactId: string | null;
  buyerName: string;
  /** The inbox document the invoice was filed as. */
  documentId: string | null;
  cancelsInvoiceId: string | null;
  netCents: number;
  vatCents: number;
  einvoiceInput: LedgerSourceEinvoiceInput;
};

export const MONEY_ACCOUNT_TYPES = ["bank", "clearing"] as const;
export type MoneyAccountType = (typeof MONEY_ACCOUNT_TYPES)[number];

/** A bank account or a clearing account (Digipost's `AccountRow`, the fields the ledger reads). */
export type LedgerSourceMoneyAccountRow = { id: string; type: MoneyAccountType; name: string; iban: string | null; platform: string | null; contactId: string | null };

/** A money account with its contact's name, for seeding the chart (Digipost's
 * `BankAccountSourceRow`). */
export type LedgerSourceAccountRow = { id: string; name: string; type: MoneyAccountType; platform: string | null; contactId: string | null; contactName: string | null };

/** A counterparty (Digipost's `ContactRow`, the fields the ledger reads). */
export type LedgerSourceContactRow = { id: string; name: string };

/** A counterparty linked to a document, with its role there (Digipost's
 * `DocumentContactWithContact`). */
export type LedgerSourceDocumentContactRow = { documentId: string; contactId: string; role: "sender" | "recipient" | "mentioned"; contactName: string };

/** A learned payment name: a normalized counterparty name to a contact (Digipost's
 * `PaymentAliasRow`). */
export type LedgerSourcePaymentAliasRow = { counterpartyNameNormalized: string; contactId: string };

/** A standing "no document needed" rule for a normalized counterparty name (Digipost's
 * `PaymentNoDocumentRuleRow`). */
export type LedgerSourceNoDocumentRuleRow = { counterpartyNameNormalized: string };

/** One movement on a bank money account, for comparing the ledger with the bank. */
export type LedgerSourceBankMovementRow = { transactionId: string; accountId: string; bookingDate: string; amountCents: number };

export interface LedgerSourceReader {
  // Documents
  /** Every document of the tenant (`repos.document.listForLedger`). */
  listDocumentsForLedger(tenantId: string): Promise<LedgerSourceDocumentRow[]>;
  documentExists(tenantId: string, documentId: string): Promise<boolean>;
  /** The counterparties linked to a document (`repos.documentContact.listForDocument`). */
  listDocumentContacts(tenantId: string, documentId: string): Promise<LedgerSourceDocumentContactRow[]>;
  /** Bookable documents (invoices, receipts, platform reports: `LEDGER_BOOKABLE_DOCUMENT_KINDS`),
   * done, not rejected, whose effective date lies in the period, oldest first. The ledger itself
   * leaves out the ones an entry already books or dismissed. */
  listBookableDocumentIds(tenantId: string, period: { from: string; to: string }): Promise<string[]>;

  // Money accounts and movements
  /** Every bank and clearing account (`repos.account.listForWorkspace`). */
  listMoneyAccounts(tenantId: string): Promise<LedgerSourceMoneyAccountRow[]>;
  /** Every bank and clearing account with its contact's name, oldest first. */
  listSourceAccounts(tenantId: string): Promise<LedgerSourceAccountRow[]>;
  /** Every movement on a bank account, oldest first (`repos.transaction.listForLedger`). */
  listTransactionsForLedger(tenantId: string): Promise<LedgerSourceTransactionRow[]>;
  findTransactionById(tenantId: string, transactionId: string): Promise<LedgerSourceTransactionDetail | null>;
  transactionExists(tenantId: string, transactionId: string): Promise<boolean>;
  /** Every movement on a bank account booked up to `to`, oldest first. */
  listBankMovements(tenantId: string, to: string): Promise<LedgerSourceBankMovementRow[]>;
  /** Per bank account: the opening balance of its earliest statement that states one. */
  listBankOpeningBalances(tenantId: string): Promise<Map<string, number>>;
  /** Movements on bank accounts in the period, oldest first. The ledger itself leaves out the
   * ones a booked entry references. */
  listBankTransactionIds(tenantId: string, period: { from: string; to: string }): Promise<string[]>;
  /** Every settlement line (`repos.settlementLine.listForLedger`). */
  listSettlementLinesForLedger(tenantId: string): Promise<LedgerSourceSettlementLineRow[]>;

  // Invoices the platform issued
  /** Newest first, at most `limit` (`repos.invoice.listInvoices`). */
  listInvoices(tenantId: string, limit: number): Promise<LedgerSourceInvoiceRow[]>;

  // Counterparties
  /** `repos.contact.listAllForWorkspace`. */
  listContacts(tenantId: string): Promise<LedgerSourceContactRow[]>;
  /** `repos.contact.findById`. */
  findContactById(tenantId: string, contactId: string): Promise<LedgerSourceContactRow | null>;
  /** `repos.paymentAlias.listForWorkspace`. */
  listPaymentAliases(tenantId: string): Promise<LedgerSourcePaymentAliasRow[]>;
  /** `repos.paymentNoDocumentRule.listForWorkspace`. */
  listNoDocumentRules(tenantId: string): Promise<LedgerSourceNoDocumentRuleRow[]>;
}

const none = async () => [];

/** Phase 1: no sources. Every list is empty and nothing exists, so an entry that names a document
 * or a transaction is refused with `source_not_found`, and the proposal engine proposes nothing. */
export const emptySourceReader: LedgerSourceReader = {
  listDocumentsForLedger: none,
  documentExists: async () => false,
  listDocumentContacts: none,
  listBookableDocumentIds: none,
  listMoneyAccounts: none,
  listSourceAccounts: none,
  listTransactionsForLedger: none,
  findTransactionById: async () => null,
  transactionExists: async () => false,
  listBankMovements: none,
  listBankOpeningBalances: async () => new Map(),
  listBankTransactionIds: none,
  listSettlementLinesForLedger: none,
  listInvoices: none,
  listContacts: none,
  findContactById: async () => null,
  listPaymentAliases: none,
  listNoDocumentRules: none,
};
