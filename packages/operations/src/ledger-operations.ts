// The bookkeeping operations of one tenant (decisions/0001-ledger-api.md, "The operation catalog,
// first version"), adapted from Digipost's 34 MCP ledger tools onto `@ledger/db`'s use cases:
// balancing, period locks, revisions and error codes are the use cases' own. Amounts are integer
// cents, debit (Soll) positive, credit (Haben) negative.
import {
  accountNumberSchema,
  createAccountInputSchema,
  createFilingInputSchema,
  createHandoverInputSchema,
  createMatchInputSchema,
  entryInputSchema,
  FILING_KINDS,
  JOURNAL_ENTRY_ORIGINS,
  JOURNAL_ENTRY_STATUSES,
  MAX_ADVISOR_CSV_LENGTH,
  MAX_BULK_ENTRIES,
  ruleInputSchema,
  TAX_CODES,
  updateAccountInputSchema,
  uploadAdvisorInputSchema,
} from "@ledger/core";
import { z } from "zod";

import { defineOperation, fail, OPERATION_ERROR } from "./kit";
import { strict, withTenant } from "./use-case";

const isoDate = z.iso.date();
const today = () => new Date().toISOString().slice(0, 10);
const SIGN_NOTE = "Amounts are signed cents: debit (Soll) positive, credit (Haben) negative.";

const periodFields = {
  from: isoDate.optional().describe("YYYY-MM-DD, default 1 January of the year of `to`"),
  to: isoDate.optional().describe("YYYY-MM-DD, default today"),
};
function periodOf(input: { from?: string; to?: string }): { from: string; to: string } | null {
  const to = input.to ?? today();
  const from = input.from ?? `${to.slice(0, 4)}-01-01`;
  return from <= to ? { from, to } : null;
}
const PERIOD_INVALID = fail(OPERATION_ERROR.invalidInput, { message: "from must not be after to" });

// --- Overview and journal ----------------------------------------------------------------------

export const getOverview = defineOperation({
  name: "get_overview",
  title: "Bookkeeping overview",
  description:
    "A tenant's books at a glance for a period: settings, the controls (ledger bank balance equals the real one, " +
    "every open-item account settled or explained, no source without a booking), the bank comparison, every " +
    "open-item account with its balance, and how many proposals wait for review. Start here.",
  input: z.object(periodFields),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    const period = periodOf(input);
    if (!period) return PERIOD_INVALID;
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      const [settings, controls, bankComparisons, openItemAccounts, waitingProposals] = await Promise.all([
        ledger.getSettings(tenantId),
        ledger.getControls(tenantId, period),
        ledger.getBankComparisons(tenantId, period),
        ledger.listOpenItemAccounts(tenantId, period.to),
        ledger.countWaitingProposals(tenantId),
      ]);
      return { period, settings, controls, bankComparisons, openItemAccounts, waitingProposals };
    });
  },
});

export const listEntries = defineOperation({
  name: "list_entries",
  title: "List journal entries",
  description:
    "Journal entries with their lines, newest first. status 'proposed' is the review queue (each proposal carries " +
    "warnings and its origin: template, rule or AI), 'booked' the journal. Filter by booking-date range, origin, " +
    `account number or source document. ${SIGN_NOTE}`,
  input: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    status: z.enum(JOURNAL_ENTRY_STATUSES).optional(),
    origin: z.enum(JOURNAL_ENTRY_ORIGINS).optional(),
    accountNumber: accountNumberSchema.optional(),
    documentId: z.uuid().optional(),
    dismissed: z.enum(["exclude", "include", "only"]).default("exclude"),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      const { offset, limit, ...filter } = input;
      const rows = await ledger.listEntries(tenantId, { ...filter, limit: 2000 });
      return { items: rows.slice(offset, offset + limit), total: rows.length, offset, hasMore: offset + limit < rows.length };
    });
  },
});

export const getEntry = defineOperation({
  name: "get_entry",
  title: "Get journal entry",
  description: `One journal entry with its lines (tax lines included), its revisions, and the filing that locks it if any. ${SIGN_NOTE}`,
  input: z.object({ entryId: z.uuid() }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      const entry = await ledger.getEntry(tenantId, input.entryId);
      return entry ? { entry } : fail(OPERATION_ERROR.notFound);
    });
  },
});

