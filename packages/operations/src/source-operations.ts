// The sources a platform sends (decisions/0001-ledger-api.md, "What the service owns, and what
// platforms send"): counterparties, money accounts, money movements, the accounting view of
// documents, which document a movement pays, which movements need no document, and learned payment
// names. Nothing here books: `sync_proposals` turns the sources into proposals, `book_entries`
// books them. Amounts are integer cents; a movement is signed, money in positive.
import { MAX_BULK_ENTRIES } from "@ledger/core";
import { CONTACT_RELATION_TYPES, CONTACT_SOURCES, DOCUMENT_DIRECTIONS, DOCUMENT_KINDS, MONEY_ACCOUNT_TYPES } from "@ledger/db";
import { z } from "zod";

import { defineOperation } from "./kit";
import { withTenant } from "./use-case";

const isoDate = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .describe("ISO 4217, e.g. EUR");
const cents = z.number().int().safe();
const paging = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(50),
};
const MAX_BATCH = 500;
const MAX_MOVEMENTS = 1000;

function page<T>(result: { items: T[]; total: number }, input: { offset: number; limit: number }, view: (row: T) => Record<string, unknown>) {
  return { items: result.items.map(view), total: result.total, offset: input.offset, hasMore: input.offset + input.limit < result.total };
}

/** Without the tenant and the matching columns the service maintains itself. */
function counterpartyView<T extends { tenantId: string; nameNormalized: string; vatIdNormalized: string | null; ibanNormalized: string | null }>(row: T) {
  const { tenantId: _tenantId, nameNormalized: _name, vatIdNormalized: _vat, ibanNormalized: _iban, ...rest } = row;
  return rest;
}

/** A movement as listed: `externalId` is the stored idempotency key. */
function movementView<T extends { tenantId: string; idempotencyKey: string }>(row: T) {
  const { tenantId: _tenantId, idempotencyKey, ...rest } = row;
  return { externalId: idempotencyKey, ...rest };
}

/** A document or money account as listed: `counterpartyId` for the stored contact id. */
function withCounterpartyId<T extends { tenantId: string; contactId: string | null }>(row: T) {
  const { tenantId: _tenantId, contactId, ...rest } = row;
  return { ...rest, counterpartyId: contactId };
}

// --- Counterparties ----------------------------------------------------------------------------

const counterpartyFields = z.object({
  id: z.uuid().optional().describe("Keep your own id (or an existing one); a new one is generated otherwise. An existing id is updated."),
  name: text(300),
  legalForm: optionalText(100),
  addressLine1: optionalText(300),
  addressLine2: optionalText(300),
  postalCode: optionalText(20),
  city: optionalText(200),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional()
    .describe("ISO 3166-1 alpha-2, default DE"),
  vatId: optionalText(30).describe("USt-IdNr., unique per tenant"),
  taxNumber: optionalText(30),
  registerCourt: optionalText(200),
  registerNumber: optionalText(50),
  leitwegId: optionalText(50),
  iban: optionalText(42),
  bic: optionalText(11),
  bankName: optionalText(200),
  accountHolder: optionalText(200),
  sepaCreditorId: optionalText(35),
  phone: optionalText(50),
  email: optionalText(320),
  website: optionalText(300),
  contactPerson: optionalText(200),
  customerNumber: optionalText(50),
  supplierNumber: optionalText(50),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  relationType: z.enum(CONTACT_RELATION_TYPES).nullable().optional(),
  notes: optionalText(2000),
  source: z.enum(CONTACT_SOURCES).optional().describe("auto: found by your pipeline (default for a new one); manual: entered by a person"),
  verified: z.boolean().optional().describe("true: a person checked it (recorded with the actor); false: clears that"),
});

