// Zod schemas for every ledger action input (decisions/0080). Shape only, plus what can be
// decided without the database (a period's order, owner fields that belong together). Whether
// an entry balances, an account exists or a period is locked is decided by the use case, and
// the last two again by the database.
import { z } from "zod";

import {
  AMOUNT_MODES,
  BOOKING_RULE_DIRECTIONS,
  FILING_KINDS,
  FILING_STATUSES,
  JOURNAL_ENTRY_ORIGINS,
  JOURNAL_ENTRY_STATUSES,
  LEDGER_ACCOUNT_GROUPS,
  LEDGER_ACCOUNT_KINDS,
  LEDGER_OWNER_TYPES,
  OPEN_ITEM_MATCH_KINDS,
  PROPOSAL_WARNING_CODES,
  TAX_CODES,
  VAT_BASES,
  VAT_PERIODS,
  type BookingRuleDirection,
  type TaxCode,
} from "./types";

export const MAX_ENTRY_LINES = 100;
export const MAX_BULK_ENTRIES = 500;
export const MAX_MATCH_LINES = 500;
/** About 10 million euros per line; keeps every sum inside a Postgres `integer`. */
export const MAX_LINE_AMOUNT_CENTS = 1_000_000_000;
/** A DATEV list of a few hundred accounts is well below 1 MB. */
export const MAX_ADVISOR_CSV_LENGTH = 2_000_000;
/** The largest uploaded file, in bytes: below the 1 MB a Server Action body may carry, and far
 * above a real list. The form checks it before reading, the use case again. */
export const MAX_ADVISOR_FILE_BYTES = 900 * 1024;

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const isoDate = z.iso.date();

export const accountNumberSchema = z.string().trim().regex(/^\d{4,8}$/);

export const lineInputSchema = z.object({
  accountNumber: accountNumberSchema,
  amountCents: z
    .number()
    .int()
    .min(-MAX_LINE_AMOUNT_CENTS)
    .max(MAX_LINE_AMOUNT_CENTS)
    .refine((value) => value !== 0),
  taxCode: z.enum(TAX_CODES).nullable().optional(),
  amountMode: z.enum(AMOUNT_MODES).optional(),
  /** The tax printed on the document (see `BaseLineInput.taxCents`). */
  taxCents: z.number().int().min(-MAX_LINE_AMOUNT_CENTS).max(MAX_LINE_AMOUNT_CENTS).nullable().optional(),
  /** The open item the line books or pays (a document of the same workspace). */
  documentId: z.uuid().nullable().optional(),
  text: optionalText(300),
});
export type LineInput = z.infer<typeof lineInputSchema>;

export const entryInputSchema = z.object({
  bookingDate: isoDate,
  documentDate: isoDate.nullable().optional(),
  serviceDate: isoDate.nullable().optional(),
  text: text(500).min(1),
  lines: z.array(lineInputSchema).min(1).max(MAX_ENTRY_LINES),
  documentId: z.uuid().nullable().optional(),
  transactionId: z.uuid().nullable().optional(),
  /** A draft correcting filing this entry belongs to (the only way into a locked period). */
  filingId: z.uuid().nullable().optional(),
  correctionOfEntryId: z.uuid().nullable().optional(),
});
export type EntryInput = z.infer<typeof entryInputSchema>;

export const createEntryInputSchema = z.object({ entry: entryInputSchema, book: z.boolean().default(false) });
export const updateEntryInputSchema = z.object({
  entryId: z.uuid(),
  entry: entryInputSchema,
  /** Required when the entry is booked: why it is changed. */
  reason: optionalText(500),
  /** The revision the editor loaded; a newer one in the database refuses the save. */
  expectedRevision: z.number().int().min(1).optional(),
});
export const entryIdInputSchema = z.object({ entryId: z.uuid() });
export const entryReasonInputSchema = z.object({ entryId: z.uuid(), reason: optionalText(500) });
export const bulkBookInputSchema = z.object({ entryIds: z.array(z.uuid()).min(1).max(MAX_BULK_ENTRIES) });

