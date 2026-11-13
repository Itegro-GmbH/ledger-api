// The ledger's sources (decisions/0001-ledger-api.md, "What the service owns, and what platforms
// send"): counterparties, money accounts, money movements (bank transactions and platform
// settlement lines), movement-to-document links, learned payment names, no-document rules, and the
// accounting view of a platform's documents. Only `repositories/drizzle/source-repository.ts`
// writes them; the ledger reads them through `sources/drizzle-source-reader.ts`.
//
// Every table but `documents` is a port of the Digipost table of the same name (Digipost's
// `src/persistence/schema/{accounts,contacts,payments}.ts`): same table name, columns, checks,
// indexes and internal foreign keys, with `tenant_id` in place of `workspace_id` (a foreign key to
// `tenants` on delete cascade) and `tenant` in place of `workspace` in constraint and index names.
// The switch copies Digipost's rows into these tables with `INSERT ... SELECT`, keeping every id
// (decisions/0001 "Production setup"), so the shapes must match column for column.
//
// Digipost's foreign keys to tables that do not exist here (its `documents` and `user`) are plain
// uuid columns. That includes every document reference: a movement, settlement line or link names
// the platform's document id, and not every such document has an accounting view here (a bank
// statement, a letter), nor may a document deleted on the platform's side delete financial
// history.
//
// `documents` is new: what a platform pushes after analysing a document (`upsert_documents`). Its
// id is the platform's own document id, so links, settlement lines and journal entries that name a
// Digipost document keep pointing at the same id.
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, real, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import type { ProposalTaxBreakdownEntry } from "@ledger/core";

import { MONEY_ACCOUNT_TYPES, SETTLEMENT_LINE_TYPES } from "../sources/source-reader";
import { ledgerSchema, tenants } from "./platforms";

export const CONTACT_RELATION_TYPES = ["supplier", "customer", "authority", "insurance", "bank", "other"] as const;
export type ContactRelationType = (typeof CONTACT_RELATION_TYPES)[number];

/** `auto`: created by a platform's pipeline; `manual`: entered by a person. */
export const CONTACT_SOURCES = ["auto", "manual"] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export const CREDIT_DEBIT_INDICATORS = ["credit", "debit"] as const;
export type CreditDebitIndicator = (typeof CREDIT_DEBIT_INDICATORS)[number];

export const DOCUMENT_TRANSACTION_STATUSES = ["suggested", "confirmed", "rejected"] as const;
export type DocumentTransactionStatus = (typeof DOCUMENT_TRANSACTION_STATUSES)[number];

