// The ledger's repository (Digipost decisions/0080-ledger-double-entry-bookkeeping.md). Contracts
// only: no Drizzle import besides type-only schema references.
//
// Every method takes the caller's resolved `tenantId` first and filters on it. Reads of the
// ledger's sources (documents, money accounts and movements) are not here: they go through the
// `LedgerSourceReader` port (`sources/source-reader.ts`).
import type { InferSelectModel } from "drizzle-orm";

import type {
  DatevTenantSettings,
  BookingAdviceRaw,
  BookingRuleDirection,
  EntrySnapshot,
  FilingKind,
  FilingStatus,
  JournalEntryOrigin,
  JournalEntryStatus,
  LedgerAccountGroup,
  LedgerAccountKind,
  LedgerOwnerType,
  OpenItemMatchKind,
  ProposalWarningCode,
  RevisionChangeKind,
  TaxCode,
  TaxRole,
  VatBasis,
  VatPeriod,
} from "@ledger/core";
import type {
  journalEntries,
  journalEntryRevisions,
  journalLines,
  ledgerAccounts,
  ledgerAdvisorBalanceLines,
  ledgerAdvisorBalances,
  ledgerBookingAdvice,
  ledgerBookingRules,
  ledgerFilings,
  ledgerHandovers,
  ledgerOpenItemMatches,
  ledgerSettings,
} from "../../schema/ledger";

export type LedgerSettingsRow = InferSelectModel<typeof ledgerSettings>;
export type LedgerAccountRow = InferSelectModel<typeof ledgerAccounts>;
export type JournalEntryRow = InferSelectModel<typeof journalEntries>;
export type JournalLineRow = InferSelectModel<typeof journalLines>;
export type JournalEntryRevisionRow = InferSelectModel<typeof journalEntryRevisions>;
export type LedgerOpenItemMatchRow = InferSelectModel<typeof ledgerOpenItemMatches>;
export type LedgerBookingRuleRow = InferSelectModel<typeof ledgerBookingRules>;
export type LedgerFilingRow = InferSelectModel<typeof ledgerFilings>;
export type LedgerHandoverRow = InferSelectModel<typeof ledgerHandovers>;
export type LedgerAdvisorBalanceRow = InferSelectModel<typeof ledgerAdvisorBalances>;
export type LedgerAdvisorBalanceLineRow = InferSelectModel<typeof ledgerAdvisorBalanceLines>;
export type LedgerBookingAdviceRow = InferSelectModel<typeof ledgerBookingAdvice>;

export type LedgerSettingsPatch = { enabled: boolean; vatPeriod: VatPeriod; vatBasis: VatBasis; startDate: string | null };

export type CreateLedgerAccountRow = {
  tenantId: string;
  number: string;
  name: string;
  kind: LedgerAccountKind;
  group: LedgerAccountGroup;
  openItems: boolean;
  ownerType: LedgerOwnerType | null;
  ownerBankAccountId: string | null;
  ownerContactId: string | null;
  ownerPlatform: string | null;
  ownerPersonName: string | null;
  description: string | null;
};

export type LedgerAccountPatch = Partial<
  Pick<LedgerAccountRow, "name" | "group" | "openItems" | "description" | "archivedAt" | "ownerType" | "ownerBankAccountId" | "ownerContactId" | "ownerPlatform" | "ownerPersonName">
>;

export type CreateJournalEntryRow = {
  id?: string;
  tenantId: string;
  bookingDate: string;
  documentDate: string | null;
  serviceDate: string | null;
  text: string;
  status: JournalEntryStatus;
  origin: JournalEntryOrigin;
  originReason: string | null;
  sourceKey: string | null;
  documentId: string | null;
  transactionId: string | null;
  correctionOfEntryId: string | null;
  filingId: string | null;
  warnings: ProposalWarningCode[];
  userEditedAt: Date | null;
  bookedAt: Date | null;
  bookedByUserId: string | null;
};

export type JournalEntryPatch = Partial<Omit<CreateJournalEntryRow, "id" | "tenantId" | "sourceKey">> & {
  dismissedAt?: Date | null;
  revision?: number;
};

export type CreateJournalLineRow = {
  position: number;
  accountId: string;
  amountCents: number;
  taxCode: TaxCode | null;
  taxRole: TaxRole | null;
  generatedFromLinePosition: number | null;
  documentId: string | null;
  text: string | null;
};

/** A line with the number and name of its account. */
export type JournalLineWithAccount = JournalLineRow & { accountNumber: string; accountName: string };

export type CreateRevisionRow = {
  tenantId: string;
  entryId: string | null;
  entryRef: string;
  revision: number;
  changeKind: RevisionChangeKind;
  reason: string | null;
  bookingDate: string;
  snapshot: EntrySnapshot | null;
  changedByUserId: string | null;
};

export type JournalEntryFilter = {
  from?: string;
  to?: string;
  status?: JournalEntryStatus;
  origin?: JournalEntryOrigin;
  accountId?: string;
  /** Entries whose source document is this one. */
  documentId?: string;
  changedSince?: Date;
  dismissed: "exclude" | "include" | "only";
  limit: number;
};

