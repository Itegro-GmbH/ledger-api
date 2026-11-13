// The proposal engine's pure core (decisions/0080-ledger-double-entry-bookkeeping.md, phase 3):
// a snapshot of the sources (documents, bank transactions, settlement lines, issued invoices),
// the chart, the active booking rules and the source keys a human already decided on, in; the
// proposal drafts (entry, lines with tax codes, origin, reason, warnings, source key) out. No
// I/O: `src/persistence/use-cases/ledger-use-cases.ts`'s `syncProposals` reads the snapshot,
// asks the AI advisor the questions `adviceQuestionsFor` lists, and writes the drafts through
// `upsertProposal`.
//
// Everything is booked Soll style: an invoice and its payment are separate entries that meet on
// an open-item account (payables 3300, receivables 1200, or the account a contact, platform or
// shareholder owns), and every open-item line carries the document it books or pays, so the
// two sides can be matched. Transactions on clearing `accounts` rows are never booked (the
// caller passes bank transactions only); a clearing account only decides which open-item
// account a source belongs to.
//
// From certain to uncertain: a fixed template where the source decides everything (an issued
// invoice, a settlement report, a payment of a matched document), then a booking rule, then the
// AI for an incoming document's account, then the template default with a warning. A source no
// template explains gets no proposal at all (it shows as a problem), never a guess.
import { hasPrintedTaxFigures, isUnverifiedReverseCharge } from "./tax-evidence";
import type { BookingAdvice, BookingAdviceQuestion } from "./ports";
import type { EntryInput, LineInput } from "./schemas";
import type {
  BookingRuleDirection,
  JournalEntryOrigin,
  LedgerAccountGroup,
  LedgerAccountKind,
  LedgerOwnerType,
  ProposalProblemCode,
  ProposalTemplate,
  ProposalWarningCode,
  TaxCode,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

export type ProposalAccount = {
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
  archived: boolean;
};

export type ProposalRule = {
  id: string;
  contactId: string | null;
  /** Lowercase; matches when the counterparty's name (or a bank transaction's remittance text)
   * contains it. */
  counterpartyPattern: string | null;
  /** The side the rule books: `incoming` an expense (an incoming invoice, money out),
   * `outgoing` a revenue (an outgoing invoice, money in), `any` both. */
  direction: BookingRuleDirection;
  accountNumber: string;
  taxCode: TaxCode | null;
  paymentAccountNumber: string | null;
  noDocument: boolean;
};

/** As extracted: a figure the document does not print is `null`. */
export type ProposalTaxBreakdownEntry = { ratePercent: number; netCents: number | null; taxCents: number | null };

type CompleteBreakdownEntry = { ratePercent: number; netCents: number; taxCents: number };

export type ProposalDocument = {
  id: string;
  /** The effective kind (`documents.manual_kind` over `kind`). */
  kind: string;
  direction: "incoming" | "outgoing" | "unknown" | null;
  status: string;
  documentDate: string | null;
  effectiveDate: string;
  title: string | null;
  sender: string | null;
  summary: string | null;
  originalFileName: string;
  invoiceNumber: string | null;
  totalAmountCents: number | null;
  currency: string | null;
  platform: string | null;
  taxBreakdown: ProposalTaxBreakdownEntry[] | null;
  netTotalCents: number | null;
  taxTotalCents: number | null;
  passThroughCents: number | null;
  reverseCharge: boolean | null;
  serviceDate: string | null;
  servicePeriodFrom: string | null;
  servicePeriodTo: string | null;
  contactId: string | null;
  contactName: string | null;
  contactVatId: string | null;
  contactCountry: string | null;
  confirmedTransactions: { transactionId: string; allocatedAmountCents: number }[];
};

/** A transaction on a BANK `accounts` row (never a clearing one). */
export type ProposalTransaction = {
  id: string;
  bankAccountId: string;
  bookingDate: string;
  /** Signed: positive is money in. */
  amountCents: number;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  remittanceText: string | null;
  /** The contact the counterparty resolves to (learned payment names first, then the name
   * comparison of `@/modules/payments`), resolved by the caller. */
  resolvedContactId: string | null;
  /** The clearing account this transaction is tied to by a transfer group (decisions/0026,
   * decisions/0048, decisions/0068): an app-store payout or a supplier charge. */
  pairedClearing: { platform: string | null; contactId: string | null; reportDocumentIds: string[] } | null;
  /** "Kein Beleg nötig" (by a human, or by a `payment_no_document_rules` rule). */
  noDocumentNeeded: boolean;
  /** The counterparty has a standing "kein Beleg nötig" rule of the payments owner. */
  noDocumentRule: boolean;
};

export type ProposalSettlementLine = {
  id: string;
  documentId: string;
  platform: string | null;
  type: "revenue" | "fee" | "refund" | "payout" | "adjustment";
  grossCents: number | null;
  feeCents: number | null;
  netCents: number | null;
  bookingDate: string | null;
};

/** One VAT category and rate of an issued invoice (`invoiceVatGroups`). */
export type ProposalInvoiceGroup = { category: string; ratePercent: number; netCents: number; vatCents: number };

/** An invoice issued in Digipost (`src/modules/invoicing`, decisions/0079). */
export type ProposalInvoice = {
  id: string;
  number: string;
  type: "invoice" | "cancellation";
  issueDate: string;
  serviceDate: string | null;
  contactId: string | null;
  buyerName: string;
  buyerCountry: string | null;
  /** The inbox document the invoice was filed as: payments are matched against it. */
  documentId: string | null;
  /** A cancellation: the invoice it cancels (its groups are negated, so every account nets to
   * zero whatever the cancellation's own rounding). */
  cancelsInvoiceId?: string | null;
  groups: ProposalInvoiceGroup[];
};

export type ProposalSnapshot = {
  /** Only sources dated inside are proposed; both optional. */
  from?: string;
  to?: string;
  /** Nothing before the ledger's start date is proposed. */
  startDate: string | null;
  accounts: readonly ProposalAccount[];
  /** Active rules only. */
  rules: readonly ProposalRule[];
  documents: readonly ProposalDocument[];
  transactions: readonly ProposalTransaction[];
  settlementLines: readonly ProposalSettlementLine[];
  invoices: readonly ProposalInvoice[];
  /** The workspace's own bank `accounts` rows, to recognize a transfer between them. */
  ownBankAccounts: readonly { id: string; iban: string | null }[];
  /** Source keys of entries a human booked, edited or dismissed: never proposed again. */
  decidedSourceKeys: ReadonlySet<string>;
};

export type ProposalDraft = {
  sourceKey: string;
  template: ProposalTemplate;
  origin: Exclude<JournalEntryOrigin, "manual">;
  originReason: string;
  warnings: ProposalWarningCode[];
  entry: EntryInput;
};

/** What the engine could not or did not propose, by source key. */
export type ProposalPlan = {
  drafts: ProposalDraft[];
  /** Sources no template explains (they show as problems). */
  unproposed: string[];
  /** Unproposed sources with a reason worth telling (a subset of `unproposed`). */
  problems: { sourceKey: string; code: ProposalProblemCode }[];
  /** Documents whose AI answer is missing from the advice map (asked next run). */
  deferred: string[];
};

/** `null`: asked, but no usable answer (unavailable or rejected). Missing: not asked yet. */
export type AdviceMap = ReadonlyMap<string, BookingAdvice | null>;

// ---------------------------------------------------------------------------------------------
// Fixed numbers and keywords
// ---------------------------------------------------------------------------------------------

export const PAYABLES_ACCOUNT = "3300";
export const RECEIVABLES_ACCOUNT = "1200";
export const MONEY_IN_TRANSIT_ACCOUNT = "1360";
export const DEFAULT_EXPENSE_ACCOUNT = "6300";
export const DEFAULT_FEE_ACCOUNT = "6855";
export const REVENUE_ACCOUNTS = { ust19: "4400", ust7: "4300", euNotTaxable: "4339", thirdCountry: "4338", taxFree: "4200" } as const;

/** Document kinds booked as a purchase. An authority letter only when it states an amount. */
const INCOMING_KINDS = new Set(["incoming_invoice", "receipt", "authority_letter"]);
const SETTLEMENT_KINDS = new Set(["payout_report", "platform_settlement"]);

const EU_COUNTRIES = new Set(["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "EL", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]);

/** Notary, court and register costs often contain pass-through fees without VAT. */
const PASS_THROUGH_KEYWORDS = ["notar", "gericht", "handelsregister", "grundbuch", "gerichtskasse", "justiz"];
/** Authorities and courts charge fees without VAT. */
const AUTHORITY_KEYWORDS = ["gericht", "finanzamt", "behörde", "stadtkasse", "gemeindekasse", "justiz", "bundesanzeiger", "gebührenbescheid"];

/** Fee lines of a platform report: Google bills its service fee from Ireland (§ 13b). */
const PLATFORM_FEE_TAX_CODES: Record<string, TaxCode | null> = { google: "rc13b" };

/** Platforms whose report the settlement template books: the app stores, which sell in their own
 * name on the developer's account (commissionaire model), so the revenue is a supply to the
 * store (4339). Other platforms (Stripe, PayPal, Amazon) collect for the seller; their reports
 * need a different booking and get no proposal. */
const COMMISSIONAIRE_PLATFORMS = new Set(["apple", "google"]);

export const MAX_ENTRY_TEXT = 200;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function inScope(snapshot: ProposalSnapshot, date: string): boolean {
  if (snapshot.startDate && date < snapshot.startDate) return false;
  if (snapshot.from && date < snapshot.from) return false;
  if (snapshot.to && date > snapshot.to) return false;
  return true;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ENTRY_TEXT ? `${flat.slice(0, MAX_ENTRY_TEXT - 3).trimEnd()}...` : flat;
}

function lower(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

function containsAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function monthEnd(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, mon!, 0)).toISOString().slice(0, 10);
}

/** Name tokens for the shareholder comparison: lowercase letters only, at least two long. */
function nameTokens(name: string | null | undefined): string[] {
  return lower(name)
    .split(/[^a-zäöüß]+/)
    .filter((token) => token.length >= 2);
}

function normalizeIban(iban: string | null | undefined): string | null {
  const value = (iban ?? "").replace(/\s+/g, "").toUpperCase();
  return value.length > 0 ? value : null;
}

export function isEuCountry(country: string | null | undefined): boolean {
  return Boolean(country && EU_COUNTRIES.has(country.toUpperCase()));
}

/** A German supplier: its contact's country is DE, or its VAT id is German. */
export function isDomesticParty(country: string | null, vatId: string | null): boolean {
  if (country && country.trim().toUpperCase() === "DE") return true;
  return (vatId ?? "").replace(/\s+/g, "").slice(0, 2).toUpperCase() === "DE";
}

/** A supplier outside Germany: its contact's country, or a VAT id of another country. */
export function isForeignParty(country: string | null, vatId: string | null): boolean {
  if (country && country.trim().length > 0 && country.toUpperCase() !== "DE") return true;
  const prefix = (vatId ?? "").replace(/\s+/g, "").slice(0, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(prefix) && prefix !== "DE";
}

function documentDateOf(doc: ProposalDocument): string {
  return doc.documentDate ?? doc.effectiveDate;
}

function counterpartyText(doc: ProposalDocument): string {
  return [doc.contactName, doc.sender, doc.title].filter(Boolean).join(" ").toLowerCase();
}

function documentLabel(doc: ProposalDocument): string {
  return doc.contactName ?? doc.sender ?? doc.title ?? doc.originalFileName;
}

// ---------------------------------------------------------------------------------------------
// Chart lookups
// ---------------------------------------------------------------------------------------------

type Chart = {
  usable(number: string | null | undefined): boolean;
  contactAccount(contactId: string | null): string | null;
  platformAccount(platform: string | null): string | null;
  bankAccount(bankAccountId: string): string | null;
  personAccountFor(counterpartyName: string | null): string | null;
};

function chartOf(accounts: readonly ProposalAccount[]): Chart {
  const active = accounts.filter((account) => !account.archived);
  const numbers = new Set(active.map((account) => account.number));
  const persons = active.filter((account) => account.ownerType === "person" && account.ownerPersonName);
  return {
    usable: (number) => Boolean(number && numbers.has(number)),
    contactAccount: (contactId) => (contactId ? (active.find((account) => account.ownerType === "contact" && account.ownerContactId === contactId)?.number ?? null) : null),
    platformAccount: (platform) => (platform ? (active.find((account) => account.ownerType === "platform" && account.ownerPlatform === platform)?.number ?? null) : null),
    bankAccount: (bankAccountId) => active.find((account) => account.ownerType === "bank_account" && account.ownerBankAccountId === bankAccountId)?.number ?? null,
    personAccountFor(counterpartyName) {
      const tokens = new Set(nameTokens(counterpartyName));
      if (tokens.size === 0) return null;
      const hits = persons.filter((account) => {
        const wanted = nameTokens(account.ownerPersonName);
        return wanted.length >= 2 && wanted.every((token) => tokens.has(token));
      });
      return hits.length === 1 ? hits[0]!.number : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

function directionFits(rule: ProposalRule, direction: "incoming" | "outgoing"): boolean {
  return rule.direction === "any" || rule.direction === direction;
}

/** The rule for a contact wins over a name pattern; the first of each in list order. A pattern
 * matches when any of `texts` contains it. */
function pickRule(rules: readonly ProposalRule[], contactId: string | null, texts: readonly (string | null)[]): ProposalRule | null {
  if (contactId) {
    const byContact = rules.find((rule) => rule.contactId === contactId);
    if (byContact) return byContact;
  }
  const lowered = texts.map(lower).filter((text) => text.length > 0);
  return rules.find((rule) => rule.contactId === null && rule.counterpartyPattern && lowered.some((text) => text.includes(rule.counterpartyPattern!))) ?? null;
}

/** A document rule: not a no-document rule, direction of the document. */
export function ruleForDocument(rules: readonly ProposalRule[], doc: ProposalDocument, direction: "incoming" | "outgoing"): ProposalRule | null {
  return pickRule(
    rules.filter((rule) => !rule.noDocument && directionFits(rule, direction)),
    doc.contactId,
    [[doc.contactName, doc.sender].filter(Boolean).join(" ")],
  );
}

/** The side of the books a bank transaction's money lands on: money in is the revenue side
 * (`outgoing`, like an outgoing invoice), money out the expense side (`incoming`). */
export function moneyDirection(amountCents: number): "incoming" | "outgoing" {
  return amountCents > 0 ? "outgoing" : "incoming";
}

/** A rule for a bank transaction without a document: only a no-document rule, and only in the
 * transaction's money direction (a rule learned from a supplier's invoices never books its
 * refund). The pattern matches the counterparty's name or the remittance text ("Stammeinlage"). */
export function ruleForTransaction(rules: readonly ProposalRule[], tx: ProposalTransaction): ProposalRule | null {
  const direction = moneyDirection(tx.amountCents);
  return pickRule(
    rules.filter((rule) => rule.noDocument && directionFits(rule, direction)),
    tx.resolvedContactId,
    [tx.counterpartyName, tx.remittanceText],
  );
}

// ---------------------------------------------------------------------------------------------
// Tax decisions
// ---------------------------------------------------------------------------------------------

type Target = { accountNumber: string; taxCode: TaxCode | null; split: BookingAdvice["split"]; fromRule: boolean; taxUnverified?: boolean };

/** The printed breakdown when every rate with an amount has its net (and, unless 0 %, its tax),
 * whatever it adds up to. */
function completeBreakdown(entries: readonly ProposalTaxBreakdownEntry[]): CompleteBreakdownEntry[] | null {
  const relevant = entries.filter((entry) => (entry.netCents ?? 0) !== 0 || (entry.taxCents ?? 0) !== 0);
  if (relevant.length === 0) return null;
  const complete: CompleteBreakdownEntry[] = [];
  for (const entry of relevant) {
    if (![0, 7, 19].includes(entry.ratePercent) || entry.netCents === null) return null;
    if (entry.taxCents === null && entry.ratePercent !== 0) return null;
    complete.push({ ratePercent: entry.ratePercent, netCents: entry.netCents, taxCents: entry.taxCents ?? 0 });
  }
  return complete;
}

function grossOf(entries: readonly CompleteBreakdownEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.netCents + entry.taxCents, 0);
}

function usableBreakdown(entries: readonly ProposalTaxBreakdownEntry[], expectedGross: number): CompleteBreakdownEntry[] | null {
  const complete = completeBreakdown(entries);
  return complete && grossOf(complete) === expectedGross ? complete : null;
}

/** The largest share of the total a gap between the printed figures and the total may have to
 * still be booked as additional pass-through (`tax_inconsistent`): a notary's second partial
 * invoice's court fees, not a misread figure. */
const MAX_PASS_THROUGH_REMAINDER_SHARE = 0.1;

/** The German VAT rate the document prints a positive tax for (the rate with the most tax), or
 * 19 for a printed positive tax total without a rate; `null` when no positive tax is printed. */
function printedVatRate(doc: ProposalDocument): 19 | 7 | null {
  const taxed = (doc.taxBreakdown ?? []).filter((entry) => (entry.taxCents ?? 0) > 0 && (entry.ratePercent === 19 || entry.ratePercent === 7));
  if (taxed.length > 0) return taxed.reduce((best, entry) => (entry.taxCents! > best.taxCents! ? entry : best)).ratePercent as 19 | 7;
  if ((doc.taxTotalCents ?? 0) > 0) return rateFromTotals(doc.netTotalCents, doc.taxTotalCents) ?? 19;
  return null;
}

function hasGermanVat(doc: ProposalDocument): boolean {
  if ((doc.taxBreakdown ?? []).some((entry) => (entry.taxCents ?? 0) !== 0 && (entry.ratePercent === 19 || entry.ratePercent === 7))) return true;
  return (doc.taxTotalCents ?? 0) !== 0;
}

/** The share of the total that is pass-through, when it is plausible (same sign, smaller). */
function passThroughOf(doc: ProposalDocument, total: number): number {
  const pass = doc.passThroughCents ?? 0;
  if (pass === 0 || Math.sign(pass) !== Math.sign(total) || Math.abs(pass) >= Math.abs(total)) return 0;
  return pass;
}

function rateFromTotals(netCents: number | null, taxCents: number | null): 19 | 7 | null {
  if (!netCents || !taxCents) return null;
  const rate = (taxCents * 100) / netCents;
  if (Math.abs(rate - 19) < 0.6) return 19;
  if (Math.abs(rate - 7) < 0.6) return 7;
  return null;
}

/**
 * The purchase side of an incoming document: one base line per printed rate with the exact
 * printed net and tax, reverse charge for a foreign supplier without German VAT, the
 * pass-through part on its own line, the rule's or the AI's tax code when nothing is printed,
 * and the input tax derived from the gross with a warning when nothing at all is known.
 *
 * Reverse charge is never booked silently on a guess: when the document prints no tax figure at
 * all and has no reverse-charge note, a foreign supplier still gets `rc13b` (the likelier case),
 * but flagged `tax_unverified`, unless a rule with a tax code decides (a human confirmed it).
 * Apple Ireland, for one, charges German VAT, which only the printed figures show.
 */
function incomingLines(doc: ProposalDocument, total: number, target: Target, warnings: Set<ProposalWarningCode>): LineInput[] {
  let pass = passThroughOf(doc, total);
  let breakdown = usableBreakdown(doc.taxBreakdown ?? [], total - pass);
  if (!breakdown) {
    // A complete breakdown a little short of the total (a notary's two partial invoices, one
    // pass-through sum extracted): the printed figures are booked, the rest is pass-through.
    const complete = completeBreakdown(doc.taxBreakdown ?? []);
    const gap = complete ? total - pass - grossOf(complete) : 0;
    if (complete && gap !== 0 && Math.sign(gap) === Math.sign(total) && Math.abs(gap) <= Math.abs(total) * MAX_PASS_THROUGH_REMAINDER_SHARE) {
      pass += gap;
      breakdown = complete;
      warnings.add("tax_inconsistent");
    }
  }
  const base = total - pass;
  const foreign = isForeignParty(doc.contactCountry, doc.contactVatId);
  const germanVat = hasGermanVat(doc);
  const vatRate = printedVatRate(doc);
  const text = counterpartyText(doc);
  // A supplier printing a positive German VAT charges that VAT, wherever it sits: a reverse-charge
  // note (an OCR false positive, a conditional footnote like Musterbank's) loses against the printed
  // figures, flagged.
  const reverseChargeConflict = doc.reverseCharge === true && vatRate !== null;
  if (reverseChargeConflict) warnings.add("reverse_charge_conflict");
  if (foreign && germanVat && (doc.reverseCharge !== true || reverseChargeConflict)) warnings.add("foreign_supplier_with_vat");
  if (germanVat && pass === 0 && containsAny(text, PASS_THROUGH_KEYWORDS)) warnings.add("possible_pass_through");

  const lines: LineInput[] = [];
  const account = target.accountNumber;
  const splitOr = (code: TaxCode, mode: "gross" | "net" = "gross"): LineInput[] =>
    target.split && target.split.length > 1
      ? target.split.map((part) => ({ accountNumber: part.accountNumber, amountCents: part.amountCents, taxCode: code === "rc13b" ? "rc13b" : (part.taxCode ?? code), amountMode: mode }))
      : [{ accountNumber: account, amountCents: base, taxCode: code, amountMode: mode }];

  const ruleDecidesTax = target.fromRule && target.taxCode !== null;
  if (doc.reverseCharge === true && !reverseChargeConflict) {
    lines.push(...splitOr("rc13b"));
  } else if (foreign && !germanVat) {
    // Nothing printed and nothing noted: a rule's tax code wins, else reverse charge, flagged below.
    lines.push(...splitOr(ruleDecidesTax && !hasPrintedTaxFigures(doc) ? target.taxCode! : "rc13b"));
  } else if (breakdown) {
    for (const entry of breakdown) {
      if (entry.ratePercent === 19 || entry.ratePercent === 7) {
        const code: TaxCode = entry.ratePercent === 19 ? "vst19" : "vst7";
        lines.push({ accountNumber: account, amountCents: entry.netCents, taxCode: code, amountMode: "net", taxCents: entry.taxCents });
      } else {
        const code: TaxCode = target.taxCode === "tax_free" ? "tax_free" : "not_taxable";
        lines.push({ accountNumber: account, amountCents: entry.netCents, taxCode: code });
      }
    }
  } else {
    if ((doc.taxBreakdown ?? []).length > 0) warnings.add("no_tax_breakdown");
    const rate = rateFromTotals(doc.netTotalCents, doc.taxTotalCents);
    if (rate && doc.netTotalCents! + doc.taxTotalCents! === base) {
      lines.push({ accountNumber: account, amountCents: doc.netTotalCents!, taxCode: rate === 19 ? "vst19" : "vst7", amountMode: "net", taxCents: doc.taxTotalCents });
    } else if (!target.fromRule && vatRate !== null && target.taxCode !== "vst19" && target.taxCode !== "vst7") {
      // The printed figures do not add up, but the document prints a positive tax: an AI answer
      // of pass_through, not_taxable or the like never replaces it.
      warnings.add("tax_inconsistent");
      lines.push({ accountNumber: account, amountCents: base, taxCode: vatRate === 19 ? "vst19" : "vst7", amountMode: "gross" });
    } else if (target.taxCode) {
      if (!target.fromRule && (target.taxCode === "vst19" || target.taxCode === "vst7")) warnings.add("no_tax_breakdown");
      lines.push(...splitOr(target.taxCode));
    } else if (containsAny(text, AUTHORITY_KEYWORDS) || doc.kind === "authority_letter") {
      lines.push(...splitOr("not_taxable"));
    } else {
      warnings.add("no_tax_breakdown");
      lines.push(...splitOr("vst19"));
    }
  }
  if (pass !== 0) lines.push({ accountNumber: account, amountCents: pass, taxCode: "pass_through" });
  if (!ruleDecidesTax && (target.taxUnverified || isUnverifiedReverseCharge(lines.map((line) => line.taxCode ?? null), doc))) warnings.add("tax_unverified");
  return lines.filter((line) => line.amountCents !== 0).map((line) => ({ ...line, documentId: null }));
}

/** The sale side of an outgoing document not issued in Digipost (credit amounts, negative). */
function outgoingLines(doc: ProposalDocument, total: number, rule: ProposalRule | null, warnings: Set<ProposalWarningCode>): LineInput[] {
  const foreign = isForeignParty(doc.contactCountry, doc.contactVatId);
  const zeroRate = (): { account: string; code: TaxCode } => {
    if (doc.reverseCharge === true || (foreign && isEuCountry(doc.contactCountry ?? doc.contactVatId?.slice(0, 2)))) return { account: REVENUE_ACCOUNTS.euNotTaxable, code: "eu_not_taxable" };
    if (foreign) return { account: REVENUE_ACCOUNTS.thirdCountry, code: "not_taxable" };
    return { account: REVENUE_ACCOUNTS.taxFree, code: "tax_free" };
  };

  const breakdown = usableBreakdown(doc.taxBreakdown ?? [], total);
  const lines: LineInput[] = [];
  if (breakdown) {
    for (const entry of breakdown) {
      if (entry.ratePercent === 19) lines.push({ accountNumber: REVENUE_ACCOUNTS.ust19, amountCents: -entry.netCents, taxCode: "ust19", amountMode: "net", taxCents: -entry.taxCents });
      else if (entry.ratePercent === 7) lines.push({ accountNumber: REVENUE_ACCOUNTS.ust7, amountCents: -entry.netCents, taxCode: "ust7", amountMode: "net", taxCents: -entry.taxCents });
      else {
        const zero = zeroRate();
        lines.push({ accountNumber: zero.account, amountCents: -entry.netCents, taxCode: zero.code });
      }
    }
  } else if (rule) {
    lines.push({ accountNumber: rule.accountNumber, amountCents: -total, taxCode: rule.taxCode, amountMode: "gross" });
  } else if (doc.reverseCharge === true || (foreign && !hasGermanVat(doc))) {
    const zero = zeroRate();
    lines.push({ accountNumber: zero.account, amountCents: -total, taxCode: zero.code });
  } else {
    const rate = rateFromTotals(doc.netTotalCents, doc.taxTotalCents);
    if (rate && doc.netTotalCents! + doc.taxTotalCents! === total) {
      lines.push({ accountNumber: rate === 19 ? REVENUE_ACCOUNTS.ust19 : REVENUE_ACCOUNTS.ust7, amountCents: -doc.netTotalCents!, taxCode: rate === 19 ? "ust19" : "ust7", amountMode: "net", taxCents: -doc.taxTotalCents! });
    } else {
      warnings.add("no_tax_breakdown");
      lines.push({ accountNumber: REVENUE_ACCOUNTS.ust19, amountCents: -total, taxCode: "ust19", amountMode: "gross" });
    }
  }
  return lines.filter((line) => line.amountCents !== 0);
}

// ---------------------------------------------------------------------------------------------
// Issued invoices
// ---------------------------------------------------------------------------------------------

/** Commercial rounding, symmetric around zero: a negated amount rounds to the negated result
 * (`Math.round(-9.5)` is -9, this gives -10). */
function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value) + Number.EPSILON);
}

export type InvoiceLineForGroups = { quantity: string | number; unitPrice: string | number; category: string; ratePercent: number };

/**
 * Net and VAT per category and rate of an issued invoice, from its stored e-invoice lines,
 * reconciled to the invoice's own stored totals (the larger group absorbs a rounding cent), so
 * the entry always books exactly what the invoice says.
 */
export function invoiceVatGroups(lines: readonly InvoiceLineForGroups[], totals: { netCents: number; vatCents: number }): ProposalInvoiceGroup[] {
  const groups = new Map<string, ProposalInvoiceGroup>();
  for (const line of lines) {
    const net = roundHalfAwayFromZero(Number(line.quantity) * Number(line.unitPrice) * 100);
    if (!Number.isFinite(net)) continue;
    const key = `${line.category}:${line.ratePercent}`;
    const group = groups.get(key) ?? { category: line.category, ratePercent: line.ratePercent, netCents: 0, vatCents: 0 };
    group.netCents += net;
    groups.set(key, group);
  }
  const list = [...groups.values()];
  for (const group of list) group.vatCents = roundHalfAwayFromZero((group.netCents * group.ratePercent) / 100);
  if (list.length === 0) return [{ category: totals.vatCents !== 0 ? "S" : "Z", ratePercent: totals.vatCents !== 0 ? 19 : 0, netCents: totals.netCents, vatCents: totals.vatCents }];
  const largest = (candidates: ProposalInvoiceGroup[]) => candidates.reduce((best, group) => (Math.abs(group.netCents) > Math.abs(best.netCents) ? group : best));
  largest(list).netCents += totals.netCents - list.reduce((sum, group) => sum + group.netCents, 0);
  const taxed = list.filter((group) => group.ratePercent > 0);
  if (taxed.length > 0) largest(taxed).vatCents += totals.vatCents - list.reduce((sum, group) => sum + group.vatCents, 0);
  return list.filter((group) => group.netCents !== 0 || group.vatCents !== 0);
}

function invoiceGroupLine(group: ProposalInvoiceGroup, buyerCountry: string | null): LineInput {
  if (group.category === "S" && group.ratePercent === 19) return { accountNumber: REVENUE_ACCOUNTS.ust19, amountCents: -group.netCents, taxCode: "ust19", amountMode: "net", taxCents: -group.vatCents };
  if (group.category === "S" && group.ratePercent === 7) return { accountNumber: REVENUE_ACCOUNTS.ust7, amountCents: -group.netCents, taxCode: "ust7", amountMode: "net", taxCents: -group.vatCents };
  if (group.category === "AE") {
    return isEuCountry(buyerCountry) && buyerCountry?.toUpperCase() !== "DE"
      ? { accountNumber: REVENUE_ACCOUNTS.euNotTaxable, amountCents: -group.netCents, taxCode: "eu_not_taxable" }
      : { accountNumber: REVENUE_ACCOUNTS.thirdCountry, amountCents: -group.netCents, taxCode: "not_taxable" };
  }
  if (group.category === "E") return { accountNumber: REVENUE_ACCOUNTS.taxFree, amountCents: -group.netCents, taxCode: "tax_free" };
  return { accountNumber: REVENUE_ACCOUNTS.thirdCountry, amountCents: -group.netCents, taxCode: "not_taxable" };
}

// ---------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------

type Context = {
  snapshot: ProposalSnapshot;
  chart: Chart;
  documents: Map<string, ProposalDocument>;
  transactions: Map<string, ProposalTransaction>;
  invoicesByDocument: Map<string, ProposalInvoice>;
  linksByTransaction: Map<string, { documentId: string; allocatedAmountCents: number }[]>;
};

function contextOf(snapshot: ProposalSnapshot): Context {
  const linksByTransaction = new Map<string, { documentId: string; allocatedAmountCents: number }[]>();
  for (const doc of snapshot.documents) {
    for (const link of doc.confirmedTransactions) {
      const list = linksByTransaction.get(link.transactionId) ?? [];
      list.push({ documentId: doc.id, allocatedAmountCents: link.allocatedAmountCents });
      linksByTransaction.set(link.transactionId, list);
    }
  }
  return {
    snapshot,
    chart: chartOf(snapshot.accounts),
    documents: new Map(snapshot.documents.map((doc) => [doc.id, doc])),
    transactions: new Map(snapshot.transactions.map((tx) => [tx.id, tx])),
    invoicesByDocument: new Map(snapshot.invoices.filter((invoice) => invoice.documentId).map((invoice) => [invoice.documentId!, invoice])),
    linksByTransaction,
  };
}

function isIncomingDocument(doc: ProposalDocument): boolean {
  return INCOMING_KINDS.has(doc.kind) && doc.direction !== "outgoing";
}

function isOutgoingDocument(doc: ProposalDocument, ctx: Context): boolean {
  return doc.kind === "outgoing_invoice" && !ctx.invoicesByDocument.has(doc.id);
}

/** Incoming documents the engine would book: done, with an amount, in scope, not decided. */
function bookableIncoming(ctx: Context): ProposalDocument[] {
  return ctx.snapshot.documents.filter(
    (doc) =>
      doc.status === "done" &&
      isIncomingDocument(doc) &&
      doc.totalAmountCents !== null &&
      doc.totalAmountCents !== 0 &&
      inScope(ctx.snapshot, documentDateOf(doc)) &&
      !ctx.snapshot.decidedSourceKeys.has(documentSourceKey(doc.id)),
  );
}

export const documentSourceKey = (documentId: string) => `doc:${documentId}`;
export const transactionSourceKey = (transactionId: string) => `tx:${transactionId}`;
export const invoiceSourceKey = (invoiceId: string) => `invoice:${invoiceId}`;
export const settlementSourceKey = (documentId: string, month: string) => `settlement:${documentId}:${month}`;

/** The open-item account the payment of a document meets its invoice on. */
function openItemAccountForDocument(ctx: Context, doc: ProposalDocument): string | null {
  const { chart } = ctx;
  const invoice = ctx.invoicesByDocument.get(doc.id);
  if (invoice) return chart.contactAccount(invoice.contactId) ?? RECEIVABLES_ACCOUNT;
  if (SETTLEMENT_KINDS.has(doc.kind)) return chart.platformAccount(doc.platform);
  if (doc.kind === "outgoing_invoice" || doc.direction === "outgoing") {
    const rule = ruleForDocument(ctx.snapshot.rules, doc, "outgoing");
    if (rule?.paymentAccountNumber && chart.usable(rule.paymentAccountNumber)) return rule.paymentAccountNumber;
    return chart.contactAccount(doc.contactId) ?? RECEIVABLES_ACCOUNT;
  }
  const rule = ruleForDocument(ctx.snapshot.rules, doc, "incoming");
  if (rule?.paymentAccountNumber && chart.usable(rule.paymentAccountNumber)) return rule.paymentAccountNumber;
  const contact = chart.contactAccount(doc.contactId);
  if (contact) return contact;
  // Paid by a shareholder: every confirmed payment goes to the same person's account.
  const persons = doc.confirmedTransactions.map((link) => chart.personAccountFor(ctx.transactions.get(link.transactionId)?.counterpartyName ?? null));
  if (persons.length > 0 && persons.every((person) => person !== null && person === persons[0])) return persons[0]!;
  return PAYABLES_ACCOUNT;
}

function duplicateSuspects(docs: readonly ProposalDocument[]): Set<string> {
  const seen = new Map<string, string>();
  const suspects = new Set<string>();
  const ordered = [...docs].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id));
  for (const doc of ordered) {
    if (!doc.invoiceNumber || doc.totalAmountCents === null) continue;
    const party = doc.contactId ?? lower(doc.sender).trim();
    const key = `${party}|${doc.invoiceNumber.trim().toLowerCase()}|${doc.totalAmountCents}`;
    if (seen.has(key)) suspects.add(doc.id);
    else seen.set(key, doc.id);
  }
  return suspects;
}