export const MATCH_KINDS = ["exact", "skonto", "partial", "collective", "ai", "manual"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

export const MATCHED_BY_VALUES = ["auto", "ai", "user"] as const;
export type MatchedBy = (typeof MATCHED_BY_VALUES)[number];

/** Digipost's document taxonomy (`@/modules/intake`'s `DOCUMENT_KINDS`). The ledger books the
 * kinds in `LEDGER_BOOKABLE_DOCUMENT_KINDS` and ignores the rest. */
export const DOCUMENT_KINDS = [
  "letter",
  "incoming_invoice",
  "outgoing_invoice",
  "reminder",
  "receipt",
  "bank_statement",
  "payout_report",
  "platform_settlement",
  "contract",
  "authority_letter",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_DIRECTIONS = ["incoming", "outgoing", "unknown"] as const;
export type DocumentDirection = (typeof DOCUMENT_DIRECTIONS)[number];

/** Counterparties ("Firmenkontakte"). Only `name` is required. `name_normalized`,
 * `vat_id_normalized` and `iban_normalized` are computed by application code (`normalizeName`,
 * uppercase without spaces), never typed by hand. Two contacts may share an IBAN (factoring, a
 * group's treasury), so only the VAT id is unique. */
export const contacts = ledgerSchema.table(
  "contacts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    // Identity
    name: text().notNull(),
    legalForm: text(),
    addressLine1: text(),
    addressLine2: text(),
    postalCode: text(),
    city: text(),
    country: text().default("DE"),

    // Tax / register
    vatId: text(),
    taxNumber: text(),
    registerCourt: text(),
    registerNumber: text(),
    leitwegId: text(),

    // Banking
    iban: text(),
    bic: text(),
    bankName: text(),
    accountHolder: text(),
    sepaCreditorId: text(),

    // Communication
    phone: text(),
    email: text(),
    website: text(),
    contactPerson: text(),

    // Relationship
    customerNumber: text(),
    supplierNumber: text(),
    paymentTermsDays: integer(),
    relationType: text({ enum: CONTACT_RELATION_TYPES }),
    notes: text(),

    // Provenance / trust
    source: text({ enum: CONTACT_SOURCES }).notNull(),
    verifiedAt: timestamp({ withTimezone: true }),
    /** A Digipost user id; no foreign key (users stay in Digipost). */
    verifiedByUserId: uuid(),
    /** A platform document id; no foreign key (see the header). */
    firstSeenDocumentId: uuid(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

    // Matching columns, maintained by application code.
    nameNormalized: text().notNull(),
    vatIdNormalized: text(),
    ibanNormalized: text(),
  },
  (t) => [
    check("contacts_relation_type_check", sql`${t.relationType} is null or ${t.relationType} in ('supplier', 'customer', 'authority', 'insurance', 'bank', 'other')`),
    check("contacts_source_check", sql`${t.source} in ('auto', 'manual')`),
    uniqueIndex("contacts_tenant_vat_normalized_key")
      .on(t.tenantId, t.vatIdNormalized)
      .where(sql`${t.vatIdNormalized} is not null`),
    index("contacts_tenant_iban_normalized_idx").on(t.tenantId, t.ibanNormalized),
    index("contacts_tenant_name_normalized_postal_idx").on(t.tenantId, t.nameNormalized, t.postalCode),
    index("contacts_tenant_name_idx").on(t.tenantId, t.name),
  ],
);

/** Money accounts: a bank account (`bank`) or a clearing account (`clearing`) owned by a
 * settlement `platform` or by a supplier `contact_id`, never both. `iban` is stored normalized and
 * unique per tenant when set; at most one clearing account per platform and per contact. */
export const accounts = ledgerSchema.table(
  "accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: text({ enum: MONEY_ACCOUNT_TYPES }).notNull(),
    name: text().notNull(),
    iban: text(),
    bic: text(),
    currency: text().notNull().default("EUR"),
    holder: text(),
    /** Only for `type: "clearing"`: the settlement platform (`stripe`, `apple`, ...). */
    platform: text(),
    /** Only for `type: "clearing"`: the supplier whose charges and invoices never pair one to one.
     * `on delete set null`: deleting a contact never deletes financial history. */
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("accounts_type_check", sql`${t.type} in ('bank', 'clearing')`),
    index("accounts_tenant_idx").on(t.tenantId),
    unique("accounts_tenant_iban_key").on(t.tenantId, t.iban),
    uniqueIndex("accounts_tenant_platform_clearing_key")
      .on(t.tenantId, t.platform)
      .where(sql`${t.type} = 'clearing'`),
    uniqueIndex("accounts_tenant_contact_clearing_key")
      .on(t.tenantId, t.contactId)
      .where(sql`${t.type} = 'clearing'`),
    check("accounts_clearing_owner_check", sql`${t.platform} is null or ${t.contactId} is null`),
  ],
);

/** One statement import (or one pushed batch with statement figures): its opening balance is what
 * the bank comparison starts from. One batch per source document when it has one. */
export const importBatches = ledgerSchema.table(
  "import_batches",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** A platform document id; no foreign key (see the header). */
    sourceDocumentId: uuid(),
    statementFrom: date({ mode: "string" }),
    statementTo: date({ mode: "string" }),
    openingBalanceCents: integer(),
    closingBalanceCents: integer(),
    rowsTotal: integer().notNull(),
    rowsImported: integer().notNull(),
    rowsDuplicate: integer().notNull(),
    /** Opening balance plus the movements does not give the closing balance: a data-quality
     * signal, never a reason to refuse the import. */
    balanceMismatch: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("import_batches_tenant_account_idx").on(t.tenantId, t.accountId), unique("import_batches_source_document_key").on(t.sourceDocumentId)],
);

/** Money movements on a money account. Signed cents, money in positive. `idempotency_key` is
 * unique per account: the caller's external id of the movement (a Stripe balance transaction id, a
 * bank end-to-end id, Digipost's statement hash), so pushing a movement again inserts nothing.
 * `transfer_group_id` pairs a payout on a clearing account with its bank deposit. */