export const upsertCounterparties = defineOperation({
  name: "upsert_counterparties",
  title: "Upsert counterparties",
  description:
    "Creates or updates counterparties (suppliers, customers, authorities) of a tenant. With an id that exists, only " +
    "the fields given are changed; without one, a new counterparty is created. Name, VAT id and IBAN are normalized " +
    "for matching bank movements. All or nothing: one refusal (vat_id_taken, counterparty_id_taken) writes none. " +
    "Returns each counterparty with created true or false, in input order.",
  input: z.object({ counterparties: z.array(counterpartyFields).min(1).max(MAX_BATCH) }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId, actor }) => {
      const written = await services.sources.upsertCounterparties({ tenantId, actor, counterparties: input.counterparties });
      return { counterparties: written.map(({ row, created }) => ({ ...counterpartyView(row), created })) };
    });
  },
});

export const listCounterparties = defineOperation({
  name: "list_counterparties",
  title: "List counterparties",
  description: "A tenant's counterparties, by name, optionally only those whose name contains search.",
  input: z.object({ search: z.string().trim().min(1).max(200).optional(), ...paging }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId }) => page(await services.sources.listCounterparties(tenantId, { search: input.search }, input), input, counterpartyView));
  },
});

// --- Money accounts ----------------------------------------------------------------------------

export const createMoneyAccount = defineOperation({
  name: "create_money_account",
  title: "Create money account",
  description:
    "Creates a money account: type 'bank' (a bank account, with its IBAN) or 'clearing' (a payment provider's " +
    "balance such as Stripe, or an app store, named by platform; or a supplier charged by card whose invoices never " +
    "pair one to one with its charges, named by counterpartyId). A clearing account has exactly one of platform and " +
    "counterpartyId, a bank account neither. The ledger gives it its own ledger account at the next sync_proposals.",
  input: z.object({
    type: z.enum(MONEY_ACCOUNT_TYPES),
    name: text(200),
    iban: optionalText(42).describe("Unique per tenant"),
    bic: optionalText(11),
    currency: currency.default("EUR"),
    holder: optionalText(200),
    platform: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(50)
      .nullable()
      .optional()
      .describe("A clearing account's platform, e.g. stripe, apple, google, paypal; one account per platform"),
    counterpartyId: z.uuid().nullable().optional().describe("A clearing account's supplier; one account per counterparty"),
  }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId }) => {
      const { counterpartyId, ...account } = input;
      const created = await services.sources.createMoneyAccount({ tenantId, account: { ...account, contactId: counterpartyId ?? null } });
      return { account: withCounterpartyId(created) };
    });
  },
});

export const updateMoneyAccount = defineOperation({
  name: "update_money_account",
  title: "Update money account",
  description: "Renames a money account or changes its IBAN, BIC, currency or holder. Its type and owner never change.",
  input: z.object({ id: z.uuid(), name: text(200).optional(), iban: optionalText(42), bic: optionalText(11), currency: currency.optional(), holder: optionalText(200) }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId }) => {
      const { id, ...patch } = input;
      return { account: withCounterpartyId(await services.sources.updateMoneyAccount({ tenantId, accountId: id, patch })) };
    });
  },
});

export const listMoneyAccounts = defineOperation({
  name: "list_money_accounts",
  title: "List money accounts",
  description: "A tenant's bank and clearing accounts, oldest first, each with its number of movements and the sum of their amounts (balanceCents).",
  input: z.object({}),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(_input, ctx) {
    return withTenant(ctx, async ({ services, tenantId }) => ({ accounts: (await services.sources.listMoneyAccounts(tenantId)).map(withCounterpartyId) }));
  },
});

// --- Money movements ---------------------------------------------------------------------------

const movementFields = z.object({
  externalId: text(200).describe("Your id of the movement, unique per account: a Stripe balance transaction id, a bank end-to-end id or a hash"),
  bookingDate: isoDate,
  valueDate: isoDate.nullable().optional(),
  amountCents: cents.refine((value) => value !== 0, "a movement moves money").describe("Signed cents: money in positive, money out negative"),
  currency: currency.nullable().optional().describe("Default: the account's currency"),
  counterpartyName: optionalText(300),
  counterpartyIban: optionalText(42),
  counterpartyBic: optionalText(11),
  remittanceText: optionalText(1000),
  endToEndId: optionalText(100),
  mandateId: optionalText(100),
  creditorId: optionalText(100),
  bankTxCode: optionalText(100).describe("The bank's or provider's type code, e.g. a Stripe type: charge, application_fee, refund, payout"),
  bankReference: optionalText(200),
  transferGroupId: z.uuid().nullable().optional().describe("The same id on a payout of a clearing account and on its deposit on the bank account pairs them"),
  sourceDocumentId: z.uuid().nullable().optional().describe("Your document the movement was read from (a statement)"),
});

