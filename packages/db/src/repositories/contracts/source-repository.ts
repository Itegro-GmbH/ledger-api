// The sources' repository (decisions/0001-ledger-api.md, "What the service owns, and what platforms
// send"): counterparties, money accounts and movements, settlement lines, movement-to-document
// links, payment aliases, no-document rules and documents. Contracts only.
//
// Every method takes the caller's resolved `tenantId` first and filters on it; a row of another
// tenant is never found, never updated and never linked. Business rules (which owner a clearing
// account may have, how much of a movement a document may claim) live in
// `use-cases/source-use-cases.ts`. The ledger reads these tables through the
// `LedgerSourceReader` (`sources/drizzle-source-reader.ts`), not through this contract.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type { accounts, contacts, documents, documentTransactions, importBatches, settlementLines, transactions } from "../../schema/sources";

export type ContactRow = InferSelectModel<typeof contacts>;
export type MoneyAccountRow = InferSelectModel<typeof accounts>;
export type TransactionRow = InferSelectModel<typeof transactions>;
export type ImportBatchRow = InferSelectModel<typeof importBatches>;
export type SettlementLineRow = InferSelectModel<typeof settlementLines>;
export type DocumentTransactionRow = InferSelectModel<typeof documentTransactions>;
export type DocumentRow = InferSelectModel<typeof documents>;

type Owned<T> = Omit<T, "tenantId" | "createdAt" | "updatedAt">;

/** A contact as written: every column but the tenant and the timestamps; `id` optional (a caller
 * may keep its own). The normalized matching columns are computed by the use case. */
export type ContactWrite = Owned<InferInsertModel<typeof contacts>>;
export type MoneyAccountWrite = Owned<InferInsertModel<typeof accounts>>;
export type MoneyAccountPatch = Partial<Pick<MoneyAccountWrite, "name" | "iban" | "bic" | "currency" | "holder">>;
/** `id` only to keep an existing one; generated otherwise. */
export type TransactionWrite = Omit<InferInsertModel<typeof transactions>, "tenantId" | "accountId" | "createdAt" | "noDocumentNeeded">;
export type ImportBatchWrite = Omit<InferInsertModel<typeof importBatches>, "tenantId" | "createdAt" | "id">;
export type SettlementLineWrite = Omit<InferInsertModel<typeof settlementLines>, "tenantId" | "createdAt">;
export type DocumentWrite = Owned<InferInsertModel<typeof documents>> & { id: string };

/** A movement with the confirmed links that pay a document with it. */
export type TransactionWithLinks = TransactionRow & { links: { documentId: string; allocatedAmountCents: number }[] };

/** A document with its confirmed links and the payment status they give (`not_applicable`
 * without a total; else `paid`, `partially_paid` or `open`, and `overdue` for an unpaid one past
 * its due date). */
export type DocumentWithLinks = DocumentRow & { paymentStatus: string; links: { transactionId: string; allocatedAmountCents: number }[] };

export type Page<T> = { items: T[]; total: number };
export type Paging = { offset: number; limit: number };

export type TransactionFilter = {
  accountId?: string;
  from?: string;
  to?: string;
  /** Case-insensitive substring of the counterparty name or the remittance text. */
  search?: string;
  /** Only movements with no confirmed link that are not marked "no document needed". */
  unlinked?: boolean;
};

export type DocumentFilter = { from?: string; to?: string; kind?: string; direction?: string; contactId?: string };

export type LinkWrite = {
  documentId: string;
  transactionId: string;
  allocatedAmountCents: number;
  matchedBy: "auto" | "ai" | "user";
  decidedByUserId: string | null;
};

export interface SourceRepository {
  // Counterparties
  /** Inserts `contact`, or (same id, same tenant) applies `patch` to the existing row. `null` when
   * the id belongs to another tenant. */
  upsertContact(tenantId: string, contact: ContactWrite, patch: Partial<ContactWrite>): Promise<{ row: ContactRow; created: boolean } | null>;
  listContacts(tenantId: string, filter: { search?: string }, paging: Paging): Promise<Page<ContactRow>>;
  /** The contacts among `ids` that belong to the tenant. */
  findContacts(tenantId: string, ids: readonly string[]): Promise<ContactRow[]>;

