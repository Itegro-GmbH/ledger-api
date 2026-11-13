// The ledger's tables (Digipost decisions/0080-ledger-double-entry-bookkeeping.md, moved here by
// decisions/0001-ledger-api.md). Only `repositories/drizzle/ledger-repository.ts` writes them.
// Table names, columns, checks and composite keys are Digipost's, with `tenant_id` in place of
// `workspace_id` (and `tenant` in place of `workspace` in constraint and index names), so the
// adoption migration can move Digipost's existing tables into this shape.
//
// Every table is tenant-owned and cascades from `tenants.id`. Ledger-internal references (lines
// to entries and accounts, matches to lines, rules to accounts) are real foreign keys, composite
// with `tenant_id` where a row points at another tenant-owned row, so a line can never land on
// another tenant's account.
//
// References OUT of the ledger (a document, a bank transaction, a money account, a contact, a
// user) are plain uuid values without a foreign key: a booked entry inside a submitted filing
// period is locked by a trigger (`sql/ledger_filing_lock/`), and an `on delete set null` from a
// deleted source would be an UPDATE that trigger refuses, or would silently change a filed entry.
// A caller shows "Beleg gelöscht" when a referenced source is gone.
//
// A booked entry's lines must sum to zero; a deferred constraint trigger enforces it at commit
// (`sql/ledger_balanced_entries/`).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import {
  BOOKING_RULE_DIRECTIONS,
  FILING_KINDS,
  FILING_STATUSES,
  JOURNAL_ENTRY_ORIGINS,
  JOURNAL_ENTRY_STATUSES,
  LEDGER_ACCOUNT_GROUPS,
  LEDGER_ACCOUNT_KINDS,
  LEDGER_CHARTS,
  LEDGER_OWNER_TYPES,
  OPEN_ITEM_MATCH_KINDS,
  REVISION_CHANGE_KINDS,
  TAX_CODES,
  TAX_ROLES,
  VAT_BASES,
  VAT_PERIODS,
  type BookingAdviceRaw,
  type DatevTenantSettings,
  type EntrySnapshot,
  type ProposalWarningCode,
} from "@ledger/core";

import { ledgerSchema, tenants } from "./platforms";

/** One row per tenant, created when the ledger settings are first saved. No row means the
 * ledger is off for that tenant (Digipost decisions/0080: off by default). */