export const upsertMoneyMovements = defineOperation({
  name: "upsert_money_movements",
  title: "Upsert money movements",
  description:
    "Adds movements to a money account, idempotent by externalId per account: a movement sent again is not added " +
    "twice, only its descriptive fields (counterparty, text, codes) are refreshed. Its booking date and amount never " +
    "change once stored (a booking may rest on them); a differing one is listed in conflicts. With statement, the " +
    "push is recorded as one statement whose opening balance the bank comparison starts from. All or nothing. " +
    "Returns created and existing counts and each movement's id in input order.",
  input: z.object({
    accountId: z.uuid(),
    movements: z.array(movementFields).min(1).max(MAX_MOVEMENTS),
    statement: z
      .object({
        from: isoDate.nullable().optional(),
        to: isoDate.nullable().optional(),
        openingBalanceCents: cents.nullable().optional(),
        closingBalanceCents: cents.nullable().optional(),
        sourceDocumentId: z.uuid().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId }) => ({ ...(await services.sources.upsertMovements({ tenantId, accountId: input.accountId, movements: input.movements, statement: input.statement })) }));
  },
});

/** Below the 4.5 MB request body Vercel accepts; a year of a busy account fits. */
const MAX_STATEMENT_LENGTH = 4_000_000;

export const importBankStatement = defineOperation({
  name: "import_bank_statement",
  title: "Import bank statement",
  description:
    "Imports a camt.053 bank statement (ISO 20022 XML, versions .001.02 to .001.08, as German banks export it) as " +
    "movements: onto accountId, or onto the bank account whose IBAN the statement names. Idempotent: importing the " +
    "same statement again, or an overlapping one, adds only what is new (each movement is keyed by a hash of all its " +
    "fields, the same key Digipost uses). Records each statement's opening and closing balance and whether they " +
    "reconcile with the movements. Refused: statement_invalid (not camt.053, or a DOCTYPE), " +
    "statement_account_mismatch, money_account_not_found.",
  input: z.object({
    xml: z.string().min(1).max(MAX_STATEMENT_LENGTH),
    accountId: z.uuid().optional(),
    sourceDocumentId: z.uuid().nullable().optional().describe("Your document holding the statement; one import record per document"),
  }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId }) => ({ ...(await services.sources.importBankStatement({ tenantId, ...input })) }));
  },
});

export const listMoneyMovements = defineOperation({
  name: "list_money_movements",
  title: "List money movements",
  description:
    "Movements, newest first, each with the documents it pays (links with allocated cents). Filter by account, " +
    "booking-date range, a search in counterparty name and text, or unlinked: true for those no document explains " +
    "yet and not marked 'no document needed'.",
  input: z.object({
    accountId: z.uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    search: z.string().trim().min(1).max(200).optional(),
    unlinked: z.boolean().optional(),
    ...paging,
  }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId }) => {
      const { offset, limit, ...filter } = input;
      return page(await services.sources.listMovements(tenantId, filter, { offset, limit }), input, movementView);
    });
  },
});

// --- Documents ---------------------------------------------------------------------------------