export const transactions = ledgerSchema.table(
  "transactions",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    bookingDate: date({ mode: "string" }).notNull(),
    valueDate: date({ mode: "string" }),
    amountCents: integer().notNull(),
    currency: text(),
    creditDebit: text({ enum: CREDIT_DEBIT_INDICATORS }).notNull(),
    counterpartyName: text(),
    counterpartyIban: text(),
    counterpartyBic: text(),
    remittanceText: text(),
    endToEndId: text(),
    mandateId: text(),
    creditorId: text(),
    bankTxCode: text(),
    bankReference: text(),
    idempotencyKey: text().notNull(),
    importBatchId: uuid().references(() => importBatches.id, { onDelete: "set null" }),
    /** A platform document id; no foreign key (see the header). */
    sourceDocumentId: uuid(),
    transferGroupId: uuid(),
    /** The movement as the caller sent it, verbatim: an audit trail next to the typed columns. */
    raw: jsonb(),
    /** "Kein Beleg nötig": a person's marker that no document will ever explain this movement. */
    noDocumentNeeded: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("transactions_credit_debit_check", sql`${t.creditDebit} in ('credit', 'debit')`),
    unique("transactions_account_idempotency_key").on(t.accountId, t.idempotencyKey),
    index("transactions_tenant_booking_date_idx").on(t.tenantId, t.bookingDate.desc()),
    index("transactions_account_booking_date_idx").on(t.accountId, t.bookingDate.desc()),
    index("transactions_tenant_counterparty_iban_idx").on(t.tenantId, t.counterpartyIban),
    index("transactions_tenant_amount_idx").on(t.tenantId, t.amountCents),
  ],
);

/** One line of a platform's settlement report on its clearing account (`revenue`, `fee`,
 * `refund`, `payout`, `adjustment`), unique per report document and external line id.
 * `transaction_id` is the movement the same import wrote on the clearing account. */
export const settlementLines = ledgerSchema.table(
  "settlement_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clearingAccountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** A platform document id; no foreign key (see the header). */
    sourceDocumentId: uuid().notNull(),
    transactionId: uuid().references(() => transactions.id, { onDelete: "set null" }),
    type: text({ enum: SETTLEMENT_LINE_TYPES }).notNull(),
    externalLineId: text().notNull(),
    grossCents: integer(),
    feeCents: integer(),
    netCents: integer(),
    currency: text(),
    bookingDate: date({ mode: "string" }),
    payoutId: text(),
    chargeId: text(),
    invoiceId: text(),
    customerName: text(),
    customerEmail: text(),
    productName: text(),
    countryOfSale: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("settlement_lines_type_check", sql`${t.type} in ('revenue', 'fee', 'refund', 'payout', 'adjustment')`),
    unique("settlement_lines_document_external_key").on(t.sourceDocumentId, t.externalLineId),
    index("settlement_lines_tenant_idx").on(t.tenantId),
    index("settlement_lines_clearing_account_idx").on(t.clearingAccountId),
    index("settlement_lines_tenant_type_idx").on(t.tenantId, t.type),
    index("settlement_lines_account_type_booking_date_idx").on(t.clearingAccountId, t.type, t.bookingDate),
  ],
);

/** Which document a movement pays. Only `confirmed` rows count (with `allocated_amount_cents`, the
 * positive part of the movement this document claims); `suggested` and `rejected` rows are
 * Digipost's matching history, copied at the switch. One row per pair. */