export const ledgerSettings = ledgerSchema.table("ledger_settings", {
  tenantId: uuid()
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  enabled: boolean().notNull().default(false),
  vatPeriod: text({ enum: VAT_PERIODS }).notNull().default("month"),
  vatBasis: text({ enum: VAT_BASES }).notNull().default("soll"),
  /** The first day the books cover; nothing before it is expected to be booked. */
  startDate: date({ mode: "string" }),
  chart: text({ enum: LEDGER_CHARTS }).notNull().default("skr04"),
  /** The DATEV export's settings (`DatevTenantSettings`); `null` until the platform sets them. */
  datev: jsonb().$type<DatevTenantSettings | null>(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** The chart of accounts (SKR 04 numbers). Never deleted, only archived: lines point at it. */
export const ledgerAccounts = ledgerSchema.table(
  "ledger_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    number: text().notNull(),
    name: text().notNull(),
    kind: text({ enum: LEDGER_ACCOUNT_KINDS }).notNull(),
    group: text({ enum: LEDGER_ACCOUNT_GROUPS }).notNull(),
    openItems: boolean().notNull().default(false),
    ownerType: text({ enum: LEDGER_OWNER_TYPES }),
    /** Plain values, no foreign key (see the header). */
    ownerBankAccountId: uuid(),
    ownerContactId: uuid(),
    ownerPlatform: text(),
    ownerPersonName: text(),
    description: text(),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_accounts_tenant_number_key").on(t.tenantId, t.number),
    // The target of the composite foreign keys below.
    unique("ledger_accounts_tenant_id_key").on(t.tenantId, t.id),
    uniqueIndex("ledger_accounts_tenant_bank_owner_key").on(t.tenantId, t.ownerBankAccountId).where(sql`${t.ownerBankAccountId} is not null`),
    uniqueIndex("ledger_accounts_tenant_contact_owner_key").on(t.tenantId, t.ownerContactId).where(sql`${t.ownerContactId} is not null`),
    uniqueIndex("ledger_accounts_tenant_platform_owner_key").on(t.tenantId, t.ownerPlatform).where(sql`${t.ownerPlatform} is not null`),
    check("ledger_accounts_number_check", sql`${t.number} ~ '^[0-9]{4,8}$'`),
    check(
      "ledger_accounts_owner_check",
      sql`(coalesce(${t.ownerType}, '') = 'bank_account') = (${t.ownerBankAccountId} is not null)
        and (coalesce(${t.ownerType}, '') = 'contact') = (${t.ownerContactId} is not null)
        and (coalesce(${t.ownerType}, '') = 'platform') = (${t.ownerPlatform} is not null)
        and (coalesce(${t.ownerType}, '') = 'person') = (${t.ownerPersonName} is not null)`,
    ),
  ],
);

/** A filing sent to the tax office: a USt-VA for a period, or an annual statement for a year.
 * Once `submitted`, every booked entry in its period is locked (see the header). A correction
 * is a new row pointing at the filing it corrects; while it is a `draft`, entries assigned to
 * it may still change inside the locked period. */
export const ledgerFilings = ledgerSchema.table(
  "ledger_filings",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: text({ enum: FILING_KINDS }).notNull(),
    status: text({ enum: FILING_STATUSES }).notNull().default("draft"),
    periodFrom: date({ mode: "string" }).notNull(),
    periodTo: date({ mode: "string" }).notNull(),
    submittedOn: date({ mode: "string" }),
    /** Zahllast (positive) or refund (negative) as the submission protocol states it. */
    amountCents: integer(),
    /** `no action`: a tenant deletion removes both rows in the same statement. */
    correctsFilingId: uuid().references((): AnyPgColumn => ledgerFilings.id),
    note: text(),
    createdByUserId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_filings_tenant_id_key").on(t.tenantId, t.id),
    index("ledger_filings_tenant_period_idx").on(t.tenantId, t.periodFrom, t.periodTo),
    // One original filing per kind and period; corrections are separate rows.
    uniqueIndex("ledger_filings_original_key").on(t.tenantId, t.kind, t.periodFrom, t.periodTo).where(sql`${t.correctsFilingId} is null`),
    // At most one open correction per filing.
    uniqueIndex("ledger_filings_open_correction_key").on(t.correctsFilingId).where(sql`${t.correctsFilingId} is not null and ${t.status} = 'draft'`),
    check("ledger_filings_period_check", sql`${t.periodFrom} <= ${t.periodTo}`),
    check("ledger_filings_submitted_check", sql`${t.status} = 'draft' or ${t.submittedOn} is not null`),
  ],
);

export const journalEntries = ledgerSchema.table(
  "journal_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bookingDate: date({ mode: "string" }).notNull(),
    documentDate: date({ mode: "string" }),
    serviceDate: date({ mode: "string" }),
    text: text().notNull(),
    status: text({ enum: JOURNAL_ENTRY_STATUSES }).notNull().default("proposed"),
    origin: text({ enum: JOURNAL_ENTRY_ORIGINS }).notNull(),
    /** The AI's one-sentence reason, or the template/rule that produced the proposal. */
    originReason: text(),
    /** Idempotency key of the proposal engine ("doc:<id>", "tx:<id>", ...). Kept on a dismissed
     * proposal so the same source is never proposed again. */
    sourceKey: text(),
    /** Plain values, no foreign key (see the header). */
    documentId: uuid(),
    transactionId: uuid(),
    correctionOfEntryId: uuid(),
    /** A draft correcting filing this entry belongs to: the only way to change a locked period. */
    filingId: uuid(),
    warnings: jsonb().$type<ProposalWarningCode[]>().notNull().default([]),
    dismissedAt: timestamp({ withTimezone: true }),
    /** When a human last edited it; the proposal engine leaves such a proposal alone. */
    userEditedAt: timestamp({ withTimezone: true }),
    revision: integer().notNull().default(1),
    bookedAt: timestamp({ withTimezone: true }),
    bookedByUserId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("journal_entries_tenant_id_key").on(t.tenantId, t.id),
    uniqueIndex("journal_entries_tenant_source_key").on(t.tenantId, t.sourceKey).where(sql`${t.sourceKey} is not null`),
    index("journal_entries_tenant_booking_date_idx").on(t.tenantId, t.bookingDate),
    index("journal_entries_tenant_document_idx").on(t.tenantId, t.documentId),
    index("journal_entries_tenant_transaction_idx").on(t.tenantId, t.transactionId),
    foreignKey({ name: "journal_entries_filing_fk", columns: [t.tenantId, t.filingId], foreignColumns: [ledgerFilings.tenantId, ledgerFilings.id] }),
    check("journal_entries_dismissed_check", sql`${t.dismissedAt} is null or ${t.status} = 'proposed'`),
    check("journal_entries_booked_check", sql`${t.status} = 'proposed' or ${t.bookedAt} is not null`),
    check("journal_entries_revision_check", sql`${t.revision} >= 1`),
  ],
);