const documentFields = z.object({
  id: z.uuid().describe("Your own document id; sending it again replaces the document's accounting view"),
  externalRef: optionalText(200).describe("Your reference (file name, number), unique per tenant"),
  kind: z.enum(DOCUMENT_KINDS).describe("Booked: incoming_invoice, outgoing_invoice, receipt, payout_report, platform_settlement"),
  direction: z.enum(DOCUMENT_DIRECTIONS).nullable().optional().describe("incoming: addressed to the tenant; outgoing: issued by it"),
  title: optionalText(300),
  sender: optionalText(300).describe("The sender's name as printed"),
  summary: optionalText(2000).describe("One paragraph, never the OCR text: what the AI booking advisor may be told"),
  originalFileName: optionalText(300),
  fileUrl: z.url().max(2000).nullable().optional().describe("Where a person opens the file (on your side)"),
  invoiceNumber: optionalText(100),
  documentDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  serviceDate: isoDate.nullable().optional(),
  servicePeriodFrom: isoDate.nullable().optional(),
  servicePeriodTo: isoDate.nullable().optional(),
  currency: currency.nullable().optional(),
  totalAmountCents: cents.nullable().optional().describe("Gross total; negative for a credit note"),
  netTotalCents: cents.nullable().optional(),
  taxTotalCents: cents.nullable().optional(),
  passThroughCents: cents.nullable().optional().describe("Durchlaufende Posten, Auslagen ohne USt"),
  taxBreakdown: z
    .array(z.object({ ratePercent: z.number().min(0).max(100), netCents: cents.nullable(), taxCents: cents.nullable() }))
    .max(10)
    .nullable()
    .optional()
    .describe("One entry per printed VAT rate"),
  reverseCharge: z.boolean().nullable().optional().describe("true when the recipient owes the VAT"),
  platform: optionalText(50).describe("The platform a payout report or settlement comes from"),
  counterpartyId: z.uuid().nullable().optional().describe("The counterparty the direction implies: the sender of an incoming document, the recipient of an outgoing one"),
});

export const upsertDocuments = defineOperation({
  name: "upsert_documents",
  title: "Upsert documents",
  description:
    "Sends the accounting view of documents (invoices, receipts, payout reports): direction, number, dates, service " +
    "period, totals, tax breakdown per rate, pass-through, reverse charge, counterparty and a link to the file. The " +
    "file itself stays with you. Keyed by your document id: sending one again replaces what was stored (fields not " +
    "sent become empty). All or nothing. sync_proposals then proposes a booking for each bookable kind.",
  input: z.object({ documents: z.array(documentFields).min(1).max(MAX_BATCH) }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId }) => {
      const written = await services.sources.upsertDocuments({ tenantId, documents: input.documents.map(({ counterpartyId, ...doc }) => ({ ...doc, contactId: counterpartyId ?? null })) });
      return { documents: written.map(({ row, created }) => ({ id: row.id, created })) };
    });
  },
});

export const listDocuments = defineOperation({
  name: "list_documents",
  title: "List documents",
  description:
    "Documents, newest first (document date, else the day sent), each with its payment status (open, " +
    "partially_paid, paid, overdue, not_applicable without a total) and the movements that pay it. Filter by date " +
    "range, kind, direction or counterparty.",
  input: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    kind: z.enum(DOCUMENT_KINDS).optional(),
    direction: z.enum(DOCUMENT_DIRECTIONS).optional(),
    counterpartyId: z.uuid().optional(),
    ...paging,
  }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId }) => {
      const { offset, limit, counterpartyId, ...filter } = input;
      return page(await services.sources.listDocuments(tenantId, { ...filter, contactId: counterpartyId }, { offset, limit }), input, withCounterpartyId);
    });
  },
});

// --- Links and decisions -----------------------------------------------------------------------