/** A booked (or, on request, proposed) line joined with its entry and account, for reports. */
export type LedgerReportLineRow = {
  lineId: string;
  entryId: string;
  position: number;
  accountId: string;
  accountNumber: string;
  bookingDate: string;
  amountCents: number;
  taxCode: TaxCode | null;
  taxRole: TaxRole | null;
  text: string | null;
  entryText: string;
  documentId: string | null;
  transactionId: string | null;
  status: JournalEntryStatus;
  /** The line's own open-item reference (`journal_lines.document_id`). */
  lineDocumentId: string | null;
};

/** A booked line on an open-item account that no match holds yet. */
export type UnmatchedOpenItemLineRow = { lineId: string; accountId: string; amountCents: number; documentId: string | null; bookingDate: string };

export type LedgerEntryCounts = { booked: number; proposed: number; unbalancedProposed: number };

export type SourceKeyRow = { sourceKey: string; entryId: string; status: JournalEntryStatus; dismissedAt: Date | null; userEditedAt: Date | null };

export type CreateBookingRuleRow = {
  tenantId: string;
  contactId: string | null;
  counterpartyPattern: string | null;
  direction: BookingRuleDirection;
  accountId: string;
  taxCode: TaxCode | null;
  paymentAccountId: string | null;
  noDocument: boolean;
  active: boolean;
  learnedFromEntryId: string | null;
};

export type CreateFilingRow = {
  tenantId: string;
  kind: FilingKind;
  status: FilingStatus;
  periodFrom: string;
  periodTo: string;
  submittedOn: string | null;
  amountCents: number | null;
  correctsFilingId: string | null;
  note: string | null;
  createdByUserId: string | null;
};

export interface LedgerRepository {
  // Settings
  findSettings(tenantId: string): Promise<LedgerSettingsRow | null>;
  upsertSettings(tenantId: string, patch: LedgerSettingsPatch): Promise<LedgerSettingsRow>;
  /** Stores the DATEV export's settings on an existing settings row; `false` without one. */
  setDatevSettings(tenantId: string, settings: DatevTenantSettings): Promise<boolean>;

  // Chart of accounts
  /** Number order, archived accounts included. */
  listAccounts(tenantId: string): Promise<LedgerAccountRow[]>;
  findAccountById(tenantId: string, id: string): Promise<LedgerAccountRow | null>;
  findAccountByNumber(tenantId: string, number: string): Promise<LedgerAccountRow | null>;
  insertAccount(row: CreateLedgerAccountRow): Promise<LedgerAccountRow>;
  /** Inserts what is missing; an account whose number already exists is left as it is. */
  insertAccountsIfMissing(rows: CreateLedgerAccountRow[]): Promise<LedgerAccountRow[]>;
  updateAccount(tenantId: string, id: string, patch: LedgerAccountPatch): Promise<LedgerAccountRow | null>;
  countLinesForAccount(tenantId: string, accountId: string): Promise<number>;

  // Journal
  insertEntry(row: CreateJournalEntryRow): Promise<JournalEntryRow>;
  /** `forUpdate` locks the row until the transaction ends (`SELECT ... FOR UPDATE`): a
   * read-then-write that must not interleave with another writer. */
  findEntry(tenantId: string, id: string, options?: { forUpdate?: boolean }): Promise<JournalEntryRow | null>;
  findEntryBySourceKey(tenantId: string, sourceKey: string, options?: { forUpdate?: boolean }): Promise<JournalEntryRow | null>;
  /** `null` when no row matched: not found, or, with a condition, changed since it was read.
   * `expectedRevision`: only while the entry is still at that revision. `untouchedProposal`: only
   * while it is a proposal no human booked, edited or dismissed (the proposal engine's write). */
  updateEntry(tenantId: string, id: string, patch: JournalEntryPatch, condition?: { expectedRevision?: number; untouchedProposal?: boolean }): Promise<JournalEntryRow | null>;
  deleteEntry(tenantId: string, id: string): Promise<boolean>;
  /** Newest booking date first. */
  listEntries(tenantId: string, filter: JournalEntryFilter): Promise<JournalEntryRow[]>;
  /** Makes the entry's lines `lines`. Identical lines are left alone. A line whose position,
   * account, amount and document stay the same is updated in place (its id, and so its
   * open-item match, survives); every other old line is deleted, and an open-item match holding
   * one of those is dissolved as a whole: a changed line no longer settles what it settled.
   * Returns how many matches were dissolved. */
  replaceLines(tenantId: string, entryId: string, lines: CreateJournalLineRow[]): Promise<{ lines: JournalLineRow[]; dissolvedMatches: number }>;
  /** Position order per entry. */
  listLines(tenantId: string, entryIds: string[]): Promise<JournalLineWithAccount[]>;
  /** Every line of every entry with `status` (default booked) up to `to`, oldest first. */
  listReportLines(tenantId: string, options: { to?: string; statuses?: JournalEntryStatus[] }): Promise<LedgerReportLineRow[]>;
  countEntries(tenantId: string, period: { from: string; to: string }): Promise<LedgerEntryCounts>;
  listSourceKeys(tenantId: string, prefix?: string): Promise<SourceKeyRow[]>;

