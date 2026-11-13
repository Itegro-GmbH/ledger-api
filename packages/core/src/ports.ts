// The ledger's one outward port (decisions/0080-ledger-double-entry-bookkeeping.md, phase 3):
// the AI that suggests an account and a tax code for a document no booking rule covers.
// Implemented by a deterministic fake (`core/booking-advisor.ts`, tests and development without
// a key) and by the Mistral adapter (`src/platform/mistral/server/mistral-ledger-booking-advisor.ts`).
// The composition root binds one of them, exactly like the payment arbiter.
//
// "Mistral and personal data" (AGENTS.md): a question carries only the document's extracted
// fields (sender, country, VAT id, title, summary, amounts, the printed tax breakdown, the
// invoice number) and the workspace's own chart, never the OCR text.
import type { TaxCode } from "./types";

/** An account the advisor may answer with: the workspace's active expense or revenue accounts. */
export type AdviceAccount = { number: string; name: string };

export type AdviceTaxBreakdownEntry = { ratePercent: number; netCents: number | null; taxCents: number | null };

/** Everything the advisor is told about one document. Every field is part of the cache key. */
export type BookingAdviceQuestion = {
  documentId: string;
  /** `incoming`: a purchase (expense), `outgoing`: a sale (revenue). */
  direction: "incoming" | "outgoing";
  senderName: string | null;
  country: string | null;
  vatId: string | null;
  title: string | null;
  summary: string | null;
  invoiceNumber: string | null;
  documentDate: string | null;
  /** Gross, positive for an invoice, negative for a credit note. */
  totalAmountCents: number;
  currency: string | null;
  netTotalCents: number | null;
  taxTotalCents: number | null;
  passThroughCents: number | null;
  reverseCharge: boolean | null;
  taxBreakdown: AdviceTaxBreakdownEntry[] | null;
  accounts: AdviceAccount[];
};

/** One part of a split answer (a court letter: court fee and dunning fee). */
export type BookingAdviceRawLine = { accountNumber: string; taxCode: string | null; amountCents: number };

/** The advisor's own answer, as an adapter returns it: not validated yet. */
export type BookingAdviceRaw = {
  accountNumber: string | null;
  taxCode: string | null;
  /** One German sentence. */
  reason: string;
  /** Optional split of the gross amount over several accounts. */
  lines?: BookingAdviceRawLine[] | null;
};

/** A validated answer (`validateBookingAdvice`): every account is in the question's chart, every
 * tax code fits the direction, a split adds up to the document's gross amount. */
export type BookingAdvice = {
  accountNumber: string;
  taxCode: TaxCode | null;
  reason: string;
  split: { accountNumber: string; taxCode: TaxCode | null; amountCents: number }[] | null;
  /** Set (`true`) when the answer names `rc13b` although the question has no printed tax figure
   * and no reverse-charge note: kept, but the proposal is flagged `tax_unverified`. */
  taxUnverified?: true;
};

export interface LedgerBookingAdvisor {
  /** Provider, model and prompt fingerprint: part of the cache key, so a model or prompt change
   * asks every question again instead of reusing an answer the new setup never gave. */
  readonly version: string;
  advise(question: BookingAdviceQuestion): Promise<BookingAdviceRaw>;
}