/** The questions to ask the AI: incoming documents no rule covers. */
export function adviceQuestionsFor(snapshot: ProposalSnapshot): BookingAdviceQuestion[] {
  const ctx = contextOf(snapshot);
  const accounts = snapshot.accounts
    .filter((account) => !account.archived && account.kind === "expense" && account.group === "costs")
    .map((account) => ({ number: account.number, name: account.name }));
  return bookableIncoming(ctx)
    .filter((doc) => {
      const rule = ruleForDocument(snapshot.rules, doc, "incoming");
      return !(rule && ctx.chart.usable(rule.accountNumber));
    })
    .map((doc) => ({
      documentId: doc.id,
      direction: "incoming" as const,
      senderName: doc.contactName ?? doc.sender,
      country: doc.contactCountry,
      vatId: doc.contactVatId,
      title: doc.title,
      summary: doc.summary,
      invoiceNumber: doc.invoiceNumber,
      documentDate: doc.documentDate,
      totalAmountCents: doc.totalAmountCents!,
      currency: doc.currency,
      netTotalCents: doc.netTotalCents,
      taxTotalCents: doc.taxTotalCents,
      passThroughCents: doc.passThroughCents,
      reverseCharge: doc.reverseCharge,
      taxBreakdown: doc.taxBreakdown,
      accounts,
    }));
}