export const linkMovementDocuments = defineOperation({
  name: "link_movement_documents",
  title: "Link movements to documents",
  description:
    "Records which document a movement pays (a confirmed payment match), with the cents of the movement allocated " +
    "to it; without allocatedAmountCents as much as both still have open. Linking a pair again replaces its " +
    "allocation. Refused: more than the document's open amount (allocation_exceeds_document) or the movement's " +
    "unallocated amount (allocation_exceeds_movement), or money in the wrong direction (direction_mismatch). " +
    "All or nothing. The payment's proposal then books against the document's open item.",
  input: z.object({
    links: z
      .array(
        z.object({
          movementId: z.uuid(),
          documentId: z.uuid(),
          allocatedAmountCents: z.number().int().positive().optional(),
          matchedBy: z.enum(["user", "auto"]).default("user").describe("user: a person decided; auto: your own deterministic pairing (a charge id on the invoice)"),
        }),
      )
      .min(1)
      .max(MAX_BULK_ENTRIES),
  }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId, actor }) => {
      const rows = await services.sources.linkMovementDocuments({
        tenantId,
        actor,
        links: input.links.map((link) => ({ documentId: link.documentId, transactionId: link.movementId, allocatedAmountCents: link.allocatedAmountCents, matchedBy: link.matchedBy })),
      });
      return { links: rows.map((row) => ({ movementId: row.transactionId, documentId: row.documentId, allocatedAmountCents: row.allocatedAmountCents, matchedBy: row.matchedBy })) };
    });
  },
});

export const unlinkMovementDocument = defineOperation({
  name: "unlink_movement_document",
  title: "Unlink movement from document",
  description:
    "Removes the link between a movement and a document; the document is open again. Cannot be undone (link it again " +
    "with link_movement_documents). A booked payment entry is not changed: unbook and sync it to follow.",
  input: z.object({ movementId: z.uuid(), documentId: z.uuid() }),
  audience: "tenant",
  scope: "write",
  effect: "destructive",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId }) => {
      await services.sources.unlinkMovementDocument({ tenantId, documentId: input.documentId, transactionId: input.movementId });
      return { unlinked: true };
    });
  },
});

export const setNoDocumentNeeded = defineOperation({
  name: "set_no_document_needed",
  title: "Set no document needed",
  description:
    "Marks movements that no document will ever explain (an internal transfer, a bank fee, a payroll run handled " +
    "elsewhere), or clears the mark with noDocumentNeeded: false. forCounterparty: true also keeps a standing rule " +
    "for the first movement's counterparty and marks its other unexplained movements now; the proposal engine " +
    "applies the rule to later ones.",
  input: z.object({
    movementIds: z.array(z.uuid()).min(1).max(MAX_BULK_ENTRIES),
    noDocumentNeeded: z.boolean().default(true),
    forCounterparty: z.boolean().default(false),
  }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId, actor }) => ({
      ...(await services.sources.setNoDocumentNeeded({ tenantId, actor, transactionIds: input.movementIds, noDocumentNeeded: input.noDocumentNeeded, forCounterparty: input.forCounterparty })),
    }));
  },
});

export const upsertPaymentAliases = defineOperation({
  name: "upsert_payment_aliases",
  title: "Upsert payment aliases",
  description:
    "Teaches which counterparty a name on bank movements means (e.g. 'PAYPAL *MUSTERSHOP' is Muster Shop GmbH), so the " +
    "proposal engine resolves it even when the names differ. Stored by the normalized merchant part of the name; a " +
    "name taught again points at the new counterparty.",
  input: z.object({ aliases: z.array(z.object({ counterpartyName: text(300), counterpartyId: z.uuid() })).min(1).max(MAX_BATCH) }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services, tenantId, actor }) => {
      const written = await services.sources.upsertPaymentAliases({ tenantId, actor, aliases: input.aliases.map((alias) => ({ counterpartyName: alias.counterpartyName, contactId: alias.counterpartyId })) });
      return { aliases: written.map((alias) => ({ normalizedName: alias.counterpartyNameNormalized, counterpartyId: alias.contactId })) };
    });
  },
});

export const SOURCE_OPERATIONS = [
  upsertCounterparties,
  listCounterparties,
  createMoneyAccount,
  updateMoneyAccount,
  listMoneyAccounts,
  upsertMoneyMovements,
  importBankStatement,
  listMoneyMovements,
  upsertDocuments,
  listDocuments,
  linkMovementDocuments,
  unlinkMovementDocument,
  setNoDocumentNeeded,
  upsertPaymentAliases,
];
