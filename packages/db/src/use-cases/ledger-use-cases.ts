// The ledger's use cases (Digipost decisions/0080-ledger-double-entry-bookkeeping.md, moved here
// by decisions/0001-ledger-api.md): settings and the seeded SKR 04 chart, journal entries with
// their revisions, booking, the open-item matches, booking rules, filings and the lock they set,
// handovers to the tax advisor, her uploaded balance lists, and every report and control over the
// books.
//
// Every method takes the caller's own resolved tenant id (resolved once, from the platform key
// and `Ledger-Tenant`), never one from a request body, and throws `LEDGER_ERROR.disabled` while
// the ledger is off for that tenant (except reading and saving the settings). Ids from the client
// (entry, account, filing, match) are only ever looked up within that tenant.
//
// Every change to an entry writes a revision holding the entry and its lines as they were
// before, in the same transaction. Editing, unbooking or deleting a booked entry needs a reason.
// The database is the authority on the two hard rules (a booked entry balances, an entry inside
// a submitted filing period is locked): the use case checks both first for a clear error, and
// maps the trigger's own refusal (`ledger_unbalanced`, `ledger_locked`) to the same codes.
//
// The ledger's sources (documents, money accounts and movements, settlement lines, issued
// invoices, counterparties) are read through the `LedgerSourceReader` port (`deps.sources`);
// nothing here writes them.
//
// The proposal engine (Digipost decisions/0080 phase 3): `syncProposals` reads every source through
// the source reader into a snapshot, asks the AI booking advisor (with a per-document answer
// cache) only about incoming documents no rule covers, lets the pure engine
// (`@ledger/core`'s `buildProposals`) draft the entries and writes them through
// `upsertProposal`, keyed by source: a booked, dismissed or human-edited entry is never
// overwritten. Afterwards (and after every booking) `autoMatchOpenItems` matches the lines of an
// open-item account that book and pay the same document and sum to zero; anything else is only
// suggested (`suggestMatches`).
import {
  type BankBalanceComparison,
  adviceQuestionsFor,
  BANK_ACCOUNT_NUMBERS,
  bookingAdviceCacheKey,
  buildProposals,
  counterpartyPatternOf,
  deriveRuleFromEntry,
  findAutoMatches,
  invoiceVatGroups,
  platformDisplayName,
  suggestMatchGroups,
  toCacheableBookingAdvice,
  validateBookingAdvice,
  bankLedgerAccountText,
  CONTACT_CLEARING_NUMBERS,
  contactLedgerAccountText,
  compareBankBalances,
  compareWithAdvisor,
  computeAccountSheet,
  computeBalances,
  computeControls,
  computeOpenItems,
  computeVatPreview,
  debitTotal,
  derivePeriodStatus,
  expandTaxLines,
  isBalanced,
  LEDGER_DB_RAISES,
  MAX_ADVISOR_FILE_BYTES,
  lineDifference,
  listEntriesFilterSchema,
  nextFreeNumber,
  parseDatevBalanceList,
  PLATFORM_RECEIVABLE_NUMBERS,
  priorYearsResult,
  ruleTaxCodeFits,
  platformLedgerAccountText,
  SKR04_SEED_ACCOUNTS,
  summarizeEntry,
  vatPeriodsOfYear,
  yearPeriod,
  type AccountSheet,
  type AdviceMap,
  type BookingAdvice,
  type BookingAdviceQuestion,
  type LedgerBookingAdvisor,
  type MatchSuggestion,
  type ProposalSnapshot,
  type SyncProposalsResult,
  type AdvisorComparison,
  type AdvisorUploadView,
  type BalanceList,
  type BookingRuleView,
  type ControlResult,
  type CreateAccountInput,
  type CreateFilingInput,
  type CreateMatchInput,
  type EntryInput,
  type EntrySnapshot,
  type ExpandedLine,
  type FilingRef,
  type FilingView,
  type HandoverView,
  type JournalEntryListItem,
  type JournalEntryRevisionView,
  type JournalEntryView,
  type JournalLineView,
  type LedgerAccountView,
  type LedgerSettingsView,
  type LedgerSourcesView,
  type LedgerUseCaseErrorCode,
  type ListEntriesFilter,
  type OpenItemAccountSummary,
  type OpenItems,
  type Period,
  type PeriodOverviewRow,
  type ProposalInput,
  type ReportAccount,
  type ReportLine,
  type RevisionChangeKind,
  type RuleInput,
  type SettingsInput,
  type SourceKeyState,
  type UpdateAccountInput,
  type VatPreview,
} from "@ledger/core";

import { UseCaseError } from "../errors";
import { dbErrorOf } from "../foundation/db-errors";
import type {
  CreateJournalLineRow,
  CreateLedgerAccountRow,
  JournalEntryRow,
  JournalLineWithAccount,
  LedgerAccountRow,
  LedgerBookingRuleRow,
  LedgerFilingRow,
  LedgerReportLineRow,
  LedgerSettingsRow,
  Repositories,
  UnitOfWork,
} from "../repositories/contracts";
import { normalizeName, resolveContactForCounterparty, type ContactAliasMap } from "../sources/contact-resolution";
import type { LedgerSourceBankMovementRow, LedgerSourceReader } from "../sources/source-reader";

export const LEDGER_ERROR = {
  disabled: "disabled",
  notFound: "not_found",
  accountNotFound: "account_not_found",
  accountArchived: "account_archived",
  accountNumberTaken: "account_number_taken",
  ownerNotFound: "owner_not_found",
  ownerTaken: "owner_taken",
  sourceNotFound: "source_not_found",
  unbalanced: "unbalanced",
  locked: "locked",
  reasonRequired: "reason_required",
  staleRevision: "stale_revision",
  alreadyBooked: "already_booked",
  notBooked: "not_booked",
  notProposed: "not_proposed",
  invalidFiling: "invalid_filing",
  filingChoiceRequired: "filing_choice_required",
  filingOverlaps: "filing_overlaps",
  filingNotDraft: "filing_not_draft",
  filingNotSubmitted: "filing_not_submitted",
  correctionExists: "correction_exists",
  accountNotOpenItems: "account_not_open_items",
  lineNotOnAccount: "line_not_on_account",
  lineAlreadyMatched: "line_already_matched",
  matchNotZero: "match_not_zero",
  advisorFileInvalid: "advisor_file_invalid",
  ruleSourceMissing: "rule_source_missing",
} as const satisfies Record<string, LedgerUseCaseErrorCode>;
export type LedgerErrorCode = (typeof LEDGER_ERROR)[keyof typeof LEDGER_ERROR];

const DEFAULT_SETTINGS: LedgerSettingsView = { enabled: false, vatPeriod: "month", vatBasis: "soll", startDate: null, chart: "skr04" };

export type ProposalOutcome = "created" | "updated" | "kept";

export type BulkBookResult = { booked: string[]; failed: { entryId: string; errorCode: LedgerErrorCode | "unknown" }[] };

export type AdvisorComparisonView = { upload: AdvisorUploadView; comparison: AdvisorComparison };

export interface LedgerUseCases {
  // Settings
  getSettings(tenantId: string): Promise<LedgerSettingsView>;
  isEnabled(tenantId: string): Promise<boolean>;
  /** Saves the settings; turning the ledger on seeds the chart (idempotent, see `syncChart`). */
  setSettings(input: { tenantId: string; settings: SettingsInput }): Promise<LedgerSettingsView>;
  /** Adds what is missing to the chart: the SKR 04 seed, one ledger account per bank money
   * account (1800, 1810, ...), per platform clearing account (1370 ff.) and per contact clearing
   * account (1461 ff.). Never changes or removes an existing account's number. */
  syncChart(tenantId: string): Promise<LedgerAccountView[]>;

  // Chart of accounts
  listAccounts(tenantId: string): Promise<LedgerAccountView[]>;
  createAccount(input: { tenantId: string; account: CreateAccountInput }): Promise<LedgerAccountView>;
  updateAccount(input: { tenantId: string; account: UpdateAccountInput }): Promise<LedgerAccountView>;
  setAccountArchived(input: { tenantId: string; accountId: string; archived: boolean }): Promise<LedgerAccountView>;

  // Journal
  listEntries(tenantId: string, filter?: ListEntriesFilter): Promise<JournalEntryListItem[]>;
  getEntry(tenantId: string, entryId: string): Promise<JournalEntryView | null>;
  /** Proposals waiting for review (not dismissed, any date): the navigation's badge. */
  countWaitingProposals(tenantId: string): Promise<number>;
  /** The documents and bank transactions an entry or the review queue points at, read through
   * the source reader (never written). An id not found (deleted, or of another tenant) is simply
   * absent, so the UI can say "Beleg gelöscht". */
  getSources(tenantId: string, input: { documentIds: readonly string[]; transactionIds: readonly string[] }): Promise<LedgerSourcesView>;
  /** A manual entry, proposed, or booked at once with `book`. */
  createEntry(input: { tenantId: string; userId: string; entry: EntryInput; book: boolean }): Promise<{ entryId: string }>;
  updateEntry(input: { tenantId: string; userId: string; entryId: string; entry: EntryInput; reason?: string | null; expectedRevision?: number }): Promise<{ entryId: string; revision: number }>;
  deleteEntry(input: { tenantId: string; userId: string; entryId: string; reason?: string | null }): Promise<void>;
  bookEntry(input: { tenantId: string; userId: string; entryId: string }): Promise<void>;
  unbookEntry(input: { tenantId: string; userId: string; entryId: string; reason?: string | null }): Promise<void>;
  /** Books each entry in its own transaction; one that fails does not hold back the others. */
  bulkBook(input: { tenantId: string; userId: string; entryIds: string[] }): Promise<BulkBookResult>;
  /** "Verwerfen": the proposal stays with its source key, so the source is not proposed again. */
  dismissProposal(input: { tenantId: string; userId: string; entryId: string }): Promise<void>;
  restoreProposal(input: { tenantId: string; userId: string; entryId: string }): Promise<void>;
  /** The proposal engine's write path, idempotent by `sourceKey`. */
  upsertProposal(input: { tenantId: string; proposal: ProposalInput }): Promise<{ entryId: string; outcome: ProposalOutcome }>;
  listSourceKeys(tenantId: string, prefix?: string): Promise<SourceKeyState[]>;

  // Reports
  getBalances(tenantId: string, period: Period): Promise<BalanceList>;
  /** The Kontenblatt. Proposals are listed (dashed in the UI) and count toward the balance only
   * with `countProposals` ("Vorschläge einrechnen"). */
  getAccountSheet(tenantId: string, input: { accountNumber: string; from: string; to: string; countProposals?: boolean }): Promise<AccountSheet | null>;
  /** Booked-only account sheets of several accounts in one read (the advisor comparison's
   * differing rows). Unknown numbers are left out. */
  getAccountSheets(tenantId: string, input: { accountNumbers: readonly string[]; from: string; to: string }): Promise<AccountSheet[]>;
  /** Per bank ledger account: does it match the real bank balance on every day up to `period.to`,
   * and from which day on does it not (the "Konten" page's chips). */
  getBankComparisons(tenantId: string, period: Period): Promise<BankBalanceComparison[]>;
  getOpenItems(tenantId: string, input: { accountNumber: string; asOf: string }): Promise<(OpenItems & { account: LedgerAccountView }) | null>;
  listOpenItemAccounts(tenantId: string, asOf: string): Promise<OpenItemAccountSummary[]>;
  getVatPreview(tenantId: string, period: Period): Promise<VatPreview>;
  getControls(tenantId: string, period: Period): Promise<ControlResult[]>;
  getPeriodOverview(tenantId: string, year: number): Promise<PeriodOverviewRow[]>;