function draft(input: Omit<ProposalDraft, "warnings"> & { warnings: Iterable<ProposalWarningCode> }): ProposalDraft {
  return { ...input, warnings: [...new Set(input.warnings)].sort() };
}

function allAccountsUsable(ctx: Context, lines: readonly LineInput[]): boolean {
  return lines.length >= 2 && lines.every((line) => ctx.chart.usable(line.accountNumber));
}

function proposeIncoming(ctx: Context, advice: AdviceMap, plan: ProposalPlan, duplicates: Set<string>): void {
  for (const doc of bookableIncoming(ctx)) {
    const key = documentSourceKey(doc.id);
    const total = doc.totalAmountCents!;
    const warnings = new Set<ProposalWarningCode>();
    if (duplicates.has(doc.id)) warnings.add("duplicate_suspect");
    const allocated = doc.confirmedTransactions.reduce((sum, link) => sum + link.allocatedAmountCents, 0);
    if (doc.confirmedTransactions.length > 0 && allocated !== Math.abs(total)) warnings.add("amount_differs_from_payment");

    const rule = ruleForDocument(ctx.snapshot.rules, doc, "incoming");
    let target: Target;
    let origin: ProposalDraft["origin"];
    let originReason: string;
    if (rule && ctx.chart.usable(rule.accountNumber)) {
      target = { accountNumber: rule.accountNumber, taxCode: rule.taxCode, split: null, fromRule: true };
      origin = "rule";
      originReason = `rule:${rule.id}`;
    } else {
      const answer = advice.get(doc.id);
      if (answer === undefined) {
        plan.deferred.push(key);
        continue;
      }
      if (answer && ctx.chart.usable(answer.accountNumber)) {
        target = { accountNumber: answer.accountNumber, taxCode: answer.taxCode, split: answer.split, fromRule: false, taxUnverified: answer.taxUnverified === true };
        origin = "ai";
        originReason = answer.reason;
      } else {
        warnings.add("ai_unavailable");
        target = { accountNumber: DEFAULT_EXPENSE_ACCOUNT, taxCode: null, split: null, fromRule: false };
        origin = "template";
        originReason = "template:incoming_invoice";
      }
    }

    const counter = openItemAccountForDocument(ctx, doc);
    const lines = [...incomingLines(doc, total, target, warnings), { accountNumber: counter ?? PAYABLES_ACCOUNT, amountCents: -total, documentId: doc.id }];
    if (!allAccountsUsable(ctx, lines)) {
      plan.unproposed.push(key);
      continue;
    }
    plan.drafts.push(
      draft({
        sourceKey: key,
        template: "incoming_invoice",
        origin,
        originReason,
        warnings,
        entry: {
          bookingDate: documentDateOf(doc),
          documentDate: doc.documentDate,
          serviceDate: doc.serviceDate ?? doc.servicePeriodTo,
          text: clip(`${documentLabel(doc)}${doc.invoiceNumber ? ` ${doc.invoiceNumber}` : ""}`),
          lines,
          documentId: doc.id,
        },
      }),
    );
  }
}