/** What the proposal engine hands `upsertProposal` (server only, no action). */
export const proposalInputSchema = z.object({
  sourceKey: text(200).min(1),
  entry: entryInputSchema,
  origin: z.enum(JOURNAL_ENTRY_ORIGINS).exclude(["manual"]),
  originReason: optionalText(500),
  warnings: z.array(z.enum(PROPOSAL_WARNING_CODES)).max(PROPOSAL_WARNING_CODES.length).default([]),
});
export type ProposalInput = z.infer<typeof proposalInputSchema>;

export const settingsInputSchema = z.object({
  enabled: z.boolean(),
  vatPeriod: z.enum(VAT_PERIODS),
  vatBasis: z.enum(VAT_BASES),
  startDate: isoDate.nullable(),
});
export type SettingsInput = z.infer<typeof settingsInputSchema>;

export const createAccountInputSchema = z
  .object({
    number: accountNumberSchema,
    name: text(200).min(1),
    kind: z.enum(LEDGER_ACCOUNT_KINDS),
    group: z.enum(LEDGER_ACCOUNT_GROUPS),
    openItems: z.boolean(),
    ownerType: z.enum(LEDGER_OWNER_TYPES).nullable(),
    ownerBankAccountId: z.uuid().nullable().optional(),
    ownerContactId: z.uuid().nullable().optional(),
    ownerPlatform: optionalText(50),
    ownerPersonName: optionalText(200),
    description: optionalText(500),
  })
  .superRefine((value, ctx) => {
    const required: Record<string, unknown> = {
      bank_account: value.ownerBankAccountId,
      contact: value.ownerContactId,
      platform: value.ownerPlatform,
      person: value.ownerPersonName,
    };
    if (value.ownerType && !required[value.ownerType]) ctx.addIssue({ code: "custom", path: ["ownerType"], message: "owner_missing" });
  });
export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

export const updateAccountInputSchema = z.object({
  accountId: z.uuid(),
  name: text(200).min(1),
  group: z.enum(LEDGER_ACCOUNT_GROUPS),
  openItems: z.boolean(),
  description: optionalText(500),
});
export type UpdateAccountInput = z.infer<typeof updateAccountInputSchema>;
export const accountIdInputSchema = z.object({ accountId: z.uuid() });

const orderedPeriod = <T extends { from: string; to: string }>(value: T) => value.from <= value.to;
export const periodSchema = z.object({ from: isoDate, to: isoDate }).refine(orderedPeriod);
export const accountSheetInputSchema = z.object({ accountNumber: accountNumberSchema, from: isoDate, to: isoDate }).refine(orderedPeriod);

export const listEntriesFilterSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(JOURNAL_ENTRY_STATUSES).optional(),
  origin: z.enum(JOURNAL_ENTRY_ORIGINS).optional(),
  accountNumber: accountNumberSchema.optional(),
  /** Only entries whose source is this document (the document page's "Buchhaltung" card). */
  documentId: z.uuid().optional(),
  /** Only entries with a revision after this moment ("geändert seit Übergabe"). */
  changedSince: z.iso.datetime({ offset: true }).optional(),
  dismissed: z.enum(["exclude", "include", "only"]).default("exclude"),
  limit: z.number().int().min(1).max(2000).default(500),
});
export type ListEntriesFilter = z.input<typeof listEntriesFilterSchema>;

export const createMatchInputSchema = z
  .object({
    accountNumber: accountNumberSchema,
    kind: z.enum(OPEN_ITEM_MATCH_KINDS),
    lineIds: z.array(z.uuid()).min(1).max(MAX_MATCH_LINES),
    note: optionalText(500),
  })
  .refine((value) => value.kind === "match" || (value.note ?? "").length > 0, { path: ["note"] });
export type CreateMatchInput = z.infer<typeof createMatchInputSchema>;
export const matchIdInputSchema = z.object({ matchId: z.uuid() });