const lineField = z.object({
  accountNumber: accountNumberSchema,
  amountCents: z.number().int().describe("Signed cents: debit positive, credit negative, never 0"),
  taxCode: z.enum(TAX_CODES).nullable().optional().describe("On an expense or revenue line: the tax lines are added automatically"),
  amountMode: z.enum(["gross", "net"]).optional().describe("Whether amountCents includes the tax (default gross)"),
  taxCents: z.number().int().nullable().optional().describe("The tax printed on the document, if it differs from the computed one"),
  documentId: z.uuid().nullable().optional().describe("The open item (document) this line books or pays"),
  text: z.string().max(300).nullable().optional(),
});
const entryField = z.object({ ...entryInputSchema.shape, lines: z.array(lineField).min(1).max(100) });

export const createEntry = defineOperation({
  name: "create_entry",
  title: "Create journal entry",
  description:
    "Creates a manual entry. Lines must balance (sum 0 after the tax lines); a line with a taxCode gets its tax lines " +
    "added. book: true books it at once, otherwise it waits for review. A date in a submitted (locked) period is " +
    `refused with 'locked'. ${SIGN_NOTE}`,
  input: z.object({ entry: entryField, book: z.boolean().default(false) }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => ledger.createEntry({ tenantId, userId: actor, entry: strict(entryInputSchema, input.entry), book: input.book }));
  },
});

export const updateEntry = defineOperation({
  name: "update_entry",
  title: "Update journal entry",
  description:
    "Replaces an entry's dates, text and lines (full replace; read it with get_entry first). A booked entry needs a " +
    "reason and gets a revision; expectedRevision refuses the save if someone changed it meanwhile. An entry in a " +
    "submitted period cannot change ('locked').",
  input: z.object({ entryId: z.uuid(), entry: entryField, reason: z.string().max(500).nullable().optional(), expectedRevision: z.number().int().min(1).optional() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) =>
      ledger.updateEntry({ tenantId, userId: actor, entryId: input.entryId, entry: strict(entryInputSchema, input.entry), reason: input.reason, expectedRevision: input.expectedRevision }),
    );
  },
});

export const bookEntries = defineOperation({
  name: "book_entries",
  title: "Book entries",
  description:
    "Books proposals, one or many, each on its own; the result lists the booked ids and the failed ones with their " +
    "code (unbalanced, locked, ...). Review warnings first. Open items are matched automatically afterwards.",
  input: z.object({ entryIds: z.array(z.uuid()).min(1).max(MAX_BULK_ENTRIES) }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => ({ ...(await ledger.bulkBook({ tenantId, userId: actor, entryIds: input.entryIds })) }));
  },
});

export const unbookEntry = defineOperation({
  name: "unbook_entry",
  title: "Unbook entry",
  description: "Takes a booked entry back to a proposal, e.g. to correct it; its open-item matches are removed. Refused in a submitted period. The reason is recorded.",
  input: z.object({ entryId: z.uuid(), reason: z.string().max(500).nullable().optional() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => {
      await ledger.unbookEntry({ tenantId, userId: actor, entryId: input.entryId, reason: input.reason });
      return { unbooked: true };
    });
  },
});

export const deleteEntry = defineOperation({
  name: "delete_entry",
  title: "Delete entry",
  description: "Deletes a manual entry or a proposal. Cannot be undone (the revision history keeps what it was). For an unwanted proposal prefer dismiss_proposal.",
  input: z.object({ entryId: z.uuid(), reason: z.string().max(500).nullable().optional() }),
  audience: "tenant",
  scope: "write",
  effect: "destructive",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => {
      await ledger.deleteEntry({ tenantId, userId: actor, entryId: input.entryId, reason: input.reason });
      return { deleted: true };
    });
  },
});

export const dismissProposal = defineOperation({
  name: "dismiss_proposal",
  title: "Dismiss proposal",
  description: "Dismisses a proposal: it leaves the review queue and is not proposed again. Restorable with restore_proposal.",
  input: z.object({ entryId: z.uuid() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => {
      await ledger.dismissProposal({ tenantId, userId: actor, entryId: input.entryId });
      return { dismissed: true };
    });
  },
});

export const restoreProposal = defineOperation({
  name: "restore_proposal",
  title: "Restore proposal",
  description: "Brings a dismissed proposal back into the review queue.",
  input: z.object({ entryId: z.uuid() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => {
      await ledger.restoreProposal({ tenantId, userId: actor, entryId: input.entryId });
      return { restored: true };
    });
  },
});