function proposeOutgoingDocuments(ctx: Context, plan: ProposalPlan, duplicates: Set<string>): void {
  for (const doc of ctx.snapshot.documents) {
    if (doc.status !== "done" || !isOutgoingDocument(doc, ctx) || doc.totalAmountCents === null || doc.totalAmountCents === 0) continue;
    const key = documentSourceKey(doc.id);
    if (!inScope(ctx.snapshot, documentDateOf(doc)) || ctx.snapshot.decidedSourceKeys.has(key)) continue;
    const total = doc.totalAmountCents;
    const warnings = new Set<ProposalWarningCode>();
    if (duplicates.has(doc.id)) warnings.add("duplicate_suspect");
    const rule = ruleForDocument(ctx.snapshot.rules, doc, "outgoing");
    const usableRule = rule && ctx.chart.usable(rule.accountNumber) ? rule : null;
    const counter = openItemAccountForDocument(ctx, doc) ?? RECEIVABLES_ACCOUNT;
    const lines = [{ accountNumber: counter, amountCents: total, documentId: doc.id }, ...outgoingLines(doc, total, usableRule, warnings)];
    if (!allAccountsUsable(ctx, lines)) {
      plan.unproposed.push(key);
      continue;
    }
    plan.drafts.push(
      draft({
        sourceKey: key,
        template: "outgoing_document",
        origin: usableRule ? "rule" : "template",
        originReason: usableRule ? `rule:${usableRule.id}` : "template:outgoing_document",
        warnings,
        entry: {
          bookingDate: documentDateOf(doc),
          documentDate: doc.documentDate,
          serviceDate: doc.serviceDate ?? doc.servicePeriodTo,
          text: clip(`Ausgangsrechnung ${doc.invoiceNumber ?? ""} ${documentLabel(doc)}`),
          lines,
          documentId: doc.id,
        },
      }),
    );
  }
}