  // Money accounts
  insertMoneyAccount(tenantId: string, account: MoneyAccountWrite): Promise<MoneyAccountRow>;
  updateMoneyAccount(tenantId: string, id: string, patch: MoneyAccountPatch): Promise<MoneyAccountRow | null>;
  findMoneyAccount(tenantId: string, id: string): Promise<MoneyAccountRow | null>;
  /** Oldest first, each with its movement count and the sum of its movements. */
  listMoneyAccounts(tenantId: string): Promise<(MoneyAccountRow & { movementCount: number; balanceCents: number })[]>;

  // Movements
  /** Inserts each movement unless its account already holds its idempotency key; a known one keeps
   * its date, amount and currency and only has its descriptive columns refreshed. In input order. */
  upsertTransactions(tenantId: string, accountId: string, rows: readonly TransactionWrite[]): Promise<{ row: TransactionRow; created: boolean }[]>;
  /** Inserts the batch, or (same source document, same tenant) replaces its figures: one batch
   * per source document. `null` when that document's batch belongs to another tenant. */
  upsertImportBatch(tenantId: string, batch: ImportBatchWrite): Promise<ImportBatchRow | null>;
  /** The bank money accounts of the tenant with this (normalized) IBAN. */
  findMoneyAccountByIban(tenantId: string, iban: string): Promise<MoneyAccountRow | null>;
  /** Points the given movements (of the tenant) at an import batch. */
  setImportBatch(tenantId: string, transactionIds: readonly string[], importBatchId: string): Promise<void>;
  /** Newest booking date first. */
  listTransactions(tenantId: string, filter: TransactionFilter, paging: Paging): Promise<Page<TransactionWithLinks>>;
  findTransactions(tenantId: string, ids: readonly string[]): Promise<TransactionRow[]>;
  /** Sets the marker on the given movements of the tenant; returns how many changed. */
  setNoDocumentNeeded(tenantId: string, ids: readonly string[], value: boolean): Promise<number>;
  /** Movements with a counterparty name that no confirmed link explains and that are not marked
   * yet (what a standing no-document rule applies to). */
  listUnexplainedTransactionNames(tenantId: string): Promise<{ id: string; counterpartyName: string }[]>;
  /** Inserts settlement lines, idempotent by (report document, external line id). */
  upsertSettlementLines(tenantId: string, lines: readonly SettlementLineWrite[]): Promise<SettlementLineRow[]>;

  // Movement to document links
  /** Confirms the link (creating it or confirming and re-allocating an existing row of the
   * tenant). `null` when the pair is held by another tenant. */
  confirmLink(tenantId: string, link: LinkWrite): Promise<DocumentTransactionRow | null>;
  findConfirmedLink(tenantId: string, documentId: string, transactionId: string): Promise<DocumentTransactionRow | null>;
  /** Deletes the confirmed link; `false` when there is none. */
  deleteConfirmedLink(tenantId: string, documentId: string, transactionId: string): Promise<boolean>;
  /** Per document: the sum its confirmed links allocate. */
  sumConfirmedByDocument(tenantId: string, documentIds: readonly string[]): Promise<Map<string, number>>;
  /** Per movement: the sum its confirmed links allocate. */
  sumConfirmedByTransaction(tenantId: string, transactionIds: readonly string[]): Promise<Map<string, number>>;

  // Payment names and no-document rules
  /** One alias per normalized name; the latest wins. */
  upsertPaymentAlias(tenantId: string, alias: { counterpartyNameNormalized: string; contactId: string; learnedFromUserId: string | null }): Promise<void>;
  upsertNoDocumentRule(tenantId: string, rule: { counterpartyNameNormalized: string; createdByUserId: string | null }): Promise<void>;

  // Documents
  /** Inserts the document, or (same id, same tenant) replaces its accounting view. `null` when the
   * id belongs to another tenant. */
  upsertDocument(tenantId: string, document: DocumentWrite): Promise<{ row: DocumentRow; created: boolean } | null>;
  /** Newest effective date first. */
  listDocuments(tenantId: string, filter: DocumentFilter, paging: Paging): Promise<Page<DocumentWithLinks>>;
  findDocuments(tenantId: string, ids: readonly string[]): Promise<DocumentRow[]>;
}