  // Open items
  createMatch(input: { tenantId: string; userId: string; match: CreateMatchInput }): Promise<{ matchId: string }>;
  deleteMatch(input: { tenantId: string; matchId: string }): Promise<void>;

  // Booking rules
  listRules(tenantId: string): Promise<BookingRuleView[]>;
  createRule(input: { tenantId: string; rule: RuleInput }): Promise<BookingRuleView>;
  updateRule(input: { tenantId: string; ruleId: string; rule: RuleInput }): Promise<BookingRuleView>;
  deleteRule(input: { tenantId: string; ruleId: string }): Promise<void>;

  // Filings
  listFilings(tenantId: string): Promise<FilingView[]>;
  createFiling(input: { tenantId: string; userId: string; filing: CreateFilingInput }): Promise<FilingView>;
  submitFiling(input: { tenantId: string; filingId: string; submittedOn: string; amountCents?: number | null }): Promise<FilingView>;
  /** "Berichtigte Meldung anlegen": a draft for the same period; entries tied to it may change. */
  createCorrectionFiling(input: { tenantId: string; userId: string; filingId: string }): Promise<FilingView>;

  // Handovers
  createHandover(input: { tenantId: string; userId: string; periodFrom: string; periodTo: string; note?: string | null }): Promise<HandoverView>;
  listHandovers(tenantId: string): Promise<HandoverView[]>;

  // The tax advisor's balance lists
  uploadAdvisorBalances(input: { tenantId: string; userId: string; periodFrom: string; periodTo: string; fileName?: string | null; csvText: string }): Promise<AdvisorUploadView>;
  listAdvisorUploads(tenantId: string): Promise<AdvisorUploadView[]>;
  getAdvisorComparison(tenantId: string, uploadId: string): Promise<AdvisorComparisonView | null>;
  deleteAdvisorUpload(input: { tenantId: string; uploadId: string }): Promise<void>;

  // The proposal engine (Digipost decisions/0080 phase 3)
  /** Proposes an entry for every source the templates, rules and the AI can explain, keyed by
   * source, idempotent: a booked, edited or dismissed entry is never touched, an unchanged
   * proposal is kept as it is. Then applies the safe automatic open-item matches. */
  syncProposals(input: { tenantId: string; from?: string; to?: string }): Promise<SyncProposalsResult>;
  /** Asks `deps.scheduleSync` for one background sync of the tenant when the ledger is on. `true`
   * when the ledger is on. */
  scheduleSync(tenantId: string): Promise<boolean>;
  /** The automatic matches: lines of an open-item account booking and paying the same
   * document that sum to zero. Returns how many matches it created. */
  autoMatchOpenItems(tenantId: string): Promise<number>;
  /** Candidate groups for the open items of one account (never applied by themselves). */
  suggestMatches(tenantId: string, accountId: string): Promise<MatchSuggestion[]>;
  /** "Als Regel speichern": creates or updates the rule of the entry's contact or counterparty. */
  learnRuleFromEntry(input: { tenantId: string; entryId: string }): Promise<BookingRuleView>;
}

export type LedgerUseCaseDeps = {
  repos: Repositories;
  uow: UnitOfWork;
  /** Where documents, money accounts and movements, settlement lines, issued invoices and
   * counterparties are read (`emptySourceReader` while there are none). */
  sources: LedgerSourceReader;
  /** Queues one background `syncProposals` run for the tenant (deduplicated by the caller's job
   * queue). No-op by default: phase 1 has no job queue. */
  scheduleSync?: (tenantId: string) => Promise<void>;
  now?: () => Date;
  /** The AI that suggests an account for a document no rule covers. Without one, every such
   * document gets the template default with the `ai_unavailable` warning. */
  bookingAdvisor?: LedgerBookingAdvisor;
  /** Most questions one sync asks the advisor; the rest wait for the next run. */
  maxAdviceQuestionsPerSync?: number;
};

const noScheduler = async (_tenantId: string): Promise<void> => {};

/** Enough for a month of incoming mail in one run, small enough to stay inside a job's budget. */
export const MAX_ADVICE_QUESTIONS_PER_SYNC = 40;

// ---------------------------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------------------------

function toSettingsView(row: LedgerSettingsRow | null): LedgerSettingsView {
  if (!row) return DEFAULT_SETTINGS;
  return { enabled: row.enabled, vatPeriod: row.vatPeriod, vatBasis: row.vatBasis, startDate: row.startDate, chart: row.chart };
}

function toAccountView(row: LedgerAccountRow): LedgerAccountView {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    kind: row.kind,
    group: row.group,
    openItems: row.openItems,
    ownerType: row.ownerType,
    ownerBankAccountId: row.ownerBankAccountId,
    ownerContactId: row.ownerContactId,
    ownerPlatform: row.ownerPlatform,
    ownerPersonName: row.ownerPersonName,
    description: row.description,
    archived: row.archivedAt !== null,
  };
}

function toReportAccount(row: LedgerAccountRow): ReportAccount {
  return { id: row.id, number: row.number, name: row.name, kind: row.kind, group: row.group, openItems: row.openItems };
}

function toReportLine(row: LedgerReportLineRow): ReportLine {
  return {
    lineId: row.lineId,
    entryId: row.entryId,
    position: row.position,
    accountId: row.accountId,
    accountNumber: row.accountNumber,
    bookingDate: row.bookingDate,
    amountCents: row.amountCents,
    taxCode: row.taxCode,
    taxRole: row.taxRole,
    text: row.text,
    entryText: row.entryText,
    documentId: row.documentId,
    transactionId: row.transactionId,
    ...(row.status === "proposed" ? { proposed: true } : {}),
  };
}

function toLineView(row: JournalLineWithAccount): JournalLineView {
  return {
    id: row.id,
    position: row.position,
    accountId: row.accountId,
    accountNumber: row.accountNumber,
    accountName: row.accountName,
    amountCents: row.amountCents,
    taxCode: row.taxCode,
    taxRole: row.taxRole,
    generatedFromLinePosition: row.generatedFromLinePosition,
    documentId: row.documentId,
    text: row.text,
  };
}

function toFilingView(row: LedgerFilingRow): FilingView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    submittedOn: row.submittedOn,
    amountCents: row.amountCents,
    correctsFilingId: row.correctsFilingId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

function toFilingRef(row: LedgerFilingRow): FilingRef {
  return { id: row.id, kind: row.kind, periodFrom: row.periodFrom, periodTo: row.periodTo };
}

function snapshotOf(entry: JournalEntryRow, lines: readonly JournalLineWithAccount[]): EntrySnapshot {
  return {
    bookingDate: entry.bookingDate,
    documentDate: entry.documentDate,
    serviceDate: entry.serviceDate,
    text: entry.text,
    status: entry.status,
    origin: entry.origin,
    dismissed: entry.dismissedAt !== null,
    documentId: entry.documentId,
    transactionId: entry.transactionId,
    lines: lines.map((line) => ({ accountNumber: line.accountNumber, amountCents: line.amountCents, taxCode: line.taxCode, taxRole: line.taxRole, text: line.text, documentId: line.documentId })),
  };
}

/** Maps the database's own refusals to the use-case codes; anything else is rethrown. */
function translateDbError(err: unknown): never {
  if (err instanceof UseCaseError) throw err;
  const db = dbErrorOf(err);
  if (db.kind === "raised" && db.message === LEDGER_DB_RAISES.locked) throw new UseCaseError(LEDGER_ERROR.locked);
  if (db.kind === "raised" && db.message === LEDGER_DB_RAISES.unbalanced) throw new UseCaseError(LEDGER_ERROR.unbalanced);
  if (db.kind === "unique") {
    switch (db.constraint) {
      case "ledger_accounts_tenant_number_key":
        throw new UseCaseError(LEDGER_ERROR.accountNumberTaken);
      case "ledger_accounts_tenant_bank_owner_key":
      case "ledger_accounts_tenant_contact_owner_key":
      case "ledger_accounts_tenant_platform_owner_key":
        throw new UseCaseError(LEDGER_ERROR.ownerTaken);
      case "ledger_open_item_match_lines_line_key":
      case "ledger_open_item_match_lines_match_id_line_id_pk":
        throw new UseCaseError(LEDGER_ERROR.lineAlreadyMatched);
      case "ledger_filings_original_key":
        throw new UseCaseError(LEDGER_ERROR.filingOverlaps);
      case "ledger_filings_open_correction_key":
        throw new UseCaseError(LEDGER_ERROR.correctionExists);
    }
  }
  throw err;
}

function yearStart(isoDate: string): string {
  return `${isoDate.slice(0, 4)}-01-01`;
}

function yearEnd(isoDate: string): string {
  return `${isoDate.slice(0, 4)}-12-31`;
}

/** The part of a period on or after the ledger's start date (`null` when none of it is). */
function clampToStart(period: Period, startDate: string | null): Period | null {
  if (!startDate || startDate <= period.from) return period;
  if (startDate > period.to) return null;
  return { from: startDate, to: period.to };
}

/** The booked result of the years before `from`'s, which 2970 opens with (`computeBalances`). */
function carriedResult(accounts: readonly LedgerAccountRow[], lines: readonly ReportLine[], from: string): number {
  const kinds = new Map(accounts.map((account) => [account.id, account.kind]));
  return priorYearsResult(
    (id) => kinds.get(id),
    lines.filter((line) => !line.proposed),
    from,
  );
}