function proposeInvoices(ctx: Context, plan: ProposalPlan): void {
  const byId = new Map(ctx.snapshot.invoices.map((invoice) => [invoice.id, invoice]));
  for (const invoice of ctx.snapshot.invoices) {
    const key = invoiceSourceKey(invoice.id);
    if (!inScope(ctx.snapshot, invoice.issueDate) || ctx.snapshot.decidedSourceKeys.has(key)) continue;
    // A full cancellation books exactly the cancelled invoice's groups, negated: every revenue and
    // tax account nets to zero, whatever rounding the cancellation's own totals went through.
    const original = invoice.type === "cancellation" && invoice.cancelsInvoiceId ? byId.get(invoice.cancelsInvoiceId) : undefined;
    const groups = original ? original.groups.map((group) => ({ ...group, netCents: -group.netCents, vatCents: -group.vatCents })) : invoice.groups;
    const revenue = groups.map((group) => invoiceGroupLine(group, invoice.buyerCountry)).filter((line) => line.amountCents !== 0);
    const gross = groups.reduce((sum, group) => sum + group.netCents + group.vatCents, 0);
    if (gross === 0 || revenue.length === 0) {
      plan.unproposed.push(key);
      continue;
    }
    const counter = ctx.chart.contactAccount(invoice.contactId) ?? RECEIVABLES_ACCOUNT;
    const lines = [{ accountNumber: counter, amountCents: gross, documentId: invoice.documentId }, ...revenue];
    if (!allAccountsUsable(ctx, lines)) {
      plan.unproposed.push(key);
      continue;
    }
    plan.drafts.push(
      draft({
        sourceKey: key,
        template: "outgoing_invoice",
        origin: "template",
        originReason: "template:outgoing_invoice",
        warnings: [],
        entry: {
          bookingDate: invoice.issueDate,
          documentDate: invoice.issueDate,
          serviceDate: invoice.serviceDate,
          text: clip(`${invoice.type === "cancellation" ? "Stornorechnung" : "Ausgangsrechnung"} ${invoice.number} ${invoice.buyerName}`),
          lines,
          documentId: invoice.documentId,
        },
      }),
    );
  }
}