export const syncProposals = defineOperation({
  name: "sync_proposals",
  title: "Refresh proposals",
  description:
    "Proposes an entry for every source (document, money movement) not booked yet: templates, booking rules, then " +
    "the AI for the rest, optionally only for sources dated from..to. Booked, edited and dismissed entries are kept.",
  input: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ ...(await ledger.syncProposals({ tenantId, ...input })) }));
  },
});

// --- Accounts and reports ----------------------------------------------------------------------

export const listAccounts = defineOperation({
  name: "list_accounts",
  title: "Chart of accounts",
  description: "The tenant's chart of accounts: number, name, kind, group, whether it keeps open items, and its owner (a money account, a counterparty, a platform, a person).",
  input: z.object({ includeArchived: z.boolean().default(false) }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      const accounts = await ledger.listAccounts(tenantId);
      return { accounts: input.includeArchived ? accounts : accounts.filter((account) => !account.archived) };
    });
  },
});

export const getBalances = defineOperation({
  name: "get_balances",
  title: "Trial balance",
  description: `The Summen- und Saldenliste for a period: per account opening balance, debit and credit totals and closing balance, booked entries only. ${SIGN_NOTE}`,
  input: z.object(periodFields),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    const period = periodOf(input);
    if (!period) return PERIOD_INVALID;
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ period, balances: await ledger.getBalances(tenantId, period) }));
  },
});

export const getAccountSheet = defineOperation({
  name: "get_account_sheet",
  title: "Account sheet",
  description: `One account's sheet (Kontenblatt): every line in the period with counter accounts and running balance. includeProposals counts proposals into the balance. ${SIGN_NOTE}`,
  input: z.object({ accountNumber: accountNumberSchema, ...periodFields, includeProposals: z.boolean().default(false) }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    const period = periodOf(input);
    if (!period) return PERIOD_INVALID;
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      const sheet = await ledger.getAccountSheet(tenantId, { accountNumber: input.accountNumber, ...period, countProposals: input.includeProposals });
      return sheet ? { sheet } : fail(OPERATION_ERROR.notFound);
    });
  },
});

export const getOpenItems = defineOperation({
  name: "get_open_items",
  title: "Open items of an account",
  description:
    "The open items of one open-item account (payables 3300, receivables 1200, a clearing account) as of a date: " +
    "unmatched lines, existing matches and suggested groups that sum to zero, ready for create_open_item_match.",
  input: z.object({ accountNumber: accountNumberSchema, asOf: isoDate.optional().describe("YYYY-MM-DD, default today") }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      const openItems = await ledger.getOpenItems(tenantId, { accountNumber: input.accountNumber, asOf: input.asOf ?? today() });
      if (!openItems) return fail(OPERATION_ERROR.notFound);
      return { openItems, suggestions: await ledger.suggestMatches(tenantId, openItems.account.id) };
    });
  },
});

export const getVatPreview = defineOperation({
  name: "get_vat_preview",
  title: "VAT return preview",
  description:
    "The Umsatzsteuer-Voranmeldung for a period (a month or quarter): every Kennzahl (81, 86, 21, 46, 47, 66, 67, 83, " +
    "...) with base and tax, and the resulting payable (positive) or refund (negative). Booked entries only.",
  input: z.object({ from: isoDate, to: isoDate }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    if (input.from > input.to) return PERIOD_INVALID;
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ preview: await ledger.getVatPreview(tenantId, input) }));
  },
});

export const createAccount = defineOperation({
  name: "create_account",
  title: "Create account",
  description:
    "Adds an account to the chart, e.g. a clearing account for a supplier, a payment provider or a shareholder " +
    "(openItems: true with an owner) or a more specific expense account. The number must be free.",
  input: z.object(createAccountInputSchema.shape),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ account: await ledger.createAccount({ tenantId, account: strict(createAccountInputSchema, input) }) }));
  },
});

export const updateAccount = defineOperation({
  name: "update_account",
  title: "Update account",
  description: "Renames an account or changes its group, open-item flag and description (number and kind stay).",
  input: z.object(updateAccountInputSchema.shape),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ account: await ledger.updateAccount({ tenantId, account: strict(updateAccountInputSchema, input) }) }));
  },
});

export const setAccountArchived = defineOperation({
  name: "set_account_archived",
  title: "Archive or restore account",
  description: "Archives an account (no new bookings, its history stays) or restores it.",
  input: z.object({ accountId: z.uuid(), archived: z.boolean() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ account: await ledger.setAccountArchived({ tenantId, ...input }) }));
  },
});

// --- Open items --------------------------------------------------------------------------------