function sameSnapshot(a: EntrySnapshot, b: EntrySnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

export function createLedgerUseCases(deps: LedgerUseCaseDeps): LedgerUseCases {
  const now = deps.now ?? (() => new Date());
  const ledger = deps.repos.ledger;

  async function requireEnabled(tenantId: string, repos: Repositories = deps.repos): Promise<LedgerSettingsRow> {
    const settings = await repos.ledger.findSettings(tenantId);
    if (!settings?.enabled) throw new UseCaseError(LEDGER_ERROR.disabled);
    return settings;
  }

  /** Runs `work` in one transaction and maps the database's refusals, including the deferred
   * balance check that only fires at commit. */
  async function transact<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await deps.uow.transaction(work);
    } catch (err) {
      return translateDbError(err);
    }
  }

  /** The entry, locked for the rest of the transaction: a read-then-write on it never interleaves
   * with another writer (the second one waits and then sees the first one's result). */
  async function requireEntry(repos: Repositories, tenantId: string, entryId: string): Promise<JournalEntryRow> {
    const entry = await repos.ledger.findEntry(tenantId, entryId, { forUpdate: true });
    if (!entry) throw new UseCaseError(LEDGER_ERROR.notFound);
    return entry;
  }

  async function requireAccountByNumber(repos: Repositories, tenantId: string, number: string): Promise<LedgerAccountRow> {
    const account = await repos.ledger.findAccountByNumber(tenantId, number);
    if (!account) throw new UseCaseError(LEDGER_ERROR.accountNotFound);
    return account;
  }

  async function assertNotLocked(repos: Repositories, tenantId: string, date: string, filingId: string | null): Promise<void> {
    if (await repos.ledger.findLockingFiling(tenantId, date, filingId)) throw new UseCaseError(LEDGER_ERROR.locked);
  }

  /**
   * The correcting filing a booked entry dated `date` goes with. One given by the caller stays
   * (`validateReferences` checked it). Otherwise, in a period a submitted filing locks, the one
   * draft correction that opens the date is taken; several make the caller choose
   * (`filing_choice_required`); none leaves the date locked. Outside a locked period: `null`.
   */
  async function correctionFilingFor(repos: Repositories, tenantId: string, date: string, filingId: string | null): Promise<string | null> {
    if (filingId) return filingId;
    if (!(await repos.ledger.findLockingFiling(tenantId, date, null))) return null;
    const drafts = (await repos.ledger.listFilings(tenantId)).filter((filing) => filing.status === "draft" && filing.correctsFilingId !== null);
    const opening: string[] = [];
    for (const draft of drafts) {
      if (!(await repos.ledger.findLockingFiling(tenantId, date, draft.id))) opening.push(draft.id);
    }
    if (opening.length === 1) return opening[0]!;
    if (opening.length > 1) throw new UseCaseError(LEDGER_ERROR.filingChoiceRequired);
    throw new UseCaseError(LEDGER_ERROR.locked);
  }

  /** The entry's base lines expanded with their tax lines and resolved to accounts of this
   * tenant. Throws for an unknown or archived account. */
  async function prepareLines(repos: Repositories, tenantId: string, entry: EntryInput): Promise<{ expanded: ExpandedLine[]; rows: CreateJournalLineRow[] }> {
    const expanded = expandTaxLines(entry.lines);
    const accounts = new Map((await repos.ledger.listAccounts(tenantId)).map((account) => [account.number, account]));
    const rows = expanded.map((line): CreateJournalLineRow => {
      const account = accounts.get(line.accountNumber);
      if (!account) throw new UseCaseError(LEDGER_ERROR.accountNotFound);
      if (account.archivedAt) throw new UseCaseError(LEDGER_ERROR.accountArchived);
      return {
        position: line.position,
        accountId: account.id,
        amountCents: line.amountCents,
        taxCode: line.taxCode,
        taxRole: line.taxRole,
        generatedFromLinePosition: line.generatedFromLinePosition,
        documentId: line.documentId,
        text: line.text,
      };
    });
    return { expanded, rows };
  }

  /** The references an entry carries must point into this tenant. */
  async function validateReferences(repos: Repositories, tenantId: string, entry: EntryInput): Promise<void> {
    if (entry.documentId && !(await deps.sources.documentExists(tenantId, entry.documentId))) throw new UseCaseError(LEDGER_ERROR.sourceNotFound);
    if (entry.transactionId && !(await deps.sources.transactionExists(tenantId, entry.transactionId))) throw new UseCaseError(LEDGER_ERROR.sourceNotFound);
    if (entry.correctionOfEntryId && !(await repos.ledger.findEntry(tenantId, entry.correctionOfEntryId))) throw new UseCaseError(LEDGER_ERROR.sourceNotFound);
    for (const documentId of new Set(entry.lines.map((line) => line.documentId).filter((id): id is string => Boolean(id) && id !== entry.documentId))) {
      if (!(await deps.sources.documentExists(tenantId, documentId))) throw new UseCaseError(LEDGER_ERROR.sourceNotFound);
    }
    if (entry.filingId) {
      const filing = await repos.ledger.findFiling(tenantId, entry.filingId);
      const covers =
        filing &&
        (filing.kind === "annual_statement"
          ? entry.bookingDate >= yearStart(filing.periodFrom) && entry.bookingDate <= yearEnd(filing.periodTo)
          : entry.bookingDate >= filing.periodFrom && entry.bookingDate <= filing.periodTo);
      if (!filing || filing.status !== "draft" || !filing.correctsFilingId || !covers) throw new UseCaseError(LEDGER_ERROR.invalidFiling);
    }
  }

  async function writeRevision(
    repos: Repositories,
    input: { tenantId: string; entry: JournalEntryRow; revision: number; changeKind: RevisionChangeKind; reason: string | null; userId: string | null; before: EntrySnapshot | null; bookingDate?: string },
  ): Promise<void> {
    await repos.ledger.insertRevision({
      tenantId: input.tenantId,
      entryId: input.entry.id,
      entryRef: input.entry.id,
      revision: input.revision,
      changeKind: input.changeKind,
      reason: input.reason,
      bookingDate: input.bookingDate ?? input.entry.bookingDate,
      snapshot: input.before,
      changedByUserId: input.userId,
    });
  }

  function entryFields(entry: EntryInput) {
    return {
      bookingDate: entry.bookingDate,
      documentDate: entry.documentDate ?? null,
      serviceDate: entry.serviceDate ?? null,
      text: entry.text,
      documentId: entry.documentId ?? null,
      transactionId: entry.transactionId ?? null,
      correctionOfEntryId: entry.correctionOfEntryId ?? null,
      filingId: entry.filingId ?? null,
    };
  }

  /** A simple bookkeeping change: status or dismissal, with its revision. */
  async function changeState(
    repos: Repositories,
    input: { tenantId: string; userId: string | null; entry: JournalEntryRow; changeKind: RevisionChangeKind; reason: string | null; patch: Parameters<Repositories["ledger"]["updateEntry"]>[2] },
  ): Promise<void> {
    const lines = await repos.ledger.listLines(input.tenantId, [input.entry.id]);
    const revision = input.entry.revision + 1;
    const updated = await repos.ledger.updateEntry(input.tenantId, input.entry.id, { ...input.patch, revision }, { expectedRevision: input.entry.revision });
    if (!updated) throw new UseCaseError(LEDGER_ERROR.staleRevision);
    await writeRevision(repos, { tenantId: input.tenantId, entry: updated, revision, changeKind: input.changeKind, reason: input.reason, userId: input.userId, before: snapshotOf(input.entry, lines) });
  }

  /** The automatic matches after a booking that already committed: a failure here is logged,
   * never reported as a failed booking (the next booking or sync matches again). */
  async function autoMatchAfterBooking(tenantId: string): Promise<void> {
    try {
      await api.autoMatchOpenItems(tenantId);
    } catch (err) {
      console.error("[ledger] automatic matching after booking failed", err instanceof Error ? err.name : "unknown");
    }
  }

  async function bookOne(tenantId: string, userId: string, entryId: string): Promise<void> {
    await transact(async (repos) => {
      await requireEnabled(tenantId, repos);
      const entry = await requireEntry(repos, tenantId, entryId);
      if (entry.status === "booked") throw new UseCaseError(LEDGER_ERROR.alreadyBooked);
      if (entry.dismissedAt) throw new UseCaseError(LEDGER_ERROR.notProposed);
      const lines = await repos.ledger.listLines(tenantId, [entry.id]);
      if (!isBalanced(lines)) throw new UseCaseError(LEDGER_ERROR.unbalanced);
      const filingId = await correctionFilingFor(repos, tenantId, entry.bookingDate, entry.filingId);
      await assertNotLocked(repos, tenantId, entry.bookingDate, filingId);
      await changeState(repos, { tenantId, userId, entry, changeKind: "booked", reason: null, patch: { status: "booked", bookedAt: now(), bookedByUserId: userId, filingId } });
      // A rule's proposal booked: one more hit for the rule (`originReason` is `rule:<id>`).
      const ruleId = entry.origin === "rule" && entry.originReason?.startsWith("rule:") ? entry.originReason.slice("rule:".length) : null;
      if (ruleId) await repos.ledger.incrementRuleHits(tenantId, ruleId);
    });
  }

  function toListItem(row: JournalEntryRow, lines: readonly JournalLineWithAccount[], accounts: ReadonlyMap<string, LedgerAccountRow>): JournalEntryListItem {
    const summary = summarizeEntry(
      lines.flatMap((line) => {
        const account = accounts.get(line.accountId);
        if (!account) return [];
        return [
          {
            accountNumber: account.number,
            accountName: account.name,
            kind: account.kind,
            group: account.group,
            openItems: account.openItems,
            ownerType: account.ownerType,
            ownerPersonName: account.ownerPersonName,
            amountCents: line.amountCents,
            taxCode: line.taxCode,
            taxRole: line.taxRole,
          },
        ];
      }),
    );
    return {
      id: row.id,
      bookingDate: row.bookingDate,
      documentDate: row.documentDate,
      text: row.text,
      status: row.status,
      origin: row.origin,
      dismissed: row.dismissedAt !== null,
      sourceKey: row.sourceKey,
      originReason: row.originReason,
      documentId: row.documentId,
      transactionId: row.transactionId,
      totalCents: debitTotal(lines),
      differenceCents: lineDifference(lines),
      warnings: row.warnings,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
      summary,
      lines: lines.map(toLineView),
    };
  }

  async function loadReport(tenantId: string, to: string): Promise<{ accounts: LedgerAccountRow[]; reportAccounts: ReportAccount[]; lines: ReportLine[] }> {
    const [accounts, lines] = await Promise.all([ledger.listAccounts(tenantId), ledger.listReportLines(tenantId, { to })]);
    return { accounts, reportAccounts: accounts.map(toReportAccount), lines: lines.map(toReportLine) };
  }

  function openItemSummaries(accounts: readonly LedgerAccountRow[], lines: readonly ReportLine[], matches: Awaited<ReturnType<typeof ledger.listMatches>>, asOf: string): OpenItemAccountSummary[] {
    const used = new Set(lines.map((line) => line.accountId));
    return accounts
      .filter((account) => account.openItems && (account.archivedAt === null || used.has(account.id)))
      .map((account) => {
        const items = computeOpenItems(
          account.id,
          lines,
          matches.filter((match) => match.accountId === account.id),
          asOf,
        );
        return { account: toAccountView(account), balanceCents: items.balanceCents, status: items.status, unmatchedCount: items.unmatched.length };
      });
  }

  type ControlContext = {
    settings: LedgerSettingsRow;
    accounts: LedgerAccountRow[];
    lines: ReportLine[];
    matches: Awaited<ReturnType<typeof ledger.listMatches>>;
    bankMovements: LedgerSourceBankMovementRow[];
    openings: Map<string, number>;
    uploads: Awaited<ReturnType<typeof ledger.listAdvisorUploads>>;
  };

  async function loadControlContext(tenantId: string, settings: LedgerSettingsRow, to: string): Promise<ControlContext> {
    const [report, matches, bankMovements, openings, uploads] = await Promise.all([
      loadReport(tenantId, to),
      ledger.listMatches(tenantId),
      deps.sources.listBankMovements(tenantId, to),
      deps.sources.listBankOpeningBalances(tenantId),
      ledger.listAdvisorUploads(tenantId),
    ]);
    return { settings, accounts: report.accounts, lines: report.lines, matches, bankMovements, openings, uploads };
  }

  async function advisorDifferenceCount(tenantId: string, ctx: ControlContext, period: Period): Promise<number | null> {
    const upload = ctx.uploads.find((candidate) => candidate.periodTo === period.to && candidate.periodFrom <= period.from);
    if (!upload) return null;
    const theirs = await ledger.listAdvisorLines(tenantId, upload.id);
    const balances = computeBalances(ctx.accounts.map(toReportAccount), ctx.lines, { from: upload.periodFrom, to: upload.periodTo });
    return compareWithAdvisor(
      balances.rows.map((row) => ({ number: row.number, name: row.name, closingCents: row.closingCents })),
      theirs,
    ).differenceCount;
  }

  function bankComparisonsFor(ctx: ControlContext, period: Period): BankBalanceComparison[] {
    const lines = ctx.lines.filter((line) => line.bookingDate <= period.to);
    return ctx.accounts
      .filter((account) => account.ownerType === "bank_account" && account.ownerBankAccountId)
      .map((account) =>
        compareBankBalances(
          {
            accountNumber: account.number,
            ledger: { openingCents: 0, movements: lines.filter((line) => line.accountId === account.id).map((line) => ({ date: line.bookingDate, amountCents: line.amountCents })) },
            real: {
              openingCents: ctx.openings.get(account.ownerBankAccountId ?? "") ?? 0,
              movements: ctx.bankMovements
                .filter((movement) => movement.accountId === account.ownerBankAccountId && movement.bookingDate <= period.to)
                .map((movement) => ({ date: movement.bookingDate, amountCents: movement.amountCents })),
            },
          },
          period,
        ),
      );
  }

  /** Movements on bank accounts in the period that no booked entry references. */
  async function unbookedTransactionIds(tenantId: string, period: Period): Promise<string[]> {
    const [ids, booked] = await Promise.all([deps.sources.listBankTransactionIds(tenantId, period), ledger.listBookedTransactionIds(tenantId)]);
    return ids.filter((id) => !booked.has(id));
  }

  /** Bookable documents in the period that no booked entry references and whose proposal was not
   * dismissed. */
  async function unbookedDocumentIds(tenantId: string, period: Period): Promise<string[]> {
    const [ids, decided] = await Promise.all([deps.sources.listBookableDocumentIds(tenantId, period), ledger.listDecidedDocumentIds(tenantId)]);
    return ids.filter((id) => !decided.has(id));
  }

  async function controlsFor(tenantId: string, ctx: ControlContext, period: Period): Promise<{ controls: ControlResult[]; booked: number; proposed: number }> {
    const lines = ctx.lines.filter((line) => line.bookingDate <= period.to);
    const bank = bankComparisonsFor(ctx, period);

    const covered = clampToStart(period, ctx.settings.startDate);
    const [unbookedTx, unbookedDocs, counts, advisor] = await Promise.all([
      covered ? unbookedTransactionIds(tenantId, covered) : Promise.resolve([]),
      covered ? unbookedDocumentIds(tenantId, covered) : Promise.resolve([]),
      ledger.countEntries(tenantId, period),
      advisorDifferenceCount(tenantId, ctx, period),
    ]);
    const openItemAccounts = openItemSummaries(ctx.accounts, lines, ctx.matches, period.to)
      .filter((summary) => summary.balanceCents !== 0 || summary.unmatchedCount > 0)
      .map((summary) => ({ accountNumber: summary.account.number, status: summary.status, balanceCents: summary.balanceCents }));

    const controls = computeControls({
      bank,
      unbookedBankTransactionIds: unbookedTx,
      unbookedDocumentIds: unbookedDocs,
      openItemAccounts,
      proposalsWaiting: counts.proposed,
      unbalancedProposals: counts.unbalancedProposed,
      advisorDifferences: advisor,
    });
    return { controls, booked: counts.booked, proposed: counts.proposed };
  }

  /** See `syncChart`. Runs inside a transaction holding the tenant row lock. */
  async function seedChart(repos: Repositories, tenantId: string): Promise<void> {
    await repos.ledger.insertAccountsIfMissing(
      SKR04_SEED_ACCOUNTS.map(
        (seed): CreateLedgerAccountRow => ({
          tenantId,
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
        }),
      ),
    );
    const accounts = await repos.ledger.listAccounts(tenantId);
    const byNumber = new Map(accounts.map((account) => [account.number, account]));
    const taken = new Set(byNumber.keys());
    const sources = await deps.sources.listSourceAccounts(tenantId);

    const owned = (row: Omit<CreateLedgerAccountRow, "tenantId">) => repos.ledger.insertAccount({ tenantId, ...row });

    for (const source of sources.filter((candidate) => candidate.type === "bank")) {
      if (accounts.some((account) => account.ownerBankAccountId === source.id)) continue;
      const text = bankLedgerAccountText(source.name);
      // The seeded, still unowned "1800 Bank" is taken over by the first bank account.
      const free = BANK_ACCOUNT_NUMBERS.find((number) => {
        const existing = byNumber.get(number);
        return !existing || (existing.group === "bank" && existing.ownerType === null);
      });
      if (!free) continue;
      const existing = byNumber.get(free);
      if (existing) {
        const updated = await repos.ledger.updateAccount(tenantId, existing.id, { ownerType: "bank_account", ownerBankAccountId: source.id, name: text.name, description: text.description });
        if (updated) byNumber.set(free, updated);
      } else {
        const created = await owned({ number: free, name: text.name, kind: "asset", group: "bank", openItems: false, ownerType: "bank_account", ownerBankAccountId: source.id, ownerContactId: null, ownerPlatform: null, ownerPersonName: null, description: text.description });
        byNumber.set(free, created);
        taken.add(free);
      }
    }

    for (const source of sources.filter((candidate) => candidate.type === "clearing")) {
      if (source.platform) {
        if (accounts.some((account) => account.ownerPlatform === source.platform)) continue;
        const number = nextFreeNumber(PLATFORM_RECEIVABLE_NUMBERS, taken);
        if (!number) continue;
        const text = platformLedgerAccountText(source.platform);
        await owned({ number, name: text.name, kind: "asset", group: "open_items", openItems: true, ownerType: "platform", ownerBankAccountId: null, ownerContactId: null, ownerPlatform: source.platform, ownerPersonName: null, description: text.description });
        taken.add(number);
      } else if (source.contactId) {
        if (accounts.some((account) => account.ownerContactId === source.contactId)) continue;
        const number = nextFreeNumber(CONTACT_CLEARING_NUMBERS, taken);
        if (!number) continue;
        const text = contactLedgerAccountText(source.contactName ?? source.name);
        await owned({ number, name: text.name, kind: "asset", group: "open_items", openItems: true, ownerType: "contact", ownerBankAccountId: null, ownerContactId: source.contactId, ownerPlatform: null, ownerPersonName: null, description: text.description });
        taken.add(number);
      }
    }
  }

  async function toRuleView(row: LedgerBookingRuleRow, accounts: ReadonlyMap<string, LedgerAccountRow>): Promise<BookingRuleView> {
    return {
      id: row.id,
      contactId: row.contactId,
      counterpartyPattern: row.counterpartyPattern,
      direction: row.direction,
      accountNumber: accounts.get(row.accountId)?.number ?? "",
      taxCode: row.taxCode,
      paymentAccountNumber: row.paymentAccountId ? (accounts.get(row.paymentAccountId)?.number ?? null) : null,
      noDocument: row.noDocument,
      active: row.active,
      hits: row.hits,
      learnedFromEntryId: row.learnedFromEntryId,
    };
  }

  async function ruleRow(repos: Repositories, tenantId: string, rule: RuleInput) {
    const account = await requireAccountByNumber(repos, tenantId, rule.accountNumber);
    const payment = rule.paymentAccountNumber ? await requireAccountByNumber(repos, tenantId, rule.paymentAccountNumber) : null;
    if (rule.contactId && !(await deps.sources.findContactById(tenantId, rule.contactId))) throw new UseCaseError(LEDGER_ERROR.ownerNotFound);
    const pattern = rule.counterpartyPattern?.trim().toLowerCase() || null;
    return {
      contactId: rule.contactId,
      counterpartyPattern: pattern,
      direction: rule.direction,
      accountId: account.id,
      taxCode: rule.taxCode,
      paymentAccountId: payment?.id ?? null,
      noDocument: rule.noDocument,
      active: rule.active,
      learnedFromEntryId: rule.learnedFromEntryId ?? null,
    };
  }

  async function accountsById(tenantId: string): Promise<Map<string, LedgerAccountRow>> {
    return new Map((await ledger.listAccounts(tenantId)).map((account) => [account.id, account]));
  }

  // -------------------------------------------------------------------------------------------
  // The proposal engine
  // -------------------------------------------------------------------------------------------

  /** Reads every source through the source reader (never writing any of them) and the ledger's
   * own chart, rules and decided source keys into the engine's snapshot. */
  async function loadSnapshot(tenantId: string, settings: LedgerSettingsRow, period: { from?: string; to?: string }): Promise<ProposalSnapshot> {
    const repos = deps.repos;
    const [accounts, rules, documents, transactions, settlementLines, invoices, sourceAccounts, contacts, aliasRows, noDocumentRules, sourceKeys] = await Promise.all([
      repos.ledger.listAccounts(tenantId),
      repos.ledger.listRules(tenantId),
      deps.sources.listDocumentsForLedger(tenantId),
      deps.sources.listTransactionsForLedger(tenantId),
      deps.sources.listSettlementLinesForLedger(tenantId),
      deps.sources.listInvoices(tenantId, 100_000),
      deps.sources.listMoneyAccounts(tenantId),
      deps.sources.listContacts(tenantId),
      deps.sources.listPaymentAliases(tenantId),
      deps.sources.listNoDocumentRules(tenantId),
      repos.ledger.listSourceKeys(tenantId),
    ]);
    const numbers = new Map(accounts.map((account) => [account.id, account.number]));
    const aliases: ContactAliasMap = new Map(aliasRows.map((row) => [row.counterpartyNameNormalized, row.contactId]));
    const noDocumentNames = new Set(noDocumentRules.map((rule) => rule.counterpartyNameNormalized));
    const contactsForResolution = contacts.map((contact) => ({ id: contact.id, name: contact.name }));

    return {
      from: period.from,
      to: period.to,
      startDate: settings.startDate,
      accounts: accounts.map((account) => ({
        number: account.number,
        name: account.name,
        kind: account.kind,
        group: account.group,
        openItems: account.openItems,
        ownerType: account.ownerType,
        ownerBankAccountId: account.ownerBankAccountId,
        ownerContactId: account.ownerContactId,
        ownerPlatform: account.ownerPlatform,
        ownerPersonName: account.ownerPersonName,
        archived: account.archivedAt !== null,
      })),
      rules: rules
        .filter((rule) => rule.active)
        .map((rule) => ({
          id: rule.id,
          contactId: rule.contactId,
          counterpartyPattern: rule.counterpartyPattern,
          direction: rule.direction,
          accountNumber: numbers.get(rule.accountId) ?? "",
          taxCode: rule.taxCode,
          paymentAccountNumber: rule.paymentAccountId ? (numbers.get(rule.paymentAccountId) ?? null) : null,
          noDocument: rule.noDocument,
        })),
      documents: documents.map((doc) => ({ ...doc })),
      transactions: transactions.map((tx) => ({
        id: tx.id,
        bankAccountId: tx.accountId,
        bookingDate: tx.bookingDate,
        amountCents: tx.amountCents,
        counterpartyName: tx.counterpartyName,
        counterpartyIban: tx.counterpartyIban,
        remittanceText: tx.remittanceText,
        resolvedContactId: resolveContactForCounterparty(tx.counterpartyName, contactsForResolution, aliases),
        pairedClearing: tx.pairedClearing,
        noDocumentNeeded: tx.noDocumentNeeded,
        noDocumentRule: tx.counterpartyName !== null && noDocumentNames.has(normalizeName(tx.counterpartyName)),
      })),
      settlementLines: settlementLines.map((line) => ({
        id: line.id,
        documentId: line.sourceDocumentId,
        platform: line.platform,
        type: line.type,
        grossCents: line.grossCents,
        feeCents: line.feeCents,
        netCents: line.netCents,
        bookingDate: line.bookingDate,
      })),
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        type: invoice.type,
        issueDate: invoice.issueDate,
        serviceDate: invoice.einvoiceInput.deliveryDate ?? invoice.einvoiceInput.periodEnd ?? null,
        contactId: invoice.contactId,
        buyerName: invoice.buyerName,
        buyerCountry: invoice.einvoiceInput.buyer?.address?.country ?? null,
        documentId: invoice.documentId,
        cancelsInvoiceId: invoice.cancelsInvoiceId,
        groups: invoiceVatGroups(
          (invoice.einvoiceInput.lines ?? []).map((line) => ({
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            category: line.vat.category,
            ratePercent: Number(line.vat.rate ?? 0),
          })),
          { netCents: invoice.netCents, vatCents: invoice.vatCents },
        ),
      })),
      ownBankAccounts: sourceAccounts.filter((account) => account.type === "bank").map((account) => ({ id: account.id, iban: account.iban })),
      decidedSourceKeys: new Set(sourceKeys.filter((key) => key.status === "booked" || key.dismissedAt !== null || key.userEditedAt !== null).map((key) => key.sourceKey)),
    };
  }

  /** Asks the advisor what the cache cannot answer, at most `maxAdviceQuestionsPerSync` per run.
   * A thrown call (unavailable, not configured, rate limited) is not cached: the next run asks
   * again. Every answer, cached or fresh, is validated against the question it answers. */
  async function adviseAll(tenantId: string, questions: readonly BookingAdviceQuestion[], result: SyncProposalsResult): Promise<AdviceMap> {
    const advice = new Map<string, BookingAdvice | null>();
    if (questions.length === 0) return advice;
    const advisor = deps.bookingAdvisor;
    if (!advisor) {
      for (const question of questions) advice.set(question.documentId, null);
      result.aiUnavailable += questions.length;
      return advice;
    }
    const cached = new Map((await ledger.listBookingAdvice(tenantId, questions.map((question) => question.documentId))).map((row) => [row.documentId, row]));
    const budget = deps.maxAdviceQuestionsPerSync ?? MAX_ADVICE_QUESTIONS_PER_SYNC;
    let asked = 0;
    for (const question of questions) {
      const key = bookingAdviceCacheKey(question, advisor.version);
      const hit = cached.get(question.documentId);
      if (hit && hit.cacheKey === key) {
        result.aiCached++;
        advice.set(question.documentId, validateBookingAdvice(hit.answer, question));
        continue;
      }
      if (asked >= budget) continue; // deferred: no entry in the map
      asked++;
      try {
        const raw = toCacheableBookingAdvice(await advisor.advise(question));
        result.aiAsked++;
        await ledger.upsertBookingAdvice({ tenantId, documentId: question.documentId, cacheKey: key, answer: raw });
        advice.set(question.documentId, validateBookingAdvice(raw, question));
      } catch (err) {
        console.error("[ledger] booking advisor failed", err instanceof Error ? err.name : "unknown");
        result.aiUnavailable++;
        advice.set(question.documentId, null);
      }
    }
    return advice;
  }

  const api: LedgerUseCases = {
    // -----------------------------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------------------------
    async getSettings(tenantId) {
      return toSettingsView(await ledger.findSettings(tenantId));
    },

    async isEnabled(tenantId) {
      return (await ledger.findSettings(tenantId))?.enabled ?? false;
    },

    async setSettings({ tenantId, settings }) {
      const row = await transact(async (repos) => {
        const tenant = await repos.tenant.lockForUpdate(tenantId);
        if (!tenant) throw new UseCaseError(LEDGER_ERROR.notFound);
        const saved = await repos.ledger.upsertSettings(tenantId, settings);
        if (saved.enabled) await seedChart(repos, tenantId);
        return saved;
      });
      return toSettingsView(row);
    },

    async syncChart(tenantId) {
      await requireEnabled(tenantId);
      await transact(async (repos) => {
        const tenant = await repos.tenant.lockForUpdate(tenantId);
        if (!tenant) throw new UseCaseError(LEDGER_ERROR.notFound);
        await seedChart(repos, tenantId);
      });
      return (await ledger.listAccounts(tenantId)).map(toAccountView);
    },

    // -----------------------------------------------------------------------------------------
    // Chart of accounts
    // -----------------------------------------------------------------------------------------
    async listAccounts(tenantId) {
      await requireEnabled(tenantId);
      return (await ledger.listAccounts(tenantId)).map(toAccountView);
    },

    async createAccount({ tenantId, account }) {
      await requireEnabled(tenantId);
      return transact(async (repos) => {
        if (await repos.ledger.findAccountByNumber(tenantId, account.number)) throw new UseCaseError(LEDGER_ERROR.accountNumberTaken);
        const owners = { ownerBankAccountId: null as string | null, ownerContactId: null as string | null, ownerPlatform: null as string | null, ownerPersonName: null as string | null };
        if (account.ownerType === "bank_account") {
          const sources = await deps.sources.listSourceAccounts(tenantId);
          if (!sources.some((source) => source.type === "bank" && source.id === account.ownerBankAccountId)) throw new UseCaseError(LEDGER_ERROR.ownerNotFound);
          owners.ownerBankAccountId = account.ownerBankAccountId ?? null;
        } else if (account.ownerType === "contact") {
          if (!account.ownerContactId || !(await deps.sources.findContactById(tenantId, account.ownerContactId))) throw new UseCaseError(LEDGER_ERROR.ownerNotFound);
          owners.ownerContactId = account.ownerContactId;
        } else if (account.ownerType === "platform") {
          owners.ownerPlatform = account.ownerPlatform ?? null;
        } else if (account.ownerType === "person") {
          owners.ownerPersonName = account.ownerPersonName ?? null;
        }
        const existing = await repos.ledger.listAccounts(tenantId);
        if (
          existing.some(
            (other) =>
              (owners.ownerBankAccountId && other.ownerBankAccountId === owners.ownerBankAccountId) ||
              (owners.ownerContactId && other.ownerContactId === owners.ownerContactId) ||
              (owners.ownerPlatform && other.ownerPlatform === owners.ownerPlatform),
          )
        ) {
          throw new UseCaseError(LEDGER_ERROR.ownerTaken);
        }
        const row = await repos.ledger.insertAccount({
          tenantId,
          number: account.number,
          name: account.name,
          kind: account.kind,
          group: account.group,
          openItems: account.openItems,
          ownerType: account.ownerType,
          ...owners,
          description: account.description ?? null,
        });
        return toAccountView(row);
      });
    },

    async updateAccount({ tenantId, account }) {
      await requireEnabled(tenantId);
      const row = await ledger.updateAccount(tenantId, account.accountId, {
        name: account.name,
        group: account.group,
        openItems: account.openItems,
        description: account.description ?? null,
      });
      if (!row) throw new UseCaseError(LEDGER_ERROR.accountNotFound);
      return toAccountView(row);
    },

    async setAccountArchived({ tenantId, accountId, archived }) {
      await requireEnabled(tenantId);
      const row = await ledger.updateAccount(tenantId, accountId, { archivedAt: archived ? now() : null });
      if (!row) throw new UseCaseError(LEDGER_ERROR.accountNotFound);
      return toAccountView(row);
    },

    // -----------------------------------------------------------------------------------------
    // Journal
    // -----------------------------------------------------------------------------------------
    async listEntries(tenantId, filter = {}) {
      await requireEnabled(tenantId);
      const parsed = listEntriesFilterSchema.parse(filter);
      let accountId: string | undefined;
      if (parsed.accountNumber) {
        const account = await ledger.findAccountByNumber(tenantId, parsed.accountNumber);
        if (!account) return [];
        accountId = account.id;
      }
      const rows = await ledger.listEntries(tenantId, {
        from: parsed.from,
        to: parsed.to,
        status: parsed.status,
        origin: parsed.origin,
        accountId,
        documentId: parsed.documentId,
        changedSince: parsed.changedSince ? new Date(parsed.changedSince) : undefined,
        dismissed: parsed.dismissed,
        limit: parsed.limit,
      });
      const [lines, accounts] = await Promise.all([
        ledger.listLines(
          tenantId,
          rows.map((row) => row.id),
        ),
        accountsById(tenantId),
      ]);
      return rows.map((row) =>
        toListItem(
          row,
          lines.filter((line) => line.entryId === row.id),
          accounts,
        ),
      );
    },

    async countWaitingProposals(tenantId) {
      await requireEnabled(tenantId);
      return (await ledger.countEntries(tenantId, { from: "0001-01-01", to: "9999-12-31" })).proposed;
    },

    async getSources(tenantId, { documentIds, transactionIds }) {
      await requireEnabled(tenantId);
      const wantedDocuments = new Set(documentIds);
      const wantedTransactions = new Set(transactionIds);
      const [documents, transactions, bankAccounts] = await Promise.all([
        wantedDocuments.size > 0 ? deps.sources.listDocumentsForLedger(tenantId) : Promise.resolve([]),
        wantedTransactions.size > 0 ? deps.sources.listTransactionsForLedger(tenantId) : Promise.resolve([]),
        wantedTransactions.size > 0 ? deps.sources.listMoneyAccounts(tenantId) : Promise.resolve([]),
      ]);
      const accountNames = new Map(bankAccounts.map((account) => [account.id, account.name]));
      return {
        documents: documents
          .filter((document) => wantedDocuments.has(document.id))
          .map((document) => ({
            id: document.id,
            kind: document.kind,
            direction: document.direction,
            title: document.title,
            sender: document.sender,
            documentDate: document.documentDate,
            effectiveDate: document.effectiveDate,
            invoiceNumber: document.invoiceNumber,
            totalAmountCents: document.totalAmountCents,
            currency: document.currency,
            netTotalCents: document.netTotalCents,
            taxTotalCents: document.taxTotalCents,
            taxBreakdown: document.taxBreakdown,
            passThroughCents: document.passThroughCents,
            reverseCharge: document.reverseCharge,
            serviceDate: document.serviceDate,
            servicePeriodFrom: document.servicePeriodFrom,
            servicePeriodTo: document.servicePeriodTo,
            contactId: document.contactId,
            contactName: document.contactName,
            originalFileName: document.originalFileName,
          })),
        transactions: transactions
          .filter((transaction) => wantedTransactions.has(transaction.id))
          .map((transaction) => ({
            id: transaction.id,
            accountId: transaction.accountId,
            accountName: accountNames.get(transaction.accountId) ?? null,
            bookingDate: transaction.bookingDate,
            amountCents: transaction.amountCents,
            currency: transaction.currency,
            counterpartyName: transaction.counterpartyName,
            remittanceText: transaction.remittanceText,
          })),
      };
    },

    async getEntry(tenantId, entryId) {
      await requireEnabled(tenantId);
      const entry = await ledger.findEntry(tenantId, entryId);
      if (!entry) return null;
      const [lines, revisions, accounts, lockedBy] = await Promise.all([
        ledger.listLines(tenantId, [entry.id]),
        ledger.listRevisions(tenantId, entry.id),
        accountsById(tenantId),
        entry.status === "booked" ? ledger.findLockingFiling(tenantId, entry.bookingDate, entry.filingId) : Promise.resolve(null),
      ]);
      return {
        ...toListItem(entry, lines, accounts),
        serviceDate: entry.serviceDate,
        correctionOfEntryId: entry.correctionOfEntryId,
        filingId: entry.filingId,
        bookedAt: entry.bookedAt?.toISOString() ?? null,
        bookedByUserId: entry.bookedByUserId,
        lockedBy: lockedBy ? toFilingRef(lockedBy) : null,
        revisions: revisions.map(
          (revision): JournalEntryRevisionView => ({
            id: revision.id,
            revision: revision.revision,
            changeKind: revision.changeKind,
            changedAt: revision.changedAt.toISOString(),
            changedByUserId: revision.changedByUserId,
            reason: revision.reason,
            snapshot: revision.snapshot ?? null,
          }),
        ),
      };
    },

    async createEntry({ tenantId, userId, entry, book }) {
      return transact(async (repos) => {
        await requireEnabled(tenantId, repos);
        await validateReferences(repos, tenantId, entry);
        const { expanded, rows } = await prepareLines(repos, tenantId, entry);
        let filingId = entry.filingId ?? null;
        if (book) {
          if (!isBalanced(expanded)) throw new UseCaseError(LEDGER_ERROR.unbalanced);
          filingId = await correctionFilingFor(repos, tenantId, entry.bookingDate, filingId);
          await assertNotLocked(repos, tenantId, entry.bookingDate, filingId);
        }
        const at = now();
        const created = await repos.ledger.insertEntry({
          tenantId,
          ...entryFields(entry),
          filingId,
          status: book ? "booked" : "proposed",
          origin: "manual",
          originReason: null,
          sourceKey: null,
          warnings: [],
          userEditedAt: at,
          bookedAt: book ? at : null,
          bookedByUserId: book ? userId : null,
        });
        await repos.ledger.replaceLines(tenantId, created.id, rows);
        await writeRevision(repos, { tenantId, entry: created, revision: 1, changeKind: "created", reason: null, userId, before: null });
        return { entryId: created.id };
      });
    },

    async updateEntry({ tenantId, userId, entryId, entry, reason, expectedRevision }) {
      return transact(async (repos) => {
        await requireEnabled(tenantId, repos);
        const current = await requireEntry(repos, tenantId, entryId);
        if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new UseCaseError(LEDGER_ERROR.staleRevision);
        const booked = current.status === "booked";
        if (booked && !reason) throw new UseCaseError(LEDGER_ERROR.reasonRequired);
        await validateReferences(repos, tenantId, entry);
        const { expanded, rows } = await prepareLines(repos, tenantId, entry);
        let filingId = entry.filingId ?? null;
        if (booked) {
          if (!isBalanced(expanded)) throw new UseCaseError(LEDGER_ERROR.unbalanced);
          filingId = await correctionFilingFor(repos, tenantId, entry.bookingDate, filingId);
          await assertNotLocked(repos, tenantId, current.bookingDate, filingId);
          await assertNotLocked(repos, tenantId, entry.bookingDate, filingId);
        }
        const before = snapshotOf(current, await repos.ledger.listLines(tenantId, [current.id]));
        const revision = current.revision + 1;
        const updated = await repos.ledger.updateEntry(tenantId, current.id, { ...entryFields(entry), filingId, userEditedAt: now(), revision }, { expectedRevision: current.revision });
        if (!updated) throw new UseCaseError(LEDGER_ERROR.staleRevision);
        // Unchanged lines stay as they are, with their open-item matches.
        await repos.ledger.replaceLines(tenantId, current.id, rows);
        await writeRevision(repos, { tenantId, entry: updated, revision, changeKind: "edited", reason: reason ?? null, userId, before });
        return { entryId: current.id, revision };
      });
    },

    async deleteEntry({ tenantId, userId, entryId, reason }) {
      await transact(async (repos) => {
        await requireEnabled(tenantId, repos);
        const current = await requireEntry(repos, tenantId, entryId);
        if (current.status === "booked") {
          if (!reason) throw new UseCaseError(LEDGER_ERROR.reasonRequired);
          await assertNotLocked(repos, tenantId, current.bookingDate, current.filingId);
        }
        const before = snapshotOf(current, await repos.ledger.listLines(tenantId, [current.id]));
        await writeRevision(repos, { tenantId, entry: current, revision: current.revision + 1, changeKind: "deleted", reason: reason ?? null, userId, before });
        // A match must not outlive one of its lines (it would settle the rest on its own).
        await repos.ledger.deleteMatchesForEntry(tenantId, current.id);
        await repos.ledger.deleteEntry(tenantId, current.id);
      });
    },

    async bookEntry({ tenantId, userId, entryId }) {
      await bookOne(tenantId, userId, entryId);
      // The invoice and its payment may both be booked now: match them right away.
      await autoMatchAfterBooking(tenantId);
    },

    async unbookEntry({ tenantId, userId, entryId, reason }) {
      await transact(async (repos) => {
        await requireEnabled(tenantId, repos);
        const entry = await requireEntry(repos, tenantId, entryId);
        if (entry.status !== "booked") throw new UseCaseError(LEDGER_ERROR.notBooked);
        if (!reason) throw new UseCaseError(LEDGER_ERROR.reasonRequired);
        await assertNotLocked(repos, tenantId, entry.bookingDate, entry.filingId);
        // A proposal settles nothing: its lines leave their matches.
        await repos.ledger.deleteMatchesForEntry(tenantId, entry.id);
        await changeState(repos, { tenantId, userId, entry, changeKind: "unbooked", reason, patch: { status: "proposed", bookedAt: null, bookedByUserId: null } });
      });
    },

    async bulkBook({ tenantId, userId, entryIds }) {
      await requireEnabled(tenantId);
      const result: BulkBookResult = { booked: [], failed: [] };
      for (const entryId of new Set(entryIds)) {
        try {
          await bookOne(tenantId, userId, entryId);
          result.booked.push(entryId);
        } catch (err) {
          // Any failure stays with its entry; the rest are still booked.
          if (err instanceof UseCaseError) {
            result.failed.push({ entryId, errorCode: err.code as LedgerErrorCode });
          } else {
            console.error("[ledger] bulk booking of one entry failed", err instanceof Error ? err.name : "unknown");
            result.failed.push({ entryId, errorCode: "unknown" });
          }
        }
      }
      if (result.booked.length > 0) await autoMatchAfterBooking(tenantId);
      return result;
    },

    async dismissProposal({ tenantId, userId, entryId }) {
      await transact(async (repos) => {
        await requireEnabled(tenantId, repos);
        const entry = await requireEntry(repos, tenantId, entryId);
        if (entry.status === "booked") throw new UseCaseError(LEDGER_ERROR.alreadyBooked);
        if (entry.dismissedAt) throw new UseCaseError(LEDGER_ERROR.notProposed);
        await changeState(repos, { tenantId, userId, entry, changeKind: "dismissed", reason: null, patch: { dismissedAt: now() } });
      });
    },

    async restoreProposal({ tenantId, userId, entryId }) {
      await transact(async (repos) => {
        await requireEnabled(tenantId, repos);
        const entry = await requireEntry(repos, tenantId, entryId);
        if (!entry.dismissedAt) throw new UseCaseError(LEDGER_ERROR.notProposed);
        await changeState(repos, { tenantId, userId, entry, changeKind: "restored", reason: null, patch: { dismissedAt: null } });
      });
    },

    async upsertProposal({ tenantId, proposal }) {
      try {
        return await transact(async (repos) => {
          await requireEnabled(tenantId, repos);
          // Locked until the end: a human's edit, booking or dismissal waits for this write or
          // is seen by it, never overwritten.
          const existing = await repos.ledger.findEntryBySourceKey(tenantId, proposal.sourceKey, { forUpdate: true });
          if (existing && (existing.status === "booked" || existing.dismissedAt || existing.userEditedAt)) {
            return { entryId: existing.id, outcome: "kept" as const };
          }
          await validateReferences(repos, tenantId, proposal.entry);
          const { rows } = await prepareLines(repos, tenantId, proposal.entry);
          const fields = {
            ...entryFields(proposal.entry),
            origin: proposal.origin,
            originReason: proposal.originReason ?? null,
            warnings: proposal.warnings,
          };

          if (!existing) {
            const created = await repos.ledger.insertEntry({ tenantId, ...fields, status: "proposed", sourceKey: proposal.sourceKey, userEditedAt: null, bookedAt: null, bookedByUserId: null });
            await repos.ledger.replaceLines(tenantId, created.id, rows);
            await writeRevision(repos, { tenantId, entry: created, revision: 1, changeKind: "created", reason: null, userId: null, before: null });
            return { entryId: created.id, outcome: "created" as const };
          }

          const oldLines = await repos.ledger.listLines(tenantId, [existing.id]);
          const before = snapshotOf(existing, oldLines);
          const numbers = new Map((await repos.ledger.listAccounts(tenantId)).map((account) => [account.id, account.number]));
          const after: EntrySnapshot = {
            ...before,
            bookingDate: fields.bookingDate,
            documentDate: fields.documentDate,
            serviceDate: fields.serviceDate,
            text: fields.text,
            origin: fields.origin,
            documentId: fields.documentId,
            transactionId: fields.transactionId,
            lines: rows.map((line) => ({ accountNumber: numbers.get(line.accountId) ?? "", amountCents: line.amountCents, taxCode: line.taxCode, taxRole: line.taxRole, text: line.text, documentId: line.documentId })),
          };
          const sameWarnings = JSON.stringify(existing.warnings) === JSON.stringify(fields.warnings) && existing.originReason === fields.originReason;
          if (sameSnapshot(before, after) && sameWarnings) return { entryId: existing.id, outcome: "kept" as const };

          const revision = existing.revision + 1;
          const updated = await repos.ledger.updateEntry(tenantId, existing.id, { ...fields, revision }, { expectedRevision: existing.revision, untouchedProposal: true });
          if (!updated) return { entryId: existing.id, outcome: "kept" as const };
          await repos.ledger.replaceLines(tenantId, existing.id, rows);
          await writeRevision(repos, { tenantId, entry: updated, revision, changeKind: "edited", reason: null, userId: null, before });
          return { entryId: existing.id, outcome: "updated" as const };
        });
      } catch (err) {
        // Two syncs proposing the same source at once: the loser keeps what the winner wrote.
        const db = dbErrorOf(err);
        if (db.kind === "unique" && db.constraint === "journal_entries_tenant_source_key") {
          const winner = await ledger.findEntryBySourceKey(tenantId, proposal.sourceKey);
          if (winner) return { entryId: winner.id, outcome: "kept" };
        }
        throw err;
      }
    },

    async listSourceKeys(tenantId, prefix) {
      await requireEnabled(tenantId);
      return (await ledger.listSourceKeys(tenantId, prefix)).map((row) => ({
        sourceKey: row.sourceKey,
        entryId: row.entryId,
        status: row.status,
        dismissed: row.dismissedAt !== null,
        userEdited: row.userEditedAt !== null,
      }));
    },

    // -----------------------------------------------------------------------------------------
    // Reports
    // -----------------------------------------------------------------------------------------
    async getBalances(tenantId, period) {
      await requireEnabled(tenantId);
      const { reportAccounts, lines } = await loadReport(tenantId, period.to);
      return computeBalances(reportAccounts, lines, period);
    },

    async getAccountSheet(tenantId, { accountNumber, from, to, countProposals = false }) {
      await requireEnabled(tenantId);
      const [accounts, rows] = await Promise.all([ledger.listAccounts(tenantId), ledger.listReportLines(tenantId, { to, statuses: ["booked", "proposed"] })]);
      const account = accounts.find((candidate) => candidate.number === accountNumber);
      if (!account) return null;
      const lines = rows.map(toReportLine);
      const entries = new Set(lines.filter((line) => line.accountId === account.id).map((line) => line.entryId));
      return computeAccountSheet(
        toReportAccount(account),
        lines.filter((line) => entries.has(line.entryId)),
        { from, to },
        { countProposals, carriedResultCents: carriedResult(accounts, lines, from) },
      );
    },

    async getAccountSheets(tenantId, { accountNumbers, from, to }) {
      await requireEnabled(tenantId);
      const wanted = new Set(accountNumbers);
      if (wanted.size === 0) return [];
      const { accounts, lines } = await loadReport(tenantId, to);
      return accounts
        .filter((account) => wanted.has(account.number))
        .map((account) => {
          const entries = new Set(lines.filter((line) => line.accountId === account.id).map((line) => line.entryId));
          return computeAccountSheet(
            toReportAccount(account),
            lines.filter((line) => entries.has(line.entryId)),
            { from, to },
            { carriedResultCents: carriedResult(accounts, lines, from) },
          );
        });
    },

    async getBankComparisons(tenantId, period) {
      const settings = await requireEnabled(tenantId);
      const ctx = await loadControlContext(tenantId, settings, period.to);
      return bankComparisonsFor(ctx, period);
    },

    async getOpenItems(tenantId, { accountNumber, asOf }) {
      await requireEnabled(tenantId);
      const account = await ledger.findAccountByNumber(tenantId, accountNumber);
      if (!account) return null;
      if (!account.openItems) throw new UseCaseError(LEDGER_ERROR.accountNotOpenItems);
      const [{ lines }, matches] = await Promise.all([loadReport(tenantId, asOf), ledger.listMatches(tenantId, account.id)]);
      return { ...computeOpenItems(account.id, lines, matches, asOf), account: toAccountView(account) };
    },

    async listOpenItemAccounts(tenantId, asOf) {
      await requireEnabled(tenantId);
      const [{ accounts, lines }, matches] = await Promise.all([loadReport(tenantId, asOf), ledger.listMatches(tenantId)]);
      return openItemSummaries(accounts, lines, matches, asOf);
    },

    async getVatPreview(tenantId, period) {
      await requireEnabled(tenantId);
      const lines = await ledger.listReportLines(tenantId, { to: period.to });
      return computeVatPreview(lines.filter((line) => line.bookingDate >= period.from));
    },

    async getControls(tenantId, period) {
      const settings = await requireEnabled(tenantId);
      const ctx = await loadControlContext(tenantId, settings, period.to);
      return (await controlsFor(tenantId, ctx, period)).controls;
    },

    async getPeriodOverview(tenantId, year) {
      const settings = await requireEnabled(tenantId);
      const periods = vatPeriodsOfYear(year, settings.vatPeriod);
      const ctx = await loadControlContext(tenantId, settings, yearPeriod(year).to);
      const [filings, handovers] = await Promise.all([ledger.listFilings(tenantId), ledger.listHandovers(tenantId)]);
      const rows: PeriodOverviewRow[] = [];
      for (const period of periods) {
        const submitted = filings.find(
          (filing) =>
            filing.status === "submitted" &&
            (filing.kind === "annual_statement"
              ? yearStart(filing.periodFrom) <= period.from && yearEnd(filing.periodTo) >= period.to
              : filing.periodFrom <= period.from && filing.periodTo >= period.to),
        );
        const handover = handovers.find((candidate) => candidate.periodFrom <= period.from && candidate.periodTo >= period.to);
        const [{ controls, booked, proposed }, changesSince] = await Promise.all([
          controlsFor(tenantId, ctx, period),
          handover ? ledger.countRevisionsSince(tenantId, period, handover.createdAt) : Promise.resolve(0),
        ]);
        const derived = derivePeriodStatus({ submitted: Boolean(submitted), handover: handover ? { changesSince } : null, controls, bookedCount: booked, proposedCount: proposed });
        rows.push({
          key: period.key,
          from: period.from,
          to: period.to,
          status: derived.status,
          changesSince: derived.changesSince,
          failingControls: derived.failingControls,
          bookedCount: booked,
          proposedCount: proposed,
          submittedFilingId: submitted?.id ?? null,
        });
      }
      return rows;
    },

    // -----------------------------------------------------------------------------------------
    // Open items
    // -----------------------------------------------------------------------------------------
    async createMatch({ tenantId, userId, match }) {
      return transact(async (repos) => {
        await requireEnabled(tenantId, repos);
        const account = await requireAccountByNumber(repos, tenantId, match.accountNumber);
        if (!account.openItems) throw new UseCaseError(LEDGER_ERROR.accountNotOpenItems);
        const lineIds = [...new Set(match.lineIds)];
        const lines = await repos.ledger.findLines(tenantId, lineIds);
        if (lines.length !== lineIds.length || lines.some((line) => line.accountId !== account.id || line.entryStatus !== "booked")) {
          throw new UseCaseError(LEDGER_ERROR.lineNotOnAccount);
        }
        if ((await repos.ledger.findMatchedLineIds(tenantId, lineIds)).length > 0) throw new UseCaseError(LEDGER_ERROR.lineAlreadyMatched);
        if (match.kind === "match" && lineDifference(lines) !== 0) throw new UseCaseError(LEDGER_ERROR.matchNotZero);
        const row = await repos.ledger.insertMatch({ tenantId, accountId: account.id, kind: match.kind, note: match.note ?? null, createdByUserId: userId }, lineIds);
        return { matchId: row.id };
      });
    },

    async deleteMatch({ tenantId, matchId }) {
      await requireEnabled(tenantId);
      if (!(await ledger.deleteMatch(tenantId, matchId))) throw new UseCaseError(LEDGER_ERROR.notFound);
    },

    // -----------------------------------------------------------------------------------------
    // Booking rules
    // -----------------------------------------------------------------------------------------
    async listRules(tenantId) {
      await requireEnabled(tenantId);
      const [rules, accounts] = await Promise.all([ledger.listRules(tenantId), accountsById(tenantId)]);
      return Promise.all(rules.map((rule) => toRuleView(rule, accounts)));
    },

    async createRule({ tenantId, rule }) {
      await requireEnabled(tenantId);
      const row = await ledger.insertRule({ tenantId, ...(await ruleRow(deps.repos, tenantId, rule)) });
      return toRuleView(row, await accountsById(tenantId));
    },

    async updateRule({ tenantId, ruleId, rule }) {
      await requireEnabled(tenantId);
      const row = await ledger.updateRule(tenantId, ruleId, await ruleRow(deps.repos, tenantId, rule));
      if (!row) throw new UseCaseError(LEDGER_ERROR.notFound);
      return toRuleView(row, await accountsById(tenantId));
    },

    async deleteRule({ tenantId, ruleId }) {
      await requireEnabled(tenantId);
      if (!(await ledger.deleteRule(tenantId, ruleId))) throw new UseCaseError(LEDGER_ERROR.notFound);
    },

    // -----------------------------------------------------------------------------------------
    // Filings
    // -----------------------------------------------------------------------------------------
    async listFilings(tenantId) {
      await requireEnabled(tenantId);
      return (await ledger.listFilings(tenantId)).map(toFilingView);
    },

    async createFiling({ tenantId, userId, filing }) {
      return transact(async (repos) => {
        await requireEnabled(tenantId, repos);
        const periodFrom = filing.kind === "annual_statement" ? yearStart(filing.periodFrom) : filing.periodFrom;
        const periodTo = filing.kind === "annual_statement" ? yearEnd(filing.periodTo) : filing.periodTo;
        const overlaps = (await repos.ledger.listFilings(tenantId)).some(
          (other) => other.kind === filing.kind && other.correctsFilingId === null && other.periodFrom <= periodTo && other.periodTo >= periodFrom,
        );
        if (overlaps) throw new UseCaseError(LEDGER_ERROR.filingOverlaps);
        const row = await repos.ledger.insertFiling({
          tenantId,
          kind: filing.kind,
          status: filing.status,
          periodFrom,
          periodTo,
          submittedOn: filing.status === "submitted" ? (filing.submittedOn ?? null) : null,
          amountCents: filing.amountCents ?? null,
          correctsFilingId: null,
          note: filing.note ?? null,
          createdByUserId: userId,
        });
        return toFilingView(row);
      });
    },

    async submitFiling({ tenantId, filingId, submittedOn, amountCents }) {
      return transact(async (repos) => {
        await requireEnabled(tenantId, repos);
        const filing = await repos.ledger.findFiling(tenantId, filingId);
        if (!filing) throw new UseCaseError(LEDGER_ERROR.notFound);
        if (filing.status !== "draft") throw new UseCaseError(LEDGER_ERROR.filingNotDraft);
        const row = await repos.ledger.updateFiling(tenantId, filingId, { status: "submitted", submittedOn, amountCents: amountCents ?? filing.amountCents });
        if (!row) throw new UseCaseError(LEDGER_ERROR.notFound);
        return toFilingView(row);
      });
    },

    async createCorrectionFiling({ tenantId, userId, filingId }) {
      return transact(async (repos) => {
        await requireEnabled(tenantId, repos);
        const filing = await repos.ledger.findFiling(tenantId, filingId);
        if (!filing) throw new UseCaseError(LEDGER_ERROR.notFound);
        if (filing.status !== "submitted") throw new UseCaseError(LEDGER_ERROR.filingNotSubmitted);
        const open = (await repos.ledger.listFilings(tenantId)).some((other) => other.correctsFilingId === filing.id && other.status === "draft");
        if (open) throw new UseCaseError(LEDGER_ERROR.correctionExists);
        const row = await repos.ledger.insertFiling({
          tenantId,
          kind: filing.kind,
          status: "draft",
          periodFrom: filing.periodFrom,
          periodTo: filing.periodTo,
          submittedOn: null,
          amountCents: null,
          correctsFilingId: filing.id,
          note: null,
          createdByUserId: userId,
        });
        return toFilingView(row);
      });
    },

    // -----------------------------------------------------------------------------------------
    // Handovers
    // -----------------------------------------------------------------------------------------
    async createHandover({ tenantId, userId, periodFrom, periodTo, note }) {
      await requireEnabled(tenantId);
      const row = await ledger.insertHandover({ tenantId, periodFrom, periodTo, note: note ?? null, createdByUserId: userId });
      return { id: row.id, periodFrom: row.periodFrom, periodTo: row.periodTo, note: row.note, createdAt: row.createdAt.toISOString(), changesSince: 0 };
    },

    async listHandovers(tenantId) {
      await requireEnabled(tenantId);
      const rows = await ledger.listHandovers(tenantId);
      return Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          periodFrom: row.periodFrom,
          periodTo: row.periodTo,
          note: row.note,
          createdAt: row.createdAt.toISOString(),
          changesSince: await ledger.countRevisionsSince(tenantId, { from: row.periodFrom, to: row.periodTo }, row.createdAt),
        })),
      );
    },

    // -----------------------------------------------------------------------------------------
    // The tax advisor's balance lists
    // -----------------------------------------------------------------------------------------
    async uploadAdvisorBalances({ tenantId, userId, periodFrom, periodTo, fileName, csvText }) {
      await requireEnabled(tenantId);
      if (Buffer.byteLength(csvText, "utf8") > MAX_ADVISOR_FILE_BYTES) throw new UseCaseError(LEDGER_ERROR.advisorFileInvalid);
      const parsed = parseDatevBalanceList(csvText);
      if (!parsed.ok) throw new UseCaseError(LEDGER_ERROR.advisorFileInvalid);
      const row = await transact((repos) =>
        repos.ledger.insertAdvisorUpload({ tenantId, periodFrom, periodTo, fileName: fileName ?? null, uploadedByUserId: userId }, parsed.rows),
      );
      return { id: row.id, periodFrom: row.periodFrom, periodTo: row.periodTo, fileName: row.fileName, uploadedAt: row.uploadedAt.toISOString(), lineCount: parsed.rows.length };
    },

    async listAdvisorUploads(tenantId) {
      await requireEnabled(tenantId);
      return (await ledger.listAdvisorUploads(tenantId)).map((row) => ({
        id: row.id,
        periodFrom: row.periodFrom,
        periodTo: row.periodTo,
        fileName: row.fileName,
        uploadedAt: row.uploadedAt.toISOString(),
        lineCount: row.lineCount,
      }));
    },

    async getAdvisorComparison(tenantId, uploadId) {
      await requireEnabled(tenantId);
      const upload = await ledger.findAdvisorUpload(tenantId, uploadId);
      if (!upload) return null;
      const [theirs, { reportAccounts, lines }] = await Promise.all([ledger.listAdvisorLines(tenantId, upload.id), loadReport(tenantId, upload.periodTo)]);
      const balances = computeBalances(reportAccounts, lines, { from: upload.periodFrom, to: upload.periodTo });
      return {
        upload: { id: upload.id, periodFrom: upload.periodFrom, periodTo: upload.periodTo, fileName: upload.fileName, uploadedAt: upload.uploadedAt.toISOString(), lineCount: theirs.length },
        comparison: compareWithAdvisor(
          balances.rows.map((row) => ({ number: row.number, name: row.name, closingCents: row.closingCents })),
          theirs,
        ),
      };
    },

    async deleteAdvisorUpload({ tenantId, uploadId }) {
      await requireEnabled(tenantId);
      if (!(await ledger.deleteAdvisorUpload(tenantId, uploadId))) throw new UseCaseError(LEDGER_ERROR.notFound);
    },
    // -----------------------------------------------------------------------------------------
    // The proposal engine
    // -----------------------------------------------------------------------------------------
    async syncProposals({ tenantId, from, to }) {
      const settings = await requireEnabled(tenantId);
      // New bank or clearing accounts get their ledger account first, so their sources can be
      // proposed in the same run.
      await transact(async (repos) => {
        const tenant = await repos.tenant.lockForUpdate(tenantId);
        if (!tenant) throw new UseCaseError(LEDGER_ERROR.notFound);
        await seedChart(repos, tenantId);
      });
      const result: SyncProposalsResult = { created: 0, updated: 0, kept: 0, failed: 0, unproposed: 0, problems: [], deferred: 0, aiAsked: 0, aiCached: 0, aiUnavailable: 0, autoMatched: 0 };
      const snapshot = await loadSnapshot(tenantId, settings, { from, to });
      const advice = await adviseAll(tenantId, adviceQuestionsFor(snapshot), result);
      const plan = buildProposals(snapshot, advice, platformDisplayName);
      result.unproposed = plan.unproposed.length;
      result.problems = plan.problems;
      result.deferred = plan.deferred.length;

      for (const draft of plan.drafts) {
        try {
          const { outcome } = await api.upsertProposal({
            tenantId,
            proposal: { sourceKey: draft.sourceKey, entry: draft.entry, origin: draft.origin, originReason: draft.originReason, warnings: draft.warnings },
          });
          result[outcome]++;
        } catch (err) {
          if (!(err instanceof UseCaseError)) throw err;
          result.failed++;
        }
      }
      result.autoMatched = await api.autoMatchOpenItems(tenantId);
      return result;
    },

    async scheduleSync(tenantId) {
      if (!(await api.isEnabled(tenantId))) return false;
      await (deps.scheduleSync ?? noScheduler)(tenantId);
      return true;
    },

    async autoMatchOpenItems(tenantId) {
      await requireEnabled(tenantId);
      const matches = findAutoMatches(await ledger.listUnmatchedOpenItemLines(tenantId));
      let created = 0;
      for (const match of matches) {
        try {
          await transact(async (repos) => {
            // Re-checked inside the transaction: a concurrent run or a human may have matched
            // one of the lines since the read.
            if ((await repos.ledger.findMatchedLineIds(tenantId, match.lineIds)).length > 0) return;
            await repos.ledger.insertMatch({ tenantId, accountId: match.accountId, kind: "match", note: null, createdByUserId: null }, match.lineIds);
            created++;
          });
        } catch (err) {
          if (err instanceof UseCaseError && err.code === LEDGER_ERROR.lineAlreadyMatched) continue;
          throw err;
        }
      }
      return created;
    },

    async suggestMatches(tenantId, accountId) {
      await requireEnabled(tenantId);
      const account = await ledger.findAccountById(tenantId, accountId);
      if (!account) throw new UseCaseError(LEDGER_ERROR.accountNotFound);
      if (!account.openItems) throw new UseCaseError(LEDGER_ERROR.accountNotOpenItems);
      return suggestMatchGroups(await ledger.listUnmatchedOpenItemLines(tenantId, account.id));
    },

    async learnRuleFromEntry({ tenantId, entryId }) {
      await requireEnabled(tenantId);
      const entry = await ledger.findEntry(tenantId, entryId);
      if (!entry) throw new UseCaseError(LEDGER_ERROR.notFound);
      const [lines, accounts] = await Promise.all([ledger.listLines(tenantId, [entry.id]), accountsById(tenantId)]);

      let contactId: string | null = null;
      let counterpartyName: string | null = null;
      if (entry.documentId) {
        const links = await deps.sources.listDocumentContacts(tenantId, entry.documentId);
        const revenue = lines.some((line) => accounts.get(line.accountId)?.kind === "revenue");
        const role = revenue ? "recipient" : "sender";
        contactId = links.find((link) => link.role === role)?.contactId ?? null;
      } else if (entry.transactionId) {
        const tx = await deps.sources.findTransactionById(tenantId, entry.transactionId);
        counterpartyName = tx?.counterpartyName ?? null;
        if (counterpartyName) {
          const [contacts, aliasRows] = await Promise.all([deps.sources.listContacts(tenantId), deps.sources.listPaymentAliases(tenantId)]);
          contactId = resolveContactForCounterparty(
            counterpartyName,
            contacts.map((contact) => ({ id: contact.id, name: contact.name })),
            new Map(aliasRows.map((row) => [row.counterpartyNameNormalized, row.contactId])),
          );
        }
      }

      const rule = deriveRuleFromEntry({
        entryId: entry.id,
        source: entry.documentId ? "document" : "transaction",
        contactId,
        counterpartyName,
        lines: lines.flatMap((line) => {
          const account = accounts.get(line.accountId);
          if (!account) return [];
          return [{ accountNumber: account.number, kind: account.kind, group: account.group, openItems: account.openItems, ownerType: account.ownerType, amountCents: line.amountCents, taxCode: line.taxCode, taxRole: line.taxRole }];
        }),
      });
      if (!rule) throw new UseCaseError(LEDGER_ERROR.ruleSourceMissing);

      // One rule per contact (or counterparty pattern) and kind: learning again replaces it.
      const pattern = rule.counterpartyPattern ?? (rule.contactId ? null : counterpartyPatternOf(counterpartyName));
      const existing = (await ledger.listRules(tenantId)).find(
        (candidate) =>
          candidate.noDocument === rule.noDocument &&
          (rule.contactId ? candidate.contactId === rule.contactId : candidate.contactId === null && candidate.counterpartyPattern === pattern) &&
          (candidate.direction === rule.direction || candidate.direction === "any"),
      );
      // An existing rule keeps its direction unless the learned tax code does not fit it.
      const direction = existing && ruleTaxCodeFits(existing.direction, rule.taxCode) ? existing.direction : rule.direction;
      return existing ? api.updateRule({ tenantId, ruleId: existing.id, rule: { ...rule, direction } }) : api.createRule({ tenantId, rule });
    },
  };
  return api;
}