/**
 * What a fee line costs (positive) or gives back (negative, a refunded fee). The same rule as
 * `src/modules/accounts`' `settlementFeeEffectCents`, which writes these lines: a fee next to its
 * sale (gross on the same row) is a positive magnitude and always a cost; a row that is nothing
 * but a fee (no gross, its net is the fee: Google's commission and each refunded commission)
 * carries its own sign, negative for the commission, positive for its refund.
 */
function feeExpenseCents(line: ProposalSettlementLine): number {
  const fee = line.feeCents ?? 0;
  if (line.grossCents === null && line.netCents !== null && Math.abs(line.netCents) === Math.abs(fee)) return -line.netCents;
  return Math.abs(fee);
}

/** The fee account and tax code of a platform: a rule naming the platform, else 6855. */
function feeTargetFor(ctx: Context, platform: string | null, label: string): { accountNumber: string; taxCode: TaxCode | null; rule: ProposalRule | null } {
  const name = `${platform ?? ""} ${label}`.toLowerCase();
  const rule = ctx.snapshot.rules.find((candidate) => !candidate.noDocument && candidate.contactId === null && candidate.counterpartyPattern && name.includes(candidate.counterpartyPattern) && directionFits(candidate, "incoming"));
  if (rule && ctx.chart.usable(rule.accountNumber)) return { accountNumber: rule.accountNumber, taxCode: rule.taxCode, rule };
  return { accountNumber: DEFAULT_FEE_ACCOUNT, taxCode: (platform ? PLATFORM_FEE_TAX_CODES[platform] : undefined) ?? null, rule: null };
}