export const createOpenItemMatch = defineOperation({
  name: "create_open_item_match",
  title: "Match open items",
  description:
    "Settles open items of one account: kind 'match' needs lines summing to zero; kind 'explained' settles a " +
    "remainder with a note (e.g. a few cents of exchange difference). Line ids come from get_open_items.",
  input: z.object(createMatchInputSchema.shape),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => ledger.createMatch({ tenantId, userId: actor, match: strict(createMatchInputSchema, input) }));
  },
});

export const deleteOpenItemMatch = defineOperation({
  name: "delete_open_item_match",
  title: "Remove open-item match",
  description: "Removes a match: every line of it becomes open again. The removal itself cannot be undone; match the lines anew to restore it.",
  input: z.object({ matchId: z.uuid() }),
  audience: "tenant",
  scope: "write",
  effect: "destructive",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      await ledger.deleteMatch({ tenantId, matchId: input.matchId });
      return { deleted: true };
    });
  },
});

// --- Booking rules -----------------------------------------------------------------------------

export const listRules = defineOperation({
  name: "list_rules",
  title: "List booking rules",
  description:
    "The booking rules proposals follow: per counterparty or counterparty pattern, direction (incoming = expense " +
    "side, outgoing = revenue side, any), account, tax code, and noDocument rules for movements without a document.",
  input: z.object({}),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(_input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ rules: await ledger.listRules(tenantId) }));
  },
});

const ruleField = z
  .object(ruleInputSchema.shape)
  .describe("contactId or counterpartyPattern (a lower-cased part of the counterparty name or text); direction 'incoming' = money out or supplier invoice, 'outgoing' = money in or revenue, 'any'.");

export const createRule = defineOperation({
  name: "create_rule",
  title: "Create booking rule",
  description: "Adds a booking rule; it applies from the next sync_proposals on.",
  input: z.object({ rule: ruleField }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ rule: await ledger.createRule({ tenantId, rule: strict(ruleInputSchema, input.rule) }) }));
  },
});

export const updateRule = defineOperation({
  name: "update_rule",
  title: "Update booking rule",
  description: "Replaces a booking rule (full replace).",
  input: z.object({ ruleId: z.uuid(), rule: ruleField }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ rule: await ledger.updateRule({ tenantId, ruleId: input.ruleId, rule: strict(ruleInputSchema, input.rule) }) }));
  },
});

export const learnRuleFromEntry = defineOperation({
  name: "learn_rule_from_entry",
  title: "Save entry as rule",
  description: "Derives a rule from an entry, so its counterparty is proposed the same way next time.",
  input: z.object({ entryId: z.uuid() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ rule: await ledger.learnRuleFromEntry({ tenantId, entryId: input.entryId }) }));
  },
});

export const deleteRule = defineOperation({
  name: "delete_rule",
  title: "Delete booking rule",
  description: "Deletes a booking rule. Cannot be undone; entries already booked stay as they are.",
  input: z.object({ ruleId: z.uuid() }),
  audience: "tenant",
  scope: "write",
  effect: "destructive",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      await ledger.deleteRule({ tenantId, ruleId: input.ruleId });
      return { deleted: true };
    });
  },
});

// --- Periods, filings, handovers ---------------------------------------------------------------

export const listPeriods = defineOperation({
  name: "list_periods",
  title: "Periods and filings",
  description:
    "Per VAT period of a year: its status (open, handed over, submitted), failing controls, booked and proposed " +
    "counts and changes since the last handover; plus every filing and handover.",
  input: z.object({ year: z.number().int().min(2000).max(2100).optional().describe("Default: the current year") }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      const year = input.year ?? Number(today().slice(0, 4));
      const [periods, filings, handovers] = await Promise.all([ledger.getPeriodOverview(tenantId, year), ledger.listFilings(tenantId), ledger.listHandovers(tenantId)]);
      return { year, periods, filings, handovers };
    });
  },
});

export const createFiling = defineOperation({
  name: "create_filing",
  title: "Create filing draft",
  description:
    "Creates a draft filing (a VAT return or an annual statement) for a period. A draft locks nothing; mark it with " +
    "submit_filing once it was actually filed with the tax office.",
  input: z.object({ kind: z.enum(FILING_KINDS), periodFrom: isoDate, periodTo: isoDate, amountCents: z.number().int().nullable().optional(), note: z.string().max(1000).nullable().optional() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => ({
      filing: await ledger.createFiling({ tenantId, userId: actor, filing: strict(createFilingInputSchema, { ...input, status: "draft" }) }),
    }));
  },
});