  // Revisions
  insertRevision(row: CreateRevisionRow): Promise<JournalEntryRevisionRow>;
  /** Oldest first. */
  listRevisions(tenantId: string, entryRef: string): Promise<JournalEntryRevisionRow[]>;
  /** Revisions written after `since` for entries booked (before or after the change) in the period. */
  countRevisionsSince(tenantId: string, period: { from: string; to: string }, since: Date): Promise<number>;

  // Open items
  insertMatch(row: { tenantId: string; accountId: string; kind: OpenItemMatchKind; note: string | null; createdByUserId: string | null }, lineIds: string[]): Promise<LedgerOpenItemMatchRow>;
  findMatch(tenantId: string, id: string): Promise<LedgerOpenItemMatchRow | null>;
  deleteMatch(tenantId: string, id: string): Promise<boolean>;
  /** Dissolves every match holding a line of the entry (before it is unbooked or deleted). */
  deleteMatchesForEntry(tenantId: string, entryId: string): Promise<number>;
  listMatches(tenantId: string, accountId?: string): Promise<Array<LedgerOpenItemMatchRow & { lineIds: string[] }>>;
  /** Which of these lines already belong to a match. */
  findMatchedLineIds(tenantId: string, lineIds: string[]): Promise<string[]>;
  /** The lines with their entry's status, for a match's checks. */
  findLines(tenantId: string, lineIds: string[]): Promise<Array<JournalLineRow & { entryStatus: JournalEntryStatus }>>;
  /** Booked lines on open-item accounts (one account, or all) that belong to no match yet. */
  listUnmatchedOpenItemLines(tenantId: string, accountId?: string): Promise<UnmatchedOpenItemLineRow[]>;

  // Booking rules
  listRules(tenantId: string): Promise<LedgerBookingRuleRow[]>;
  findRule(tenantId: string, id: string): Promise<LedgerBookingRuleRow | null>;
  insertRule(row: CreateBookingRuleRow): Promise<LedgerBookingRuleRow>;
  updateRule(tenantId: string, id: string, patch: Omit<CreateBookingRuleRow, "tenantId">): Promise<LedgerBookingRuleRow | null>;
  deleteRule(tenantId: string, id: string): Promise<boolean>;
  /** One more booked proposal that came from this rule. */
  incrementRuleHits(tenantId: string, id: string): Promise<void>;

  // The AI booking advisor's answers (decisions/0080 phase 3)
  /** The stored answer per document, whatever question it answered (the caller compares the key). */
  listBookingAdvice(tenantId: string, documentIds: string[]): Promise<LedgerBookingAdviceRow[]>;
  /** Inserts or replaces the answer for the document. */
  upsertBookingAdvice(row: { tenantId: string; documentId: string; cacheKey: string; answer: BookingAdviceRaw }): Promise<void>;

  // Filings
  /** Newest period first. */
  listFilings(tenantId: string): Promise<LedgerFilingRow[]>;
  findFiling(tenantId: string, id: string): Promise<LedgerFilingRow | null>;
  insertFiling(row: CreateFilingRow): Promise<LedgerFilingRow>;
  /** Refused by the database for a submitted filing. */
  updateFiling(tenantId: string, id: string, patch: { status?: FilingStatus; submittedOn?: string | null; amountCents?: number | null; note?: string | null }): Promise<LedgerFilingRow | null>;
  /** The submitted filing that locks a booked entry on `date`, honoring a draft correction
   * named by `filingId` the same way the database trigger does; `null` when editable. */
  findLockingFiling(tenantId: string, date: string, filingId: string | null): Promise<LedgerFilingRow | null>;

  // Handovers
  insertHandover(row: { tenantId: string; periodFrom: string; periodTo: string; note: string | null; createdByUserId: string | null }): Promise<LedgerHandoverRow>;
  /** Newest first. */
  listHandovers(tenantId: string): Promise<LedgerHandoverRow[]>;

  // Tax advisor's balance lists
  insertAdvisorUpload(
    row: { tenantId: string; periodFrom: string; periodTo: string; fileName: string | null; uploadedByUserId: string | null },
    lines: { accountNumber: string; accountName: string | null; balanceCents: number }[],
  ): Promise<LedgerAdvisorBalanceRow>;
  /** Newest first, with the number of lines each. */
  listAdvisorUploads(tenantId: string): Promise<Array<LedgerAdvisorBalanceRow & { lineCount: number }>>;
  findAdvisorUpload(tenantId: string, id: string): Promise<LedgerAdvisorBalanceRow | null>;
  listAdvisorLines(tenantId: string, uploadId: string): Promise<LedgerAdvisorBalanceLineRow[]>;
  deleteAdvisorUpload(tenantId: string, id: string): Promise<boolean>;

  // What the entries reference (the controls leave these sources out)
  /** Transactions a booked entry references. */
  listBookedTransactionIds(tenantId: string): Promise<Set<string>>;
  /** Documents an entry references that is booked or dismissed. */
  listDecidedDocumentIds(tenantId: string): Promise<Set<string>>;
}