function proposeSettlements(ctx: Context, plan: ProposalPlan, platformLabel: (platform: string) => string): void {
  const groups = new Map<string, { doc: ProposalDocument | undefined; documentId: string; month: string; platform: string | null; lines: ProposalSettlementLine[] }>();
  for (const line of ctx.snapshot.settlementLines) {
    if (line.type === "payout") continue;
    const doc = ctx.documents.get(line.documentId);
    const date = line.bookingDate ?? doc?.servicePeriodTo ?? (doc ? documentDateOf(doc) : null);
    if (!date) continue;
    const month = date.slice(0, 7);
    const key = settlementSourceKey(line.documentId, month);
    const group = groups.get(key) ?? { doc, documentId: line.documentId, month, platform: line.platform ?? doc?.platform ?? null, lines: [] };
    group.lines.push(line);
    groups.set(key, group);
  }

  for (const [key, group] of groups) {
    const end = monthEnd(group.month);
    const periodEnd = group.doc?.servicePeriodTo;
    const bookingDate = periodEnd && periodEnd.slice(0, 7) === group.month && periodEnd < end ? periodEnd : end;
    if (!inScope(ctx.snapshot, bookingDate) || ctx.snapshot.decidedSourceKeys.has(key)) continue;
    if (!group.platform || !COMMISSIONAIRE_PLATFORMS.has(group.platform)) {
      plan.unproposed.push(key);
      plan.problems.push({ sourceKey: key, code: "unsupported_platform_settlement" });
      continue;
    }
    const receivable = ctx.chart.platformAccount(group.platform);
    if (!receivable) {
      plan.unproposed.push(key);
      continue;
    }
    const label = group.platform ? platformLabel(group.platform) : "Plattform";
    const revenueCents = group.lines
      .filter((line) => line.type === "revenue" || line.type === "refund" || line.type === "adjustment")
      .reduce((sum, line) => sum + (line.grossCents ?? line.netCents ?? 0), 0);
    const feeCents = group.lines.filter((line) => line.type === "fee").reduce((sum, line) => sum + feeExpenseCents(line), 0);
    const fee = feeTargetFor(ctx, group.platform, label);
    const lines: LineInput[] = [];
    if (revenueCents !== 0) lines.push({ accountNumber: REVENUE_ACCOUNTS.euNotTaxable, amountCents: -revenueCents, taxCode: "eu_not_taxable", documentId: null });
    if (feeCents !== 0) lines.push({ accountNumber: fee.accountNumber, amountCents: feeCents, taxCode: fee.taxCode, documentId: null });
    const receivableCents = revenueCents - feeCents;
    if (receivableCents !== 0) lines.push({ accountNumber: receivable, amountCents: receivableCents, documentId: group.documentId });
    if (!allAccountsUsable(ctx, lines)) {
      plan.unproposed.push(key);
      continue;
    }
    plan.drafts.push(
      draft({
        sourceKey: key,
        template: "settlement_report",
        origin: fee.rule ? "rule" : "template",
        originReason: fee.rule ? `rule:${fee.rule.id}` : "template:settlement_report",
        warnings: [],
        entry: {
          bookingDate,
          documentDate: group.doc?.documentDate ?? null,
          serviceDate: periodEnd ?? null,
          text: clip(`Abrechnung ${label} ${group.month}`),
          lines,
          documentId: group.documentId,
        },
      }),
    );
  }
}