export const submitFiling = defineOperation({
  name: "submit_filing",
  title: "Mark filing as submitted (locks the period)",
  description:
    "Marks a draft filing as submitted to the tax office. From then on every entry in its period is LOCKED: it can " +
    "no longer be booked, changed, unbooked or deleted. This CANNOT be undone; a later correction only works " +
    "through create_correction_filing. Only call this after the user explicitly confirmed that the return was " +
    "filed. amountCents is the filed payable (positive) or refund (negative). Needs the key scope 'filing'.",
  input: z.object({ filingId: z.uuid(), submittedOn: isoDate, amountCents: z.number().int().nullable().optional() }),
  audience: "tenant",
  scope: "filing",
  effect: "destructive",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ filing: await ledger.submitFiling({ tenantId, ...input }) }));
  },
});

export const createCorrectionFiling = defineOperation({
  name: "create_correction_filing",
  title: "Create correction filing",
  description: "A correcting filing for a submitted one: a new draft for the same period; correcting entries are booked into it while the original stays locked.",
  input: z.object({ filingId: z.uuid() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => ({ filing: await ledger.createCorrectionFiling({ tenantId, userId: actor, filingId: input.filingId }) }));
  },
});

export const createHandover = defineOperation({
  name: "create_handover",
  title: "Record handover to tax advisor",
  description: "Records that a period was handed over to the tax advisor; later changes in it are counted as changes since the handover. Locks nothing.",
  input: z.object({ periodFrom: isoDate, periodTo: isoDate, note: z.string().max(1000).nullable().optional() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => {
      const data = strict(createHandoverInputSchema, input);
      return { handover: await ledger.createHandover({ tenantId, userId: actor, ...data }) };
    });
  },
});

// --- The tax advisor's balance lists -----------------------------------------------------------

export const getAdvisorComparison = defineOperation({
  name: "get_advisor_comparison",
  title: "Compare with tax advisor",
  description: "The tax advisor's imported balance lists; with uploadId, that list compared with the tenant's own balances per account, differences first.",
  input: z.object({ uploadId: z.uuid().optional() }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      const uploads = await ledger.listAdvisorUploads(tenantId);
      if (!input.uploadId) return { uploads };
      const comparison = await ledger.getAdvisorComparison(tenantId, input.uploadId);
      return comparison ? { uploads, comparison } : fail(OPERATION_ERROR.notFound);
    });
  },
});

export const importAdvisorBalances = defineOperation({
  name: "import_advisor_balances",
  title: "Import tax advisor's balance list",
  description: "Imports the tax advisor's Summen- und Saldenliste for a period as CSV text (DATEV export) for get_advisor_comparison. Changes no booking.",
  input: z.object({ periodFrom: isoDate, periodTo: isoDate, fileName: z.string().max(255).nullable().optional(), csvText: z.string().min(1).max(MAX_ADVISOR_CSV_LENGTH) }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId, actor }) => ({
      upload: await ledger.uploadAdvisorBalances({ tenantId, userId: actor, ...strict(uploadAdvisorInputSchema, input) }),
    }));
  },
});

export const deleteAdvisorBalances = defineOperation({
  name: "delete_advisor_balances",
  title: "Delete tax advisor's balance list",
  description: "Deletes one imported balance list of the tax advisor. Cannot be undone (import it again if needed).",
  input: z.object({ uploadId: z.uuid() }),
  audience: "tenant",
  scope: "write",
  effect: "destructive",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      await ledger.deleteAdvisorUpload({ tenantId, uploadId: input.uploadId });
      return { deleted: true };
    });
  },
});

export const LEDGER_OPERATIONS = [
  getOverview,
  listEntries,
  getEntry,
  createEntry,
  updateEntry,
  bookEntries,
  unbookEntry,
  deleteEntry,
  dismissProposal,
  restoreProposal,
  syncProposals,
  listAccounts,
  getBalances,
  getAccountSheet,
  getOpenItems,
  getVatPreview,
  createAccount,
  updateAccount,
  setAccountArchived,
  createOpenItemMatch,
  deleteOpenItemMatch,
  listRules,
  createRule,
  updateRule,
  learnRuleFromEntry,
  deleteRule,
  listPeriods,
  createFiling,
  submitFiling,
  createCorrectionFiling,
  createHandover,
  getAdvisorComparison,
  importAdvisorBalances,
  deleteAdvisorBalances,
];