/** The tax codes a rule may propose, by its direction: input tax and § 13b only on the expense
 * side, output tax only on the revenue side, and a rule for both only a code without tax. */
export const RULE_TAX_CODES_BY_DIRECTION = {
  incoming: ["vst19", "vst7", "rc13b", "pass_through", "not_taxable", "tax_free"],
  outgoing: ["ust19", "ust7", "eu_not_taxable", "not_taxable", "tax_free"],
  any: ["not_taxable", "tax_free"],
} as const satisfies Record<BookingRuleDirection, readonly TaxCode[]>;

export function ruleTaxCodeFits(direction: BookingRuleDirection, taxCode: TaxCode | null): boolean {
  return taxCode === null || (RULE_TAX_CODES_BY_DIRECTION[direction] as readonly TaxCode[]).includes(taxCode);
}

export const ruleInputSchema = z
  .object({
    contactId: z.uuid().nullable(),
    counterpartyPattern: optionalText(200),
    direction: z.enum(BOOKING_RULE_DIRECTIONS),
    accountNumber: accountNumberSchema,
    taxCode: z.enum(TAX_CODES).nullable(),
    paymentAccountNumber: accountNumberSchema.nullable(),
    noDocument: z.boolean(),
    active: z.boolean().default(true),
    learnedFromEntryId: z.uuid().nullable().optional(),
  })
  .refine((value) => value.contactId !== null || (value.counterpartyPattern ?? "").length > 0, { path: ["counterpartyPattern"] })
  .refine((value) => ruleTaxCodeFits(value.direction, value.taxCode), { path: ["taxCode"] });
export type RuleInput = z.infer<typeof ruleInputSchema>;
export const updateRuleInputSchema = z.object({ ruleId: z.uuid(), rule: ruleInputSchema });
export const ruleIdInputSchema = z.object({ ruleId: z.uuid() });

const amountCents = z.number().int().min(-MAX_LINE_AMOUNT_CENTS).max(MAX_LINE_AMOUNT_CENTS);

export const createFilingInputSchema = z
  .object({
    kind: z.enum(FILING_KINDS),
    periodFrom: isoDate,
    periodTo: isoDate,
    status: z.enum(FILING_STATUSES),
    submittedOn: isoDate.nullable().optional(),
    amountCents: amountCents.nullable().optional(),
    note: optionalText(1000),
  })
  .refine((value) => value.periodFrom <= value.periodTo, { path: ["periodTo"] })
  .refine((value) => value.status === "draft" || Boolean(value.submittedOn), { path: ["submittedOn"] });
export type CreateFilingInput = z.infer<typeof createFilingInputSchema>;
export const submitFilingInputSchema = z.object({ filingId: z.uuid(), submittedOn: isoDate, amountCents: amountCents.nullable().optional() });
export const filingIdInputSchema = z.object({ filingId: z.uuid() });

export const createHandoverInputSchema = z
  .object({ periodFrom: isoDate, periodTo: isoDate, note: optionalText(1000) })
  .refine((value) => value.periodFrom <= value.periodTo, { path: ["periodTo"] });

export const uploadAdvisorInputSchema = z
  .object({ periodFrom: isoDate, periodTo: isoDate, fileName: optionalText(255), csvText: z.string().min(1).max(MAX_ADVISOR_CSV_LENGTH) })
  .refine((value) => value.periodFrom <= value.periodTo, { path: ["periodTo"] });
export const advisorUploadIdInputSchema = z.object({ uploadId: z.uuid() });

/** `syncProposals`: which sources to propose for, by their date; both optional. */
export const syncProposalsInputSchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((value) => !value.from || !value.to || value.from <= value.to, { path: ["to"] });
export type SyncProposalsInput = z.infer<typeof syncProposalsInputSchema>;

export const suggestMatchesInputSchema = z.object({ accountId: z.uuid() });

export const yearInputSchema = z.object({ year: z.number().int().min(2000).max(2100) });