type BankCounter = { lines: LineInput[]; template: ProposalTemplate; rule: ProposalRule | null; warnings: ProposalWarningCode[] };

/** The other side of a bank transaction, from certain to uncertain; `null` for none. */
function bankCounter(ctx: Context, tx: ProposalTransaction): BankCounter | null {
  const { chart } = ctx;
  const sign = tx.amountCents < 0 ? 1 : -1;

  // 1. A confirmed match to one or more documents: their open-item accounts, allocated amounts.
  // A document whose template has no open-item account (a settlement report of a platform
  // without a receivable) cannot carry the payment: the rules below decide instead.
  const links = (ctx.linksByTransaction.get(tx.id) ?? []).filter((link) => ctx.documents.has(link.documentId));
  const linkAccounts = links.map((link) => openItemAccountForDocument(ctx, ctx.documents.get(link.documentId)!));
  if (links.length > 0 && linkAccounts.every((account) => account !== null)) {
    const lines: LineInput[] = links.map((link, index) => ({ accountNumber: linkAccounts[index]!, amountCents: sign * Math.abs(link.allocatedAmountCents), documentId: link.documentId }));
    const remainder = -tx.amountCents - lines.reduce((sum, line) => sum + line.amountCents, 0);
    const warnings: ProposalWarningCode[] = [];
    if (remainder !== 0) {
      lines[lines.length - 1]!.amountCents += remainder;
      warnings.push("amount_differs_from_payment");
    }
    const single = links.length === 1 ? ctx.documents.get(links[0]!.documentId) : undefined;
    if (single?.totalAmountCents && Math.abs(single.totalAmountCents) !== Math.abs(tx.amountCents) && remainder === 0) warnings.push("amount_differs_from_payment");
    return { lines: lines.filter((line) => line.amountCents !== 0), template: "bank_document_payment", rule: null, warnings };
  }

  // 2. Tied to a clearing account (an app-store payout, a supplier charge).
  if (tx.pairedClearing) {
    const account = tx.pairedClearing.platform ? chart.platformAccount(tx.pairedClearing.platform) : chart.contactAccount(tx.pairedClearing.contactId);
    if (account) {
      const documentId = tx.pairedClearing.reportDocumentIds.length === 1 ? tx.pairedClearing.reportDocumentIds[0]! : null;
      return { lines: [{ accountNumber: account, amountCents: -tx.amountCents, documentId }], template: "bank_clearing_pair", rule: null, warnings: [] };
    }
  }

  // 3. A rule for a transaction without a document (share capital to 2900, bank fees).
  const rule = ruleForTransaction(ctx.snapshot.rules, tx);
  if (rule && chart.usable(rule.accountNumber)) {
    return { lines: [{ accountNumber: rule.accountNumber, amountCents: -tx.amountCents, taxCode: rule.taxCode, amountMode: "gross" }], template: "bank_no_document_rule", rule, warnings: [] };
  }

  // 4. A contact with an open-item account of its own (Meta prepaid credit, Google Ads).
  const contactAccount = chart.contactAccount(tx.resolvedContactId);
  if (contactAccount) return { lines: [{ accountNumber: contactAccount, amountCents: -tx.amountCents }], template: "bank_contact_account", rule: null, warnings: [] };

  // 5. A shareholder with an account for expenses paid privately.
  const person = chart.personAccountFor(tx.counterpartyName);
  if (person) return { lines: [{ accountNumber: person, amountCents: -tx.amountCents }], template: "bank_person_account", rule: null, warnings: [] };

  // 6. A transfer to or from another own bank account.
  const iban = normalizeIban(tx.counterpartyIban);
  if (iban && ctx.snapshot.ownBankAccounts.some((account) => account.id !== tx.bankAccountId && normalizeIban(account.iban) === iban) && chart.usable(MONEY_IN_TRANSIT_ACCOUNT)) {
    return { lines: [{ accountNumber: MONEY_IN_TRANSIT_ACCOUNT, amountCents: -tx.amountCents }], template: "bank_own_transfer", rule: null, warnings: [] };
  }
  return null;
}

function proposeTransactions(ctx: Context, plan: ProposalPlan): void {
  for (const tx of ctx.snapshot.transactions) {
    const key = transactionSourceKey(tx.id);
    if (tx.amountCents === 0 || !inScope(ctx.snapshot, tx.bookingDate) || ctx.snapshot.decidedSourceKeys.has(key)) continue;
    const bank = ctx.chart.bankAccount(tx.bankAccountId);
    const counter = bank ? bankCounter(ctx, tx) : null;
    if (!bank || !counter) {
      plan.unproposed.push(key);
      continue;
    }
    const lines: LineInput[] = [{ accountNumber: bank, amountCents: tx.amountCents, documentId: null }, ...counter.lines];
    if (!allAccountsUsable(ctx, lines)) {
      plan.unproposed.push(key);
      continue;
    }
    const linked = ctx.linksByTransaction.get(tx.id) ?? [];
    plan.drafts.push(
      draft({
        sourceKey: key,
        template: counter.template,
        origin: counter.rule ? "rule" : "template",
        originReason: counter.rule ? `rule:${counter.rule.id}` : `template:${counter.template}`,
        warnings: counter.warnings,
        entry: {
          bookingDate: tx.bookingDate,
          text: clip([tx.counterpartyName, tx.remittanceText].filter(Boolean).join(": ") || "Bankumsatz"),
          lines,
          transactionId: tx.id,
          documentId: linked.length === 1 ? linked[0]!.documentId : null,
        },
      }),
    );
  }
}

/**
 * Every proposal the snapshot supports. `advice` holds the AI's validated answer per document id
 * for the questions `adviceQuestionsFor` listed (`null` when it could not answer); a document
 * whose answer is missing is deferred. `platformLabel` names a platform in entry texts.
 */
export function buildProposals(snapshot: ProposalSnapshot, advice: AdviceMap, platformLabel: (platform: string) => string = (platform) => platform): ProposalPlan {
  const ctx = contextOf(snapshot);
  const plan: ProposalPlan = { drafts: [], unproposed: [], problems: [], deferred: [] };
  const duplicates = duplicateSuspects(snapshot.documents);
  proposeIncoming(ctx, advice, plan, duplicates);
  proposeOutgoingDocuments(ctx, plan, duplicates);
  proposeInvoices(ctx, plan);
  proposeSettlements(ctx, plan, platformLabel);
  proposeTransactions(ctx, plan);
  return plan;
}

export { SETTLEMENT_KINDS as LEDGER_SETTLEMENT_DOCUMENT_KINDS };