export const journalLines = ledgerSchema.table(
  "journal_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    entryId: uuid().notNull(),
    position: integer().notNull(),
    accountId: uuid().notNull(),
    /** Signed: debit (Soll) positive, credit (Haben) negative. */
    amountCents: integer().notNull(),
    taxCode: text({ enum: TAX_CODES }),
    taxRole: text({ enum: TAX_ROLES }),
    generatedFromLinePosition: integer(),
    /** The open item this line books or pays (a document id, plain value, see the header): the
     * invoice's line on an open-item account and its payment's lines carry the same one, so the
     * two can be matched (Digipost decisions/0080 phase 3). */
    documentId: uuid(),
    text: text(),
  },
  (t) => [
    unique("journal_lines_entry_position_key").on(t.entryId, t.position),
    index("journal_lines_tenant_account_idx").on(t.tenantId, t.accountId),
    index("journal_lines_tenant_document_idx").on(t.tenantId, t.documentId),
    foreignKey({ name: "journal_lines_entry_fk", columns: [t.tenantId, t.entryId], foreignColumns: [journalEntries.tenantId, journalEntries.id] }).onDelete("cascade"),
    foreignKey({ name: "journal_lines_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id] }),
    check("journal_lines_amount_check", sql`${t.amountCents} <> 0`),
    check("journal_lines_position_check", sql`${t.position} >= 1`),
    check("journal_lines_tax_role_check", sql`${t.taxRole} is null or ${t.taxCode} is not null`),
  ],
);

/** The full previous state of an entry on every change. `entry_ref` keeps the entry's id after
 * the entry itself is deleted (`entry_id` is then set null), so a deletion stays visible. */
export const journalEntryRevisions = ledgerSchema.table(
  "journal_entry_revisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    entryId: uuid().references(() => journalEntries.id, { onDelete: "set null" }),
    entryRef: uuid().notNull(),
    revision: integer().notNull(),
    changeKind: text({ enum: REVISION_CHANGE_KINDS }).notNull(),
    reason: text(),
    /** The entry's booking date after the change (before it, for a deletion): what a handover's
     * "changes since" counts by. */
    bookingDate: date({ mode: "string" }).notNull(),
    /** The entry and its lines BEFORE the change; `null` for `created`. */
    snapshot: jsonb().$type<EntrySnapshot | null>(),
    changedByUserId: text(),
    changedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("journal_entry_revisions_entry_idx").on(t.tenantId, t.entryRef, t.revision),
    // One revision per number and entry: two writers on one entry can never both record
    // "revision n" (the use cases also update conditionally on the revision they read).
    uniqueIndex("journal_entry_revisions_entry_revision_key").on(t.entryRef, t.revision),
    index("journal_entry_revisions_changed_idx").on(t.tenantId, t.changedAt),
  ],
);

export const ledgerOpenItemMatches = ledgerSchema.table(
  "ledger_open_item_matches",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    accountId: uuid().notNull(),
    kind: text({ enum: OPEN_ITEM_MATCH_KINDS }).notNull(),
    note: text(),
    createdByUserId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_open_item_matches_account_idx").on(t.tenantId, t.accountId),
    foreignKey({ name: "ledger_open_item_matches_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id] }),
    check("ledger_open_item_matches_note_check", sql`${t.kind} = 'match' or ${t.note} is not null`),
  ],
);

/** A line belongs to at most one match. */
export const ledgerOpenItemMatchLines = ledgerSchema.table(
  "ledger_open_item_match_lines",
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    matchId: uuid()
      .notNull()
      .references(() => ledgerOpenItemMatches.id, { onDelete: "cascade" }),
    lineId: uuid()
      .notNull()
      .references(() => journalLines.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.lineId] }), unique("ledger_open_item_match_lines_line_key").on(t.lineId)],
);