export const documentTransactions = ledgerSchema.table(
  "document_transactions",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** A platform document id; no foreign key (see the header). */
    documentId: uuid().notNull(),
    transactionId: uuid()
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    status: text({ enum: DOCUMENT_TRANSACTION_STATUSES }).notNull().default("suggested"),
    kind: text({ enum: MATCH_KINDS }).notNull(),
    confidence: real().notNull(),
    reasons: jsonb().notNull().default([]),
    explanation: text(),
    matchedBy: text({ enum: MATCHED_BY_VALUES }).notNull(),
    allocatedAmountCents: integer().notNull(),
    /** Digipost's AI arbiter cache key on a `kind: "ai"` row; `null` otherwise. */
    arbiterCacheKey: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp({ withTimezone: true }),
    /** A Digipost user id; no foreign key (users stay in Digipost). */
    decidedByUserId: uuid(),
  },
  (t) => [
    unique("document_transactions_document_transaction_key").on(t.documentId, t.transactionId),
    index("document_transactions_tenant_status_idx").on(t.tenantId, t.status),
    index("document_transactions_transaction_idx").on(t.transactionId),
    check("document_transactions_status_check", sql`${t.status} in ('suggested', 'confirmed', 'rejected')`),
    check("document_transactions_kind_check", sql`${t.kind} in ('exact', 'skonto', 'partial', 'collective', 'ai', 'manual')`),
    check("document_transactions_matched_by_check", sql`${t.matchedBy} in ('auto', 'ai', 'user')`),
  ],
);

/** A learned payment name: a normalized counterparty name (`aliasKeyForCounterparty`) to the
 * contact it refers to. One per name per tenant; the latest confirmation wins. */
export const paymentAliases = ledgerSchema.table(
  "payment_aliases",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    counterpartyNameNormalized: text().notNull(),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** A Digipost user id; no foreign key (users stay in Digipost). */
    learnedFromUserId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("payment_aliases_tenant_name_key").on(t.tenantId, t.counterpartyNameNormalized)],
);

/** "Kein Beleg nötig, für diese Gegenpartei immer": a standing rule per normalized counterparty
 * name. */
export const paymentNoDocumentRules = ledgerSchema.table(
  "payment_no_document_rules",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    counterpartyNameNormalized: text().notNull(),
    /** A Digipost user id; no foreign key (users stay in Digipost). */
    createdByUserId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("payment_no_document_rules_tenant_name_key").on(t.tenantId, t.counterpartyNameNormalized)],
);

/** The accounting view of a platform's document (`upsert_documents`): what the proposal engine
 * books. The file, OCR text and processing stay with the platform; `file_url` links to it. The id
 * is the platform's own document id. `kind` is the effective kind (a person's correction over the
 * classified one), `contact_id` the counterparty the direction implies (the sender of an incoming
 * document, the recipient of an outgoing one). Amounts are cents, negative for a credit note. */
export const documents = ledgerSchema.table(
  "documents",
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The platform's own reference for it (a file name, a number), unique per tenant when set. */
    externalRef: text(),
    kind: text({ enum: DOCUMENT_KINDS }).notNull(),
    direction: text({ enum: DOCUMENT_DIRECTIONS }),
    title: text(),
    /** The sender's name as printed. */
    sender: text(),
    /** A one-paragraph summary (never the OCR text): what the AI advisor may be told. */
    summary: text(),
    originalFileName: text(),
    fileUrl: text(),
    invoiceNumber: text(),
    documentDate: date({ mode: "string" }),
    dueDate: date({ mode: "string" }),
    serviceDate: date({ mode: "string" }),
    servicePeriodFrom: date({ mode: "string" }),
    servicePeriodTo: date({ mode: "string" }),
    currency: text(),
    totalAmountCents: integer(),
    netTotalCents: integer(),
    taxTotalCents: integer(),
    /** "Durchlaufende Posten" / "Auslagen ohne USt". */
    passThroughCents: integer(),
    /** One entry per printed VAT rate; `null` when no breakdown is printed. */
    taxBreakdown: jsonb().$type<ProposalTaxBreakdownEntry[]>(),
    /** `true` when the recipient owes the VAT; `null` when nothing was said. */
    reverseCharge: boolean(),
    /** The settlement platform a payout report or settlement comes from. */
    platform: text(),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("documents_kind_check", sql`${t.kind} in (${sql.raw(DOCUMENT_KINDS.map((kind) => `'${kind}'`).join(", "))})`),
    check("documents_direction_check", sql`${t.direction} is null or ${t.direction} in ('incoming', 'outgoing', 'unknown')`),
    index("documents_tenant_document_date_idx").on(t.tenantId, t.documentDate),
    index("documents_tenant_contact_idx").on(t.tenantId, t.contactId),
    uniqueIndex("documents_tenant_external_ref_key")
      .on(t.tenantId, t.externalRef)
      .where(sql`${t.externalRef} is not null`),
  ],
);