/** "Für <Kontakt> künftig so vorschlagen": a contact or counterparty pattern to an account and
 * tax code, optionally booked against an open-item account instead of the payables. */
export const ledgerBookingRules = ledgerSchema.table(
  "ledger_booking_rules",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Plain value, no foreign key (see the header). */
    contactId: uuid(),
    /** Lowercase; a counterparty name containing it matches. */
    counterpartyPattern: text(),
    direction: text({ enum: BOOKING_RULE_DIRECTIONS }).notNull().default("any"),
    accountId: uuid().notNull(),
    taxCode: text({ enum: TAX_CODES }),
    paymentAccountId: uuid(),
    /** A rule for a bank transaction without a document (share capital to 2900). */
    noDocument: boolean().notNull().default(false),
    active: boolean().notNull().default(true),
    hits: integer().notNull().default(0),
    learnedFromEntryId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_booking_rules_tenant_idx").on(t.tenantId, t.active),
    foreignKey({ name: "ledger_booking_rules_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id] }),
    foreignKey({
      name: "ledger_booking_rules_payment_account_fk",
      columns: [t.tenantId, t.paymentAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    check("ledger_booking_rules_target_check", sql`${t.contactId} is not null or ${t.counterpartyPattern} is not null`),
    check("ledger_booking_rules_hits_check", sql`${t.hits} >= 0`),
  ],
);

/** "An Steuerberaterin übergeben": a marker; changes since are revisions written after it. */
export const ledgerHandovers = ledgerSchema.table(
  "ledger_handovers",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    periodFrom: date({ mode: "string" }).notNull(),
    periodTo: date({ mode: "string" }).notNull(),
    note: text(),
    createdByUserId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ledger_handovers_tenant_idx").on(t.tenantId, t.createdAt), check("ledger_handovers_period_check", sql`${t.periodFrom} <= ${t.periodTo}`)],
);

/** An uploaded Summen- und Saldenliste of the tax advisor, kept for the comparison. */
export const ledgerAdvisorBalances = ledgerSchema.table(
  "ledger_advisor_balances",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    periodFrom: date({ mode: "string" }).notNull(),
    periodTo: date({ mode: "string" }).notNull(),
    fileName: text(),
    uploadedByUserId: text(),
    uploadedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_advisor_balances_tenant_id_key").on(t.tenantId, t.id),
    index("ledger_advisor_balances_tenant_idx").on(t.tenantId, t.periodTo),
    check("ledger_advisor_balances_period_check", sql`${t.periodFrom} <= ${t.periodTo}`),
  ],
);

export const ledgerAdvisorBalanceLines = ledgerSchema.table(
  "ledger_advisor_balance_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    uploadId: uuid().notNull(),
    accountNumber: text().notNull(),
    accountName: text(),
    /** Signed like the ledger: Soll positive, Haben negative. */
    balanceCents: integer().notNull(),
  },
  (t) => [
    index("ledger_advisor_balance_lines_upload_idx").on(t.uploadId),
    foreignKey({
      name: "ledger_advisor_balance_lines_upload_fk",
      columns: [t.tenantId, t.uploadId],
      foreignColumns: [ledgerAdvisorBalances.tenantId, ledgerAdvisorBalances.id],
    }).onDelete("cascade"),
  ],
);

/** The AI booking advisor's last answer per document (Digipost decisions/0080 phase 3), of any kind, so a
 * sync never asks the same question twice: `cache_key` hashes the whole question and the
 * advisor's version (`bookingAdviceCacheKey`), and a different key asks again and replaces the
 * row. The document id is a plain value (see the header). */
export const ledgerBookingAdvice = ledgerSchema.table(
  "ledger_booking_advice",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid().notNull(),
    cacheKey: text().notNull(),
    /** The raw answer as `toCacheableBookingAdvice` stores it; validated again on every use. */
    answer: jsonb().$type<BookingAdviceRaw>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("ledger_booking_advice_tenant_document_key").on(t.tenantId, t.documentId)],
);
